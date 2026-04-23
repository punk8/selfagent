import { existsSync, readFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { createTelegramAuthorizationRequest, formatAuthorizationInstruction } from "./access.js";
import { loadConfig, type AppConfig } from "./config.js";
import { createCronJob, loadCronJobs, saveCronJobs, updateCronJob } from "./cron.js";
import { createLogger } from "./logger.js";
import { detectInstallMode, getSelfAgentVersion } from "./package-meta.js";
import { choose, confirm, ensureInteractiveTerminal, promptSecret, promptWithDefault } from "./prompts.js";
import {
  saveChannelProfilesFile,
  saveModelProfilesFile,
  saveRootConfigFile,
  type ApiKeyModelProfile,
  type ChannelProfile,
  type ModelProfile
} from "./state.js";
import { startTelegramRuntime } from "./runtime.js";

const logger = createLogger("commands");

interface PiModelsFile {
  providers?: Record<string, unknown>;
}

interface DaemonPidRecord {
  pid: number;
  startedAt?: string;
  logFile?: string;
  workspaceRoot?: string;
}

interface AddChannelCommandOptions {
  defaultProfileId?: string;
  preferOverwriteDefault?: boolean;
}

interface AddModelCommandOptions {
  defaultProfileId?: string;
  preferOverwriteDefault?: boolean;
}

function serializeConsoleErrorArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractOpenAiOauthErrorMessage(diagnostics: string[]): string | undefined {
  for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
    const line = diagnostics[index];
    if (!line?.includes("[openai-codex] code->token failed:")) {
      continue;
    }

    const match = line.match(/code->token failed:\s*(\d+)\s+(.+)$/);
    const status = match?.[1];
    const payload = match?.[2];
    if (!payload) {
      return status ? `OpenAI auth token exchange failed (HTTP ${status}).` : undefined;
    }

    try {
      const parsed = JSON.parse(payload) as {
        error?: { code?: string; message?: string; type?: string };
      };
      const providerMessage = parsed.error?.message?.trim();
      const providerCode = parsed.error?.code?.trim();
      if (providerMessage && providerCode && status) {
        return `OpenAI auth token exchange failed (HTTP ${status}, ${providerCode}): ${providerMessage}`;
      }
      if (providerMessage && status) {
        return `OpenAI auth token exchange failed (HTTP ${status}): ${providerMessage}`;
      }
      if (providerMessage) {
        return `OpenAI auth token exchange failed: ${providerMessage}`;
      }
      if (status) {
        return `OpenAI auth token exchange failed (HTTP ${status}).`;
      }
    } catch {
      if (status) {
        return `OpenAI auth token exchange failed (HTTP ${status}): ${payload}`;
      }
      return `OpenAI auth token exchange failed: ${payload}`;
    }
  }

  return undefined;
}

function normalizeMiniMaxBaseUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed || trimmed === "https://api.minimax.io/anthropic") {
    return "https://api.minimaxi.com/anthropic";
  }
  return trimmed;
}

function sanitizeProfileId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";
}

function readPiModelsFile(filePath: string): PiModelsFile {
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as PiModelsFile;
  } catch {
    return {};
  }
}

async function writePiModelsFile(filePath: string, value: PiModelsFile): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function saveUpdatedRootConfig(
  config: AppConfig,
  patch: Partial<AppConfig["rootConfig"]>
): Promise<void> {
  await saveRootConfigFile(config.configFile, {
    ...config.rootConfig,
    ...patch
  });
}

function formatTimestamp(value: string | undefined): string {
  return value?.trim() || "(unknown)";
}

function formatDefaultMarker(isDefault: boolean): string {
  return isDefault ? " [default]" : "";
}

function printSection(title: string, lines: string[]): void {
  process.stdout.write([title, ...lines].join("\n") + "\n");
}

async function clearProjectedMiniMaxProvider(config: AppConfig): Promise<void> {
  const next = readPiModelsFile(config.modelsFile);
  if (!next.providers?.["minimax-cn"]) {
    return;
  }
  delete next.providers["minimax-cn"];
  if (Object.keys(next.providers).length === 0) {
    delete next.providers;
  }
  await writePiModelsFile(config.modelsFile, next);
}

async function writeDaemonPidFile(config: AppConfig, pid: number, logFile: string): Promise<void> {
  const pidFile = `${config.stateRoot}/run/selfagent.pid`;
  await mkdir(dirname(pidFile), { recursive: true });
  await writeFile(
    pidFile,
    `${JSON.stringify(
      {
        pid,
        startedAt: new Date().toISOString(),
        logFile,
        workspaceRoot: config.workspaceRoot
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function getDaemonPidFile(config: AppConfig): string {
  return `${config.stateRoot}/run/selfagent.pid`;
}

function readDaemonPidFile(config: AppConfig): DaemonPidRecord | undefined {
  const pidFile = getDaemonPidFile(config);
  if (!existsSync(pidFile)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(pidFile, "utf8")) as DaemonPidRecord;
    if (!Number.isFinite(parsed.pid) || parsed.pid <= 0) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

async function removeDaemonPidFile(config: AppConfig): Promise<void> {
  const pidFile = getDaemonPidFile(config);
  if (!existsSync(pidFile)) {
    return;
  }
  await unlink(pidFile);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureUniqueProfileId(existing: string[], candidate: string): string {
  let next = sanitizeProfileId(candidate);
  if (!existing.includes(next)) {
    return next;
  }
  let counter = 2;
  while (existing.includes(`${next}-${counter}`)) {
    counter += 1;
  }
  return `${next}-${counter}`;
}

async function resolveProfileId(params: {
  existingIds: string[];
  requestedId: string;
  preferOverwriteId?: string;
  overwritePromptLabel: string;
}): Promise<{ profileId: string; overwriting: boolean }> {
  const requested = sanitizeProfileId(params.requestedId);

  if (params.preferOverwriteId && requested === sanitizeProfileId(params.preferOverwriteId)) {
    if (params.existingIds.includes(requested)) {
      const overwrite = await confirm(params.overwritePromptLabel, true);
      if (overwrite) {
        return { profileId: requested, overwriting: true };
      }
    } else {
      return { profileId: requested, overwriting: false };
    }
  }

  if (!params.existingIds.includes(requested)) {
    return { profileId: requested, overwriting: false };
  }

  const overwrite = await confirm(`Profile "${requested}" already exists. Overwrite it?`, false);
  if (overwrite) {
    return { profileId: requested, overwriting: true };
  }
  return {
    profileId: ensureUniqueProfileId(params.existingIds, requested),
    overwriting: false
  };
}

async function interactiveOpenAiOauthLogin(config: AppConfig): Promise<void> {
  const authStorage = AuthStorage.create(config.authFile);
  const diagnostics: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    diagnostics.push(args.map(serializeConsoleErrorArg).join(" "));
    originalConsoleError(...args);
  };

  try {
    await authStorage.login("openai-codex", {
      onAuth: (info) => {
        logger.info("OAuth browser step required", { providerId: "openai-codex", url: info.url });
        process.stdout.write(`\nOpen this URL in your browser:\n${info.url}\n`);
        if (info.instructions) {
          process.stdout.write(`${info.instructions}\n`);
        }
        process.stdout.write("\n");
      },
      onPrompt: async (oauthPrompt) => {
        const label = oauthPrompt.placeholder
          ? `${oauthPrompt.message} (${oauthPrompt.placeholder})`
          : oauthPrompt.message;
        return promptWithDefault(label, "");
      },
      onManualCodeInput: async () => {
        return promptWithDefault(
          "If needed, paste the final redirect URL or authorization code here, otherwise press Enter to wait",
          ""
        );
      },
      onProgress: (message) => {
        logger.info("OAuth progress", { providerId: "openai-codex", message });
        process.stdout.write(`${message}\n`);
      }
    });
  } catch (error) {
    const providerMessage = extractOpenAiOauthErrorMessage(diagnostics);
    if (providerMessage) {
      throw new Error(providerMessage, { cause: error });
    }
    throw error;
  } finally {
    console.error = originalConsoleError;
  }
}

function buildMiniMaxProfile(modelId: string, apiKey: string): ApiKeyModelProfile {
  return {
    authMode: "apiKey",
    provider: "minimax-cn",
    modelId,
    apiKey,
    createdAt: new Date().toISOString(),
    baseUrl: normalizeMiniMaxBaseUrl(undefined),
    api: "anthropic-messages",
    authHeader: false,
    contextWindow: 204800,
    maxTokens: 65536,
    reasoning: true
  };
}

async function projectSelectedModelProfile(config: AppConfig): Promise<void> {
  const profile = config.selectedModelProfile;
  if (!profile) {
    return;
  }

  logger.info("Projecting selected model profile", {
    profileId: config.defaultModelProfileId,
    provider: profile.provider,
    authMode: profile.authMode,
    modelId: profile.modelId
  });

  if (profile.authMode === "apiKey" && (profile.provider === "openai" || profile.provider === "anthropic")) {
    const authStorage = AuthStorage.create(config.authFile);
    authStorage.set(profile.provider, { type: "api_key", key: profile.apiKey });
  }

  if (profile.authMode === "apiKey" && profile.provider === "minimax-cn") {
    const normalizedBaseUrl = normalizeMiniMaxBaseUrl(profile.baseUrl);
    const next = readPiModelsFile(config.modelsFile);
    next.providers ??= {};
    next.providers["minimax-cn"] = {
      baseUrl: normalizedBaseUrl,
      api: profile.api ?? "anthropic-messages",
      apiKey: profile.apiKey,
      authHeader: profile.authHeader ?? false,
      models: [
        {
          id: profile.modelId,
          name: profile.modelId,
          reasoning: profile.reasoning ?? true,
          input: ["text"],
          contextWindow: profile.contextWindow ?? 204800,
          maxTokens: profile.maxTokens ?? 65536,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }
      ]
    };
    await writePiModelsFile(config.modelsFile, next);
  }
}

function hasConfiguredChannel(config: AppConfig): boolean {
  return Boolean(config.channel && (config.channel !== "telegram" || config.telegramBotToken));
}

function hasConfiguredModel(config: AppConfig): boolean {
  return Boolean(config.modelProvider && config.modelId);
}

export async function addChannelCommand(options: AddChannelCommandOptions = {}): Promise<void> {
  ensureInteractiveTerminal();
  const config = loadConfig();
  process.stdout.write("\nAdd a channel profile.\n");
  const selection = await choose("Channel provider", ["Telegram"]);
  if (selection !== 0) {
    throw new Error("Unsupported channel provider");
  }

  const requestedId = await promptWithDefault("Profile name", options.defaultProfileId ?? "telegram-default");
  const { profileId, overwriting } = await resolveProfileId({
    existingIds: Object.keys(config.channelProfiles),
    requestedId,
    preferOverwriteId: options.preferOverwriteDefault ? options.defaultProfileId : undefined,
    overwritePromptLabel: `Default channel profile "${sanitizeProfileId(options.defaultProfileId ?? requestedId)}" already exists. Overwrite it?`
  });
  const telegramBotToken = await promptSecret("Telegram bot token: ");
  if (!telegramBotToken) {
    throw new Error("Telegram bot token is required");
  }

  const profile: ChannelProfile = {
    kind: "telegram",
    telegramBotToken,
    createdAt: overwriting ? config.channelProfiles[profileId]?.createdAt ?? new Date().toISOString() : new Date().toISOString()
  };

  await saveChannelProfilesFile(config.channelsFile, {
    profiles: {
      ...config.channelProfiles,
      [profileId]: profile
    }
  });

  const setDefault = await confirm("Set this as the default channel profile?", !config.defaultChannelProfileId);
  if (setDefault) {
    await saveUpdatedRootConfig(config, {
      defaultChannelProfileId: profileId
    });
  }

  logger.info("Channel profile saved", {
    profileId,
    kind: profile.kind,
    default: setDefault
  });
  process.stdout.write(`${overwriting ? "Updated" : "Saved"} channel profile "${profileId}".\n`);
}

export async function authorizeChannelUserCommand(): Promise<void> {
  ensureInteractiveTerminal();
  const config = loadConfig();
  if (!config.defaultChannelProfileId || config.selectedChannelProfile?.kind !== "telegram") {
    throw new Error("A default Telegram channel profile is required. Run `selfagent channels add` first.");
  }
  const request = await createTelegramAuthorizationRequest(config);
  logger.info("Created Telegram authorization request", {
    profileId: request.profileId,
    expiresAt: request.expiresAt
  });
  process.stdout.write(`${formatAuthorizationInstruction(request)}\n`);
}

export async function listChannelsCommand(): Promise<void> {
  const config = loadConfig();
  const entries = Object.entries(config.channelProfiles);
  if (entries.length === 0) {
    printSection("Configured channels:", ["  (none)"]);
    return;
  }

  const lines = entries.map(([profileId, profile]) => {
    const whitelistSummary =
      profile.kind === "telegram"
        ? ` whitelist=${profile.whitelistEnabled ? "enabled" : "disabled"} allowedUsers=${profile.allowedUserIds?.length ?? 0}`
        : "";
    return `  - ${profileId}${formatDefaultMarker(profileId === config.defaultChannelProfileId)} kind=${profile.kind} createdAt=${formatTimestamp(profile.createdAt)}${whitelistSummary}`;
  });
  printSection("Configured channels:", lines);
}

export async function addModelCommand(options: AddModelCommandOptions = {}): Promise<void> {
  ensureInteractiveTerminal();
  const config = loadConfig();
  process.stdout.write("\nAdd a model profile.\n");
  const authModeSelection = await choose("Model auth mode", ["API key", "Auth login"]);
  let profileId = "";
  let profile: ModelProfile;

  if (authModeSelection === 0) {
    const providerSelection = await choose("Provider", [
      "OpenAI",
      "Anthropic / Claude",
      "MiniMax (China)"
    ]);

    if (providerSelection === 0) {
      const requestedId = await promptWithDefault("Profile name", options.defaultProfileId ?? "openai-default");
      profileId = (
        await resolveProfileId({
          existingIds: Object.keys(config.modelProfiles),
          requestedId,
          preferOverwriteId: options.preferOverwriteDefault ? options.defaultProfileId : undefined,
          overwritePromptLabel: `Default model profile "${sanitizeProfileId(options.defaultProfileId ?? requestedId)}" already exists. Overwrite it?`
        })
      ).profileId;
      const modelId = await promptWithDefault("OpenAI model id", "gpt-5.4");
      const apiKey = await promptSecret("OpenAI API key: ");
      if (!apiKey) {
        throw new Error("OpenAI API key is required");
      }
      profile = {
        authMode: "apiKey",
        provider: "openai",
        modelId,
        apiKey,
        createdAt: config.modelProfiles[profileId]?.createdAt ?? new Date().toISOString()
      };
    } else if (providerSelection === 1) {
      const requestedId = await promptWithDefault("Profile name", options.defaultProfileId ?? "anthropic-default");
      profileId = (
        await resolveProfileId({
          existingIds: Object.keys(config.modelProfiles),
          requestedId,
          preferOverwriteId: options.preferOverwriteDefault ? options.defaultProfileId : undefined,
          overwritePromptLabel: `Default model profile "${sanitizeProfileId(options.defaultProfileId ?? requestedId)}" already exists. Overwrite it?`
        })
      ).profileId;
      const modelId = await promptWithDefault("Anthropic model id", "claude-sonnet-4-5");
      const apiKey = await promptSecret("Anthropic API key: ");
      if (!apiKey) {
        throw new Error("Anthropic API key is required");
      }
      profile = {
        authMode: "apiKey",
        provider: "anthropic",
        modelId,
        apiKey,
        createdAt: config.modelProfiles[profileId]?.createdAt ?? new Date().toISOString()
      };
    } else {
      const requestedId = await promptWithDefault("Profile name", options.defaultProfileId ?? "minimax-cn-default");
      profileId = (
        await resolveProfileId({
          existingIds: Object.keys(config.modelProfiles),
          requestedId,
          preferOverwriteId: options.preferOverwriteDefault ? options.defaultProfileId : undefined,
          overwritePromptLabel: `Default model profile "${sanitizeProfileId(options.defaultProfileId ?? requestedId)}" already exists. Overwrite it?`
        })
      ).profileId;
      const modelId = await promptWithDefault("MiniMax model id", "MiniMax-M2.5");
      const apiKey = await promptSecret("MiniMax API key: ");
      if (!apiKey) {
        throw new Error("MiniMax API key is required");
      }
      profile = {
        ...buildMiniMaxProfile(modelId, apiKey),
        createdAt: config.modelProfiles[profileId]?.createdAt ?? new Date().toISOString()
      };
    }
  } else {
    const providerSelection = await choose("Auth provider", ["OpenAI (ChatGPT auth)"]);
    if (providerSelection !== 0) {
      throw new Error("Unsupported auth provider");
    }
    const requestedId = await promptWithDefault("Profile name", options.defaultProfileId ?? "openai-chatgpt-default");
    profileId = (
      await resolveProfileId({
        existingIds: Object.keys(config.modelProfiles),
        requestedId,
        preferOverwriteId: options.preferOverwriteDefault ? options.defaultProfileId : undefined,
        overwritePromptLabel: `Default model profile "${sanitizeProfileId(options.defaultProfileId ?? requestedId)}" already exists. Overwrite it?`
      })
    ).profileId;
    await interactiveOpenAiOauthLogin(config);
    const modelId = await promptWithDefault("OpenAI auth model id", "gpt-5.4");
    profile = {
      authMode: "oauth",
      provider: "openai-codex",
      modelId,
      createdAt: config.modelProfiles[profileId]?.createdAt ?? new Date().toISOString()
    };
  }

  await saveModelProfilesFile(config.modelProfilesFile, {
    profiles: {
      ...config.modelProfiles,
      [profileId]: profile
    }
  });

  const setDefault = await confirm(
    "Set this as the default model profile?",
    !config.defaultModelProfileId
  );
  if (setDefault) {
    await saveUpdatedRootConfig(config, {
      defaultModelProfileId: profileId
    });
    const reloaded = loadConfig();
    await projectSelectedModelProfile(reloaded);
  }

  logger.info("Model profile saved", {
    profileId,
    provider: profile.provider,
    authMode: profile.authMode,
    modelId: profile.modelId,
    default: setDefault
  });
  process.stdout.write(`Saved model profile "${profileId}".\n`);
}

export async function listModelsCommand(): Promise<void> {
  const config = loadConfig();
  const entries = Object.entries(config.modelProfiles);
  if (entries.length === 0) {
    printSection("Configured model profiles:", ["  (none)"]);
    return;
  }

  const lines = entries.map(([profileId, profile]) => {
    const authDetails =
      profile.authMode === "apiKey"
        ? `provider=${profile.provider} auth=apiKey`
        : `provider=${profile.provider} auth=oauth`;
    return `  - ${profileId}${formatDefaultMarker(profileId === config.defaultModelProfileId)} ${authDetails} model=${profile.modelId} createdAt=${formatTimestamp(profile.createdAt)}`;
  });
  printSection("Configured model profiles:", lines);
}

export async function removeModelCommand(profileIdArg?: string): Promise<void> {
  const config = loadConfig();
  const entries = Object.entries(config.modelProfiles);

  if (entries.length === 0) {
    throw new Error("No model profiles are configured.");
  }

  let profileId = profileIdArg?.trim();
  if (!profileId) {
    ensureInteractiveTerminal();
    const selection = await choose(
      "Select model profile to remove",
      entries.map(([entryId, profile]) => {
        const defaultSuffix = entryId === config.defaultModelProfileId ? " [default]" : "";
        return `${entryId}${defaultSuffix} (${profile.provider}/${profile.modelId})`;
      })
    );
    profileId = entries[selection]?.[0];
  }

  if (!profileId || !config.modelProfiles[profileId]) {
    throw new Error(`Unknown model profile: ${profileId ?? "(none)"}`);
  }

  const profile = config.modelProfiles[profileId];
  const confirmed =
    process.stdin.isTTY && process.stdout.isTTY
      ? await confirm(
          `Remove model profile "${profileId}" (${profile.provider}/${profile.modelId})?`,
          false
        )
      : true;
  if (!confirmed) {
    process.stdout.write("Cancelled.\n");
    return;
  }

  const nextProfiles = { ...config.modelProfiles };
  delete nextProfiles[profileId];
  await saveModelProfilesFile(config.modelProfilesFile, { profiles: nextProfiles });

  if (profileId === config.defaultModelProfileId) {
    await saveUpdatedRootConfig(config, {
      defaultModelProfileId: undefined
    });
    if (profile.provider === "minimax-cn") {
      await clearProjectedMiniMaxProvider(config);
    }
  }

  logger.info("Model profile removed", {
    profileId,
    provider: profile.provider,
    modelId: profile.modelId,
    wasDefault: profileId === config.defaultModelProfileId
  });
  process.stdout.write(`Removed model profile "${profileId}".\n`);
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value: ${trimmed}`);
  }
  return parsed;
}

function formatCronOrigin(job: ReturnType<typeof loadCronJobs>[number]): string {
  return job.origin.threadId
    ? `telegram:${job.origin.chatId}/thread:${job.origin.threadId}`
    : `telegram:${job.origin.chatId}`;
}

export async function addCronCommand(): Promise<void> {
  ensureInteractiveTerminal();
  const config = loadConfig();
  const name = (await promptWithDefault("Task name", "daily-brief")).trim();
  const schedule = (await promptWithDefault("Schedule", "0 9 * * *")).trim();
  const prompt = (await promptWithDefault("Task prompt", "Summarize the most important updates and send a concise report.")).trim();
  const skillNamesRaw = await promptWithDefault("Skills (comma-separated, optional)", "");
  const chatId = parseOptionalNumber(await promptWithDefault("Telegram chat id", ""));
  if (chatId === undefined) {
    throw new Error("Telegram chat id is required for cron task delivery.");
  }
  const threadId = parseOptionalNumber(await promptWithDefault("Telegram thread id (optional)", ""));
  const modelProvider = (await promptWithDefault("Model provider override (optional)", "")).trim() || undefined;
  const modelId = (await promptWithDefault("Model id override (optional)", "")).trim() || undefined;

  const jobs = loadCronJobs(config.stateRoot);
  const job = createCronJob({
    name,
    prompt,
    scheduleInput: schedule,
    skillNames: skillNamesRaw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    origin: {
      platform: "telegram",
      chatId,
      threadId
    },
    modelProvider,
    modelId
  });
  jobs.push(job);
  await saveCronJobs(config.stateRoot, jobs);
  logger.info("Cron task created", {
    jobId: job.id,
    name: job.name,
    schedule: job.schedule.display,
    origin: formatCronOrigin(job)
  });
  process.stdout.write(
    [
      `Created cron task "${job.name}".`,
      `Job ID: ${job.id}`,
      `Schedule: ${job.schedule.display}`,
      `Next run: ${job.nextRunAt ?? "(none)"}`,
      `Origin: ${formatCronOrigin(job)}`
    ].join("\n") + "\n"
  );
}

export async function listCronCommand(): Promise<void> {
  const config = loadConfig();
  const jobs = loadCronJobs(config.stateRoot);
  if (jobs.length === 0) {
    printSection("Configured cron tasks:", ["  (none)"]);
    return;
  }
  const lines = jobs.map((job) => {
    const status = job.enabled ? "enabled" : "paused";
    return `  - ${job.id} [${status}] ${job.name} schedule=${job.schedule.display} next=${job.nextRunAt ?? "(none)"} last=${job.lastStatus ?? "(never)"} origin=${formatCronOrigin(job)} skills=${job.skillNames.join(",") || "(none)"}`;
  });
  printSection("Configured cron tasks:", lines);
}

async function mutateCronJobCommand(
  action: "pause" | "resume" | "remove" | "run",
  jobIdArg?: string
): Promise<void> {
  const config = loadConfig();
  const jobs = loadCronJobs(config.stateRoot);
  if (jobs.length === 0) {
    throw new Error("No cron tasks are configured.");
  }

  let jobId = jobIdArg?.trim();
  if (!jobId) {
    ensureInteractiveTerminal();
    const selection = await choose(
      `Select cron task to ${action}`,
      jobs.map((job) => `${job.id} (${job.name})`)
    );
    jobId = jobs[selection]?.id;
  }

  const index = jobs.findIndex((job) => job.id === jobId);
  if (index < 0) {
    throw new Error(`Unknown cron task: ${jobId ?? "(none)"}`);
  }
  const job = jobs[index]!;

  if (action === "remove") {
    const confirmed =
      process.stdin.isTTY && process.stdout.isTTY
        ? await confirm(`Remove cron task "${job.name}" (${job.id})?`, false)
        : true;
    if (!confirmed) {
      process.stdout.write("Cancelled.\n");
      return;
    }
    jobs.splice(index, 1);
    await saveCronJobs(config.stateRoot, jobs);
    process.stdout.write(`Removed cron task "${job.id}".\n`);
    return;
  }

  if (action === "pause") {
    jobs[index] = updateCronJob(job, { enabled: false });
    await saveCronJobs(config.stateRoot, jobs);
    process.stdout.write(`Paused cron task "${job.id}".\n`);
    return;
  }

  if (action === "resume") {
    jobs[index] = updateCronJob(job, { enabled: true });
    await saveCronJobs(config.stateRoot, jobs);
    process.stdout.write(`Resumed cron task "${job.id}". Next run: ${jobs[index]?.nextRunAt ?? "(none)"}\n`);
    return;
  }

  jobs[index] = {
    ...job,
    enabled: true,
    nextRunAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await saveCronJobs(config.stateRoot, jobs);
  process.stdout.write(
    `Cron task "${job.id}" marked due. It will run on the next scheduler tick while SelfAgent is running.\n`
  );
}

export async function pauseCronCommand(jobIdArg?: string): Promise<void> {
  await mutateCronJobCommand("pause", jobIdArg);
}

export async function resumeCronCommand(jobIdArg?: string): Promise<void> {
  await mutateCronJobCommand("resume", jobIdArg);
}

export async function removeCronCommand(jobIdArg?: string): Promise<void> {
  await mutateCronJobCommand("remove", jobIdArg);
}

export async function runCronCommand(jobIdArg?: string): Promise<void> {
  await mutateCronJobCommand("run", jobIdArg);
}

async function maybeConfigureMissingStartDependency(params: {
  config: AppConfig;
  missing: "channel" | "model";
}): Promise<AppConfig> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return params.config;
  }
  const command = params.missing === "channel" ? "selfagent channels add" : "selfagent models add";
  const question =
    params.missing === "channel"
      ? "No default channel profile is configured. Configure one now?"
      : "No default model profile is configured. Configure one now?";
  const shouldConfigure = await confirm(question, true);
  if (!shouldConfigure) {
    return params.config;
  }
  if (params.missing === "model" && Object.keys(params.config.modelProfiles).length > 0) {
    const entries = Object.entries(params.config.modelProfiles);
    const selection = await choose(
      "Choose a model profile to set as default, or create a new one",
      [
        ...entries.map(([profileId, profile]) => `${profileId} (${profile.provider}/${profile.modelId})`),
        "Create or replace a model profile"
      ]
    );
    if (selection < entries.length) {
      const profileId = entries[selection]![0];
      await saveUpdatedRootConfig(params.config, { defaultModelProfileId: profileId });
      const reloaded = loadConfig();
      await projectSelectedModelProfile(reloaded);
      return loadConfig();
    }
    if (params.config.defaultModelProfileId) {
      const overwrite = await confirm(
        `Default model profile "${params.config.defaultModelProfileId}" already exists. Overwrite it?`,
        false
      );
      await addModelCommand({
        defaultProfileId: params.config.defaultModelProfileId,
        preferOverwriteDefault: overwrite
      });
      return loadConfig();
    }
    await addModelCommand();
    return loadConfig();
  }
  if (params.missing === "channel" && Object.keys(params.config.channelProfiles).length > 0) {
    const entries = Object.entries(params.config.channelProfiles);
    const selection = await choose(
      "Choose a channel profile to set as default, or create a new one",
      [
        ...entries.map(([profileId, profile]) => `${profileId} (${profile.kind})`),
        "Create or replace a channel profile"
      ]
    );
    if (selection < entries.length) {
      const profileId = entries[selection]![0];
      await saveUpdatedRootConfig(params.config, { defaultChannelProfileId: profileId });
      return loadConfig();
    }
    if (params.config.defaultChannelProfileId) {
      const overwrite = await confirm(
        `Default channel profile "${params.config.defaultChannelProfileId}" already exists. Overwrite it?`,
        false
      );
      await addChannelCommand({
        defaultProfileId: params.config.defaultChannelProfileId,
        preferOverwriteDefault: overwrite
      });
      return loadConfig();
    }
    await addChannelCommand();
    return loadConfig();
  }
  if (params.missing === "channel") {
    await addChannelCommand();
  } else {
    await addModelCommand();
  }
  return loadConfig();
}

export async function onboardCommand(): Promise<void> {
  ensureInteractiveTerminal();
  let config = loadConfig();

  process.stdout.write(
    [
      "SelfAgent onboarding",
      `State root: ${config.stateRoot}`,
      `Workspace root: ${config.workspaceRoot}`,
      ""
    ].join("\n")
  );

  if (hasConfiguredModel(config)) {
    const current = config.selectedModelProfile;
    const replace = await confirm(
      `Default model profile is ${config.defaultModelProfileId} (${current?.provider}/${current?.modelId}). Reconfigure it?`,
      false
    );
    if (replace) {
      await addModelCommand({
        defaultProfileId: config.defaultModelProfileId,
        preferOverwriteDefault: true
      });
      config = loadConfig();
    }
  } else {
    config = await maybeConfigureMissingStartDependency({ config, missing: "model" });
  }

  process.stdout.write("\nTelegram is currently the only supported channel.\n");
  if (hasConfiguredChannel(config)) {
    const current = config.selectedChannelProfile;
    const replace = await confirm(
      `Default channel profile is ${config.defaultChannelProfileId} (${current?.kind}). Reconfigure it?`,
      false
    );
    if (replace) {
      await addChannelCommand({
        defaultProfileId: config.defaultChannelProfileId,
        preferOverwriteDefault: true
      });
      config = loadConfig();
    }
  } else {
    config = await maybeConfigureMissingStartDependency({ config, missing: "channel" });
  }

  process.stdout.write(
    [
      "",
      "Onboarding complete.",
      `Default model profile: ${config.defaultModelProfileId ?? "(none)"}`,
      `Default channel profile: ${config.defaultChannelProfileId ?? "(none)"}`
    ].join("\n") + "\n"
  );
}

export async function startCommand(options?: { daemon?: boolean }): Promise<void> {
  let config = loadConfig();

  if (options?.daemon && process.env.SELFAGENT_DAEMONIZED !== "1") {
    const current = readDaemonPidFile(config);
    if (current?.pid && isProcessRunning(current.pid)) {
      process.stdout.write(
        `SelfAgent daemon is already running.\nPID: ${current.pid}\nLog: ${current.logFile ?? config.logFile ?? `${config.stateRoot}/logs/runtime.log`}\n`
      );
      return;
    }
    if (current?.pid) {
      await removeDaemonPidFile(config);
    }
    const logFile = config.logFile ?? `${config.stateRoot}/logs/runtime.log`;
    const entryScript = process.argv[1];
    if (!entryScript) {
      throw new Error("Unable to determine CLI entrypoint for daemon start");
    }
    const childArgs = [...process.execArgv, entryScript, "start"];
    logger.info("Starting daemon child process", {
      execPath: process.execPath,
      childArgs,
      logFile
    });
    const child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: "ignore",
      cwd: config.workspaceRoot,
      env: {
        ...process.env,
        SELFAGENT_DAEMONIZED: "1",
        SELFAGENT_LOG_FILE: logFile,
        SELFAGENT_LOG_MAX_BYTES: String(config.logMaxBytes),
        SELFAGENT_LOG_MAX_FILES: String(config.logMaxFiles)
      }
    });
    child.unref();
    await writeDaemonPidFile(config, child.pid!, logFile);
    process.stdout.write(`SelfAgent daemon started.\nPID: ${child.pid}\nLog: ${logFile}\n`);
    return;
  }

  if (!hasConfiguredModel(config)) {
    config = await maybeConfigureMissingStartDependency({ config, missing: "model" });
  }
  if (!hasConfiguredChannel(config)) {
    config = await maybeConfigureMissingStartDependency({ config, missing: "channel" });
  }

  if (!hasConfiguredModel(config)) {
    throw new Error("No default model profile configured. Run `selfagent models add` first.");
  }
  if (!hasConfiguredChannel(config)) {
    throw new Error("No default channel profile configured. Run `selfagent channels add` first.");
  }

  await projectSelectedModelProfile(config);
  await startTelegramRuntime(config);
}

export async function restartCommand(): Promise<void> {
  const config = loadConfig();
  const current = readDaemonPidFile(config);
  if (current?.pid && isProcessRunning(current.pid)) {
    process.kill(current.pid, "SIGTERM");
    await removeDaemonPidFile(config);
    logger.info("Stopped SelfAgent daemon for restart", { pid: current.pid });
  } else if (current?.pid) {
    await removeDaemonPidFile(config);
  }
  await startCommand({ daemon: true });
}

export async function stopCommand(): Promise<void> {
  const config = loadConfig();
  const current = readDaemonPidFile(config);
  if (!current?.pid) {
    process.stdout.write("SelfAgent daemon is not running.\n");
    return;
  }

  if (!isProcessRunning(current.pid)) {
    await removeDaemonPidFile(config);
    process.stdout.write("SelfAgent daemon is not running. Removed stale pid file.\n");
    return;
  }

  process.kill(current.pid, "SIGTERM");
  await removeDaemonPidFile(config);
  logger.info("Stopped SelfAgent daemon", { pid: current.pid });
  process.stdout.write(`Stopped SelfAgent daemon.\nPID: ${current.pid}\n`);
}

export async function statusCommand(): Promise<void> {
  const config = loadConfig();
  const current = readDaemonPidFile(config);
  const whitelistLine =
    config.selectedChannelProfile?.kind === "telegram"
      ? `Whitelist: ${config.selectedChannelProfile.whitelistEnabled ? "enabled" : "disabled"} (${config.selectedChannelProfile.allowedUserIds?.length ?? 0} users)`
      : undefined;
  if (!current?.pid) {
    process.stdout.write(
      [
        "SelfAgent daemon status: stopped",
        `State root: ${config.stateRoot}`,
        `Workspace root: ${current?.workspaceRoot ?? config.workspaceRoot}`,
        whitelistLine
      ]
        .filter(Boolean)
        .join("\n") + "\n"
    );
    return;
  }

  if (!isProcessRunning(current.pid)) {
    await removeDaemonPidFile(config);
    process.stdout.write(
      [
        "SelfAgent daemon status: stopped (stale pid file removed)",
        `State root: ${config.stateRoot}`,
        `Workspace root: ${current.workspaceRoot ?? config.workspaceRoot}`,
        whitelistLine
      ]
        .filter(Boolean)
        .join("\n") + "\n"
    );
    return;
  }

  process.stdout.write(
    [
      "SelfAgent daemon status: running",
      `PID: ${current.pid}`,
      `Started: ${current.startedAt ?? "(unknown)"}`,
      `Log: ${current.logFile ?? config.logFile ?? `${config.stateRoot}/logs/runtime.log`}`,
      `State root: ${config.stateRoot}`,
      `Workspace root: ${current.workspaceRoot ?? config.workspaceRoot}`,
      `Default channel profile: ${config.defaultChannelProfileId ?? "(none)"}`,
      `Default model profile: ${config.defaultModelProfileId ?? "(none)"}`,
      whitelistLine
    ].join("\n") + "\n"
  );
}

export function versionCommand(): void {
  process.stdout.write(`${getSelfAgentVersion()}\n`);
}

function getUpgradeRecommendation(): { mode: ReturnType<typeof detectInstallMode>; command?: string; note: string } {
  const mode = detectInstallMode();
  if (mode === "npx") {
    return {
      mode,
      note: "This session is running via npx. To use the latest version, rerun your command with `npx selfagent@latest ...`."
    };
  }
  if (mode === "installed") {
    return {
      mode,
      command: "npm install -g selfagent@latest",
      note: "Upgrade will reinstall the latest published SelfAgent CLI globally."
    };
  }
  return {
    mode,
    command: "npm install -g selfagent@latest",
    note: "This looks like a local development checkout. Global upgrade was not executed automatically."
  };
}

export async function upgradeCommand(): Promise<void> {
  const recommendation = getUpgradeRecommendation();
  process.stdout.write(`SelfAgent ${getSelfAgentVersion()}\n`);
  process.stdout.write(`${recommendation.note}\n`);

  if (!recommendation.command) {
    return;
  }

  process.stdout.write(`Recommended command: ${recommendation.command}\n`);
  if (recommendation.mode !== "installed") {
    return;
  }

  const shouldRun =
    process.stdin.isTTY && process.stdout.isTTY
      ? await confirm("Run this upgrade command now?", true)
      : true;
  if (!shouldRun) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["install", "-g", "selfagent@latest"], {
      stdio: "inherit",
      env: process.env
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Upgrade command exited with code ${code ?? "(unknown)"}`));
    });
  });
}

export function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  selfagent --version",
      "  selfagent --upgrade",
      "  selfagent onboard",
      "  selfagent start [--daemon]",
      "  selfagent restart",
      "  selfagent stop",
      "  selfagent status",
      "  selfagent channels add",
      "  selfagent channels list",
      "  selfagent channels authorize-user",
      "  selfagent models add",
      "  selfagent models list",
      "  selfagent models remove <profile-id>",
      "  selfagent cron add",
      "  selfagent cron list",
      "  selfagent cron pause <job-id>",
      "  selfagent cron resume <job-id>",
      "  selfagent cron remove <job-id>",
      "  selfagent cron run <job-id>"
    ].join("\n") + "\n"
  );
}
