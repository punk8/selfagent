import { existsSync, readFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { createTelegramAuthorizationRequest, formatAuthorizationInstruction } from "./access.js";
import { loadConfig, type AppConfig } from "./config.js";
import { createLogger } from "./logger.js";
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

async function writeDaemonPidFile(config: AppConfig, pid: number, logFile: string): Promise<void> {
  const pidFile = `${config.stateRoot}/run/selfagent.pid`;
  await mkdir(dirname(pidFile), { recursive: true });
  await writeFile(
    pidFile,
    `${JSON.stringify(
      {
        pid,
        startedAt: new Date().toISOString(),
        logFile
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

async function interactiveOpenAiOauthLogin(config: AppConfig): Promise<void> {
  const authStorage = AuthStorage.create(config.authFile);
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
}

function buildMiniMaxProfile(modelId: string, apiKey: string): ApiKeyModelProfile {
  return {
    authMode: "apiKey",
    provider: "minimax-cn",
    modelId,
    apiKey,
    createdAt: new Date().toISOString(),
    baseUrl: "https://api.minimax.io/anthropic",
    api: "anthropic-messages",
    authHeader: true,
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
    const next = readPiModelsFile(config.modelsFile);
    next.providers ??= {};
    next.providers["minimax-cn"] = {
      baseUrl: profile.baseUrl ?? "https://api.minimax.io/anthropic",
      api: profile.api ?? "anthropic-messages",
      apiKey: profile.apiKey,
      authHeader: profile.authHeader ?? true,
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

export async function addChannelCommand(): Promise<void> {
  ensureInteractiveTerminal();
  const config = loadConfig();
  process.stdout.write("\nAdd a channel profile.\n");
  const selection = await choose("Channel provider", ["Telegram"]);
  if (selection !== 0) {
    throw new Error("Unsupported channel provider");
  }

  const requestedId = await promptWithDefault("Profile name", "telegram-default");
  const profileId = ensureUniqueProfileId(Object.keys(config.channelProfiles), requestedId);
  const telegramBotToken = await promptSecret("Telegram bot token: ");
  if (!telegramBotToken) {
    throw new Error("Telegram bot token is required");
  }

  const profile: ChannelProfile = {
    kind: "telegram",
    telegramBotToken,
    createdAt: new Date().toISOString()
  };

  await saveChannelProfilesFile(config.channelsFile, {
    profiles: {
      ...config.channelProfiles,
      [profileId]: profile
    }
  });

  const setDefault = await confirm(
    "Set this as the default channel profile?",
    !config.defaultChannelProfileId
  );
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
  process.stdout.write(`Saved channel profile "${profileId}".\n`);
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

export async function addModelCommand(): Promise<void> {
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
      const requestedId = await promptWithDefault("Profile name", "openai-default");
      profileId = ensureUniqueProfileId(Object.keys(config.modelProfiles), requestedId);
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
        createdAt: new Date().toISOString()
      };
    } else if (providerSelection === 1) {
      const requestedId = await promptWithDefault("Profile name", "anthropic-default");
      profileId = ensureUniqueProfileId(Object.keys(config.modelProfiles), requestedId);
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
        createdAt: new Date().toISOString()
      };
    } else {
      const requestedId = await promptWithDefault("Profile name", "minimax-cn-default");
      profileId = ensureUniqueProfileId(Object.keys(config.modelProfiles), requestedId);
      const modelId = await promptWithDefault("MiniMax model id", "MiniMax-M2.5");
      const apiKey = await promptSecret("MiniMax API key: ");
      if (!apiKey) {
        throw new Error("MiniMax API key is required");
      }
      profile = buildMiniMaxProfile(modelId, apiKey);
    }
  } else {
    process.stdout.write("\nCurrently supported auth login provider:\n1. OpenAI (ChatGPT auth)\n");
    const providerSelection = await choose("Auth provider", ["OpenAI (ChatGPT auth)"]);
    if (providerSelection !== 0) {
      throw new Error("Unsupported auth provider");
    }
    const requestedId = await promptWithDefault("Profile name", "openai-chatgpt-default");
    profileId = ensureUniqueProfileId(Object.keys(config.modelProfiles), requestedId);
    await interactiveOpenAiOauthLogin(config);
    const modelId = await promptWithDefault("OpenAI auth model id", "gpt-5.4");
    profile = {
      authMode: "oauth",
      provider: "openai-codex",
      modelId,
      createdAt: new Date().toISOString()
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
  if (params.missing === "channel") {
    await addChannelCommand();
  } else {
    await addModelCommand();
  }
  return loadConfig();
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
    const childArgs = [
      ...process.execArgv,
      ...process.argv.slice(1).filter((arg) => arg !== "--daemon")
    ];
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

  if (!hasConfiguredChannel(config)) {
    config = await maybeConfigureMissingStartDependency({ config, missing: "channel" });
  }
  if (!hasConfiguredModel(config)) {
    config = await maybeConfigureMissingStartDependency({ config, missing: "model" });
  }

  if (!hasConfiguredChannel(config)) {
    throw new Error("No default channel profile configured. Run `selfagent channels add` first.");
  }
  if (!hasConfiguredModel(config)) {
    throw new Error("No default model profile configured. Run `selfagent models add` first.");
  }

  await projectSelectedModelProfile(config);
  await startTelegramRuntime(config);
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
      ["SelfAgent daemon status: stopped", whitelistLine].filter(Boolean).join("\n") + "\n"
    );
    return;
  }

  if (!isProcessRunning(current.pid)) {
    await removeDaemonPidFile(config);
    process.stdout.write(
      ["SelfAgent daemon status: stopped (stale pid file removed)", whitelistLine]
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
      `Default channel profile: ${config.defaultChannelProfileId ?? "(none)"}`,
      `Default model profile: ${config.defaultModelProfileId ?? "(none)"}`,
      whitelistLine
    ].join("\n") + "\n"
  );
}

export function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  selfagent start [--daemon]",
      "  selfagent stop",
      "  selfagent status",
      "  selfagent channels add",
      "  selfagent channels authorize-user",
      "  selfagent models add"
    ].join("\n") + "\n"
  );
}
