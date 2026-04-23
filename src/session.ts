import { mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  type AgentSessionEvent,
  type AgentSession,
  type Skill,
  type ToolDefinition
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { ApprovalStore } from "./approvals.js";
import { executeComputerUse } from "./computer-use.js";
import {
  appendCronRunRecord,
  appendRecentCronDelivery,
  createCronJob,
  createCronRunId,
  createCronRunPaths,
  describeCronOrigin,
  findCronJob,
  formatRecentCronDeliveriesForPrompt,
  loadRecentCronDeliveries,
  loadCronJobs,
  saveCronJobs,
  summarizeCronResult,
  updateCronJob,
  type CronJob
} from "./cron.js";
import type { AppConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { readMemory } from "./memory.js";
import { getConversationPaths } from "./paths.js";
import { loadWorkspaceAndConversationSkills } from "./skills.js";
import { buildCronTaskPromptAppend, buildTelegramPromptAppend, buildUserPrompt } from "./system-prompt.js";
import type { ComputerUseRequest, ConversationRef, IncomingAttachment } from "./types.js";

const logger = createLogger("session");
const PROMPT_TIMEOUT_POLL_MS = 5_000;
const PROMPT_TIMEOUT_HEARTBEAT_MS = 30_000;

export interface ConversationServices {
  config: AppConfig;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  sendAttachment: (filePath: string, title?: string) => Promise<void>;
  requestApproval: (summary: string, requestId: string) => Promise<void>;
}

export interface ConversationTurnCallbacks {
  onTextDelta?: (delta: string) => Promise<void> | void;
  onFinalText?: (text: string) => Promise<void> | void;
}

export class SelfAgentTimeoutError extends Error {
  constructor(
    public readonly kind: "inactivity" | "hard",
    public readonly scope: "interactive" | "cron",
    public readonly timeoutSeconds: number,
    public readonly elapsedSeconds: number,
    public readonly lastActivityAt: string,
    message: string
  ) {
    super(message);
    this.name = "SelfAgentTimeoutError";
  }
}

interface PromptTimeoutOptions {
  scope: "interactive" | "cron";
  label: string;
  inactivityTimeoutSeconds: number;
  hardTimeoutSeconds?: number;
  getLastActivityAt: () => number;
  messageForKind: (kind: "inactivity" | "hard") => string;
  logContext: Record<string, string | number | undefined>;
}

const attachSchema = Type.Object({
  label: Type.String({ description: "Short description of the file being shared" }),
  path: Type.String({ description: "Absolute or workspace-relative path to the file" }),
  title: Type.Optional(Type.String({ description: "Optional filename shown to the user" }))
});

const computerUseSchema = Type.Object({
  action: Type.Union([
    Type.Literal("open_app"),
    Type.Literal("open_url"),
    Type.Literal("type_text"),
    Type.Literal("press_key")
  ]),
  summary: Type.String({ description: "User-facing summary of the intended computer action" }),
  app: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  key: Type.Optional(Type.String())
});

const cronTaskSchema = Type.Object({
  action: Type.Union([
    Type.Literal("add"),
    Type.Literal("list"),
    Type.Literal("pause"),
    Type.Literal("resume"),
    Type.Literal("remove"),
    Type.Literal("run")
  ]),
  jobId: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  schedule: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  skillNames: Type.Optional(Type.Array(Type.String())),
  modelProvider: Type.Optional(Type.String()),
  modelId: Type.Optional(Type.String())
});

function isPathWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function createAttachTool(services: ConversationServices): ToolDefinition<typeof attachSchema> {
  return {
    name: "attach",
    label: "attach",
    description: "Send a generated image or file back to the Telegram user.",
    promptSnippet: "`attach`: send an image or file to the Telegram user",
    promptGuidelines: [
      "Use `attach` whenever you need to deliver a file or image artifact to the Telegram user."
    ],
    parameters: attachSchema,
    execute: async (_toolCallId, params) => {
      const resolved = resolve(services.config.workspaceRoot, params.path);
      if (
        !isPathWithin(resolved, services.config.workspaceRoot) &&
        !isPathWithin(resolved, services.config.stateRoot)
      ) {
        throw new Error("attach only allows files inside the workspace or state directory");
      }
      logger.info("attach tool invoked", {
        label: params.label,
        path: resolved,
        title: params.title ?? basename(resolved)
      });
      await services.sendAttachment(resolved, params.title ?? basename(resolved));
      return {
        content: [{ type: "text" as const, text: `Attached file: ${params.title ?? basename(resolved)}` }],
        details: undefined
      };
    }
  };
}

function createComputerUseTool(
  conversation: ConversationRef,
  services: ConversationServices,
  approvalStore: ApprovalStore
): ToolDefinition<typeof computerUseSchema> {
  return {
    name: "computer_use",
    label: "computer_use",
    description:
      "Perform a limited local desktop operation after explicit Telegram user approval.",
    promptSnippet: "`computer_use`: request or execute limited local desktop actions after approval",
    promptGuidelines: [
      "Use `computer_use` only when the user explicitly wants a local desktop action.",
      "If approval is missing, the tool will request it and no action will execute yet."
    ],
    parameters: computerUseSchema,
    execute: async (_toolCallId, params: Static<typeof computerUseSchema>) => {
      logger.info("computer_use tool invoked", {
        action: params.action,
        summary: params.summary,
        conversation: `${conversation.platform}:${conversation.chatId}:${conversation.threadId ?? "root"}`
      });
      const grant = await approvalStore.consumeGrant(conversation.userId);
      if (!grant) {
        const pending = await approvalStore.createPending(params.summary, conversation.userId);
        await services.requestApproval(params.summary, pending.requestId);
        logger.info("computer_use approval requested", {
          requestId: pending.requestId,
          userId: conversation.userId
        });
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Computer use approval is required and has been requested from the user. No action was executed yet."
            }
          ],
          details: { approvalRequested: true, requestId: pending.requestId }
        };
      }

      const result = await executeComputerUse(params as ComputerUseRequest);
      logger.info("computer_use executed", {
        action: params.action,
        grantedMode: grant
      });
      return {
        content: [{ type: "text" as const, text: result }],
        details: { grantedMode: grant }
      };
    }
  };
}

function createCronTaskTool(
  conversation: ConversationRef,
  services: ConversationServices
): ToolDefinition<typeof cronTaskSchema> {
  return {
    name: "cron_task",
    label: "cron_task",
    description: "Create and manage scheduled tasks that deliver results back to this Telegram conversation.",
    promptSnippet: "`cron_task`: create, list, pause, resume, remove, or trigger scheduled tasks for this Telegram conversation",
    promptGuidelines: [
      "Use `cron_task` when the user wants a scheduled or recurring task.",
      "When adding a task, provide a clear schedule and self-contained prompt.",
      "Prefer the current conversation as the task's notification destination."
    ],
    parameters: cronTaskSchema,
    execute: async (_toolCallId, params) => {
      const jobs = loadCronJobs(services.config.stateRoot);
      const sameOrigin = (job: CronJob) =>
        job.origin.platform === "telegram" &&
        job.origin.chatId === conversation.chatId &&
        (job.origin.threadId ?? undefined) === (conversation.threadId ?? undefined);

      if (params.action === "add") {
        const name = params.name?.trim();
        const schedule = params.schedule?.trim();
        const prompt = params.prompt?.trim();
        if (!name || !schedule || !prompt) {
          throw new Error("cron_task add requires `name`, `schedule`, and `prompt`.");
        }
        const job = createCronJob({
          name,
          prompt,
          scheduleInput: schedule,
          skillNames: params.skillNames ?? [],
          origin: describeCronOrigin(conversation),
          modelProvider: params.modelProvider,
          modelId: params.modelId
        });
        jobs.push(job);
        await saveCronJobs(services.config.stateRoot, jobs);
        return {
          content: [
            {
              type: "text" as const,
              text: `Scheduled task created.\nJob ID: ${job.id}\nName: ${job.name}\nSchedule: ${job.schedule.display}\nNext run: ${job.nextRunAt ?? "(none)"}`
            }
          ],
          details: { jobId: job.id }
        };
      }

      if (params.action === "list") {
        const scoped = jobs.filter(sameOrigin);
        const summary =
          scoped.length === 0
            ? "No scheduled tasks are bound to this Telegram conversation."
            : scoped
                .map(
                  (job) =>
                    `- ${job.id} ${job.enabled ? "[enabled]" : "[paused]"} ${job.name} | schedule=${job.schedule.display} | next=${job.nextRunAt ?? "(none)"} | last=${job.lastStatus ?? "(never)"}`
                )
                .join("\n");
        return {
          content: [{ type: "text" as const, text: summary }],
          details: { count: scoped.length }
        };
      }

      const jobId = params.jobId?.trim();
      if (!jobId) {
        throw new Error(`cron_task ${params.action} requires \`jobId\`.`);
      }
      const index = jobs.findIndex((job) => job.id === jobId && sameOrigin(job));
      if (index < 0) {
        throw new Error(`Scheduled task not found in this conversation: ${jobId}`);
      }
      const current = jobs[index]!;

      if (params.action === "remove") {
        jobs.splice(index, 1);
        await saveCronJobs(services.config.stateRoot, jobs);
        return {
          content: [{ type: "text" as const, text: `Removed scheduled task ${current.id} (${current.name}).` }],
          details: { jobId: current.id }
        };
      }

      if (params.action === "pause") {
        jobs[index] = updateCronJob(current, { enabled: false });
        await saveCronJobs(services.config.stateRoot, jobs);
        return {
          content: [{ type: "text" as const, text: `Paused scheduled task ${current.id} (${current.name}).` }],
          details: { jobId: current.id }
        };
      }

      if (params.action === "resume") {
        jobs[index] = updateCronJob(current, { enabled: true });
        await saveCronJobs(services.config.stateRoot, jobs);
        return {
          content: [
            {
              type: "text" as const,
              text: `Resumed scheduled task ${current.id} (${current.name}). Next run: ${jobs[index]?.nextRunAt ?? "(none)"}`
            }
          ],
          details: { jobId: current.id }
        };
      }

      jobs[index] = {
        ...current,
        enabled: true,
        nextRunAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await saveCronJobs(services.config.stateRoot, jobs);
      return {
        content: [
          {
            type: "text" as const,
            text: `Triggered scheduled task ${current.id} (${current.name}). It will run on the next scheduler tick.`
          }
        ],
        details: { jobId: current.id }
      };
    }
  };
}

function extractLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i];
    if (message.role !== "assistant") continue;
    const content: unknown = message.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      const parts = content
        .filter(
          (item): item is { type: "text"; text: string } =>
            typeof item === "object" && item !== null && "type" in item && item.type === "text"
        )
        .map((item) => item.text.trim())
        .filter(Boolean);
      if (parts.length > 0) return parts.join("\n");
    }
  }
  return "";
}

function extractTextFromUnknownContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((item) => {
      if (typeof item !== "object" || item === null || !("type" in item)) {
        return [];
      }
      if (item.type === "text" && "text" in item && typeof item.text === "string") {
        return [item.text];
      }
      return [];
    })
    .join("\n")
    .trim();
}

function summarizeTailMessages(session: AgentSession): string {
  return session.messages
    .slice(-6)
    .map((message, index) => {
      const content = "content" in message ? (message as { content?: unknown }).content : undefined;
      const text = extractTextFromUnknownContent(content);
      const contentShape = Array.isArray(content)
        ? content
            .map((item) =>
              typeof item === "object" && item !== null && "type" in item ? String(item.type) : typeof item
            )
            .join(",")
        : typeof content;
      return `${index}: role=${"role" in message ? String(message.role) : "unknown"} content=${contentShape} textChars=${text.length}`;
    })
    .join(" | ");
}

function extractAssistantErrorDetails(message: unknown): { stopReason?: string; errorMessage?: string; model?: string; provider?: string } {
  if (typeof message !== "object" || message === null) {
    return {};
  }
  const candidate = message as {
    stopReason?: unknown;
    errorMessage?: unknown;
    model?: unknown;
    provider?: unknown;
  };
  return {
    stopReason: typeof candidate.stopReason === "string" ? candidate.stopReason : undefined,
    errorMessage: typeof candidate.errorMessage === "string" ? candidate.errorMessage : undefined,
    model: typeof candidate.model === "string" ? candidate.model : undefined,
    provider: typeof candidate.provider === "string" ? candidate.provider : undefined
  };
}

function buildResourceLoader(config: AppConfig, skills: Skill[], promptAppend: string): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: config.workspaceRoot,
    agentDir: config.agentDir,
    skillsOverride: (current) => {
      const merged = new Map<string, Skill>();
      for (const skill of current.skills) merged.set(skill.name, skill);
      for (const skill of skills) merged.set(skill.name, skill);
      return { skills: [...merged.values()], diagnostics: current.diagnostics };
    },
    appendSystemPromptOverride: (base) => {
      return [...base, promptAppend];
    }
  });
}

function resolveConfiguredModel(
  config: AppConfig,
  modelRegistry: ModelRegistry,
  overrides?: { modelProvider?: string; modelId?: string }
) {
  const modelProvider = overrides?.modelProvider ?? config.modelProvider;
  const modelId = overrides?.modelId ?? config.modelId;

  if (modelProvider && modelId) {
    const model = modelRegistry.find(modelProvider, modelId);
    if (!model) {
      throw new Error(`Configured model not found: ${modelProvider}/${modelId}`);
    }
    return model;
  }
  if (modelProvider && modelId === undefined) {
    const available = modelRegistry.getAvailable().find((candidate) => candidate.provider === modelProvider);
    if (!available) {
      throw new Error(`No authenticated model available for provider: ${modelProvider}`);
    }
    return available;
  }
  return undefined;
}

function describeResolvedModel(
  config: AppConfig,
  modelRegistry: ModelRegistry,
  overrides?: { modelProvider?: string; modelId?: string }
): { model: ReturnType<typeof resolveConfiguredModel>; label: string } {
  const modelProvider = overrides?.modelProvider ?? config.modelProvider;
  const modelId = overrides?.modelId ?? config.modelId;
  const model = resolveConfiguredModel(config, modelRegistry, overrides);
  if (model) {
    return { model, label: `${model.provider}/${model.id}` };
  }
  if (modelRegistry.getAvailable().length === 0) {
    throw new Error("No authenticated models are available for the agent runtime");
  }
  if (modelProvider) {
    return { model: undefined, label: `${modelProvider}/${modelId ?? "*"} ${modelId ? "" : "(provider default)"}`.trim() };
  }
  return { model: undefined, label: "auto (runtime default)" };
}

function resolveSelectedCronSkills(
  workspaceRoot: string,
  conversationPaths: ReturnType<typeof getConversationPaths>,
  requestedNames: string[]
): { skills: Skill[]; missingSkillNames: string[] } {
  const available = loadWorkspaceAndConversationSkills(workspaceRoot, conversationPaths);
  if (requestedNames.length === 0) {
    return { skills: available, missingSkillNames: [] };
  }
  const availableByName = new Map<string, Skill>(available.map((skill) => [skill.name, skill]));
  const skills: Skill[] = [];
  const missingSkillNames: string[] = [];
  for (const name of requestedNames) {
    const skill = availableByName.get(name);
    if (skill) {
      skills.push(skill);
    } else {
      missingSkillNames.push(name);
    }
  }
  return { skills, missingSkillNames };
}

async function abortTimedOutSession(
  session: AgentSession,
  timeoutError: SelfAgentTimeoutError,
  logContext: Record<string, string | number | undefined>
): Promise<void> {
  try {
    await session.abort();
  } catch (error) {
    logger.warn("Failed to abort timed out session", {
      ...logContext,
      scope: timeoutError.scope,
      timeoutKind: timeoutError.kind,
      timeoutSeconds: timeoutError.timeoutSeconds,
      error
    });
  }
}

async function promptWithTimeouts(
  session: AgentSession,
  prompt: string,
  options: PromptTimeoutOptions
): Promise<void> {
  const startedAt = Date.now();
  let lastHeartbeatAt = startedAt;
  let settled = false;
  let interval: ReturnType<typeof setInterval> | undefined;

  const cleanup = (): void => {
    settled = true;
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
  };

  const monitorPromise = new Promise<never>((_resolve, reject) => {
    const triggerTimeout = (kind: "inactivity" | "hard", now: number, lastActivityAt: number): void => {
      if (settled) {
        return;
      }
      cleanup();
      const timeoutSeconds = kind === "inactivity" ? options.inactivityTimeoutSeconds : options.hardTimeoutSeconds ?? 0;
      const timeoutError = new SelfAgentTimeoutError(
        kind,
        options.scope,
        timeoutSeconds,
        Math.max(1, Math.ceil((now - startedAt) / 1000)),
        new Date(lastActivityAt).toISOString(),
        options.messageForKind(kind)
      );
      logger.warn("Agent run timed out", {
        ...options.logContext,
        scope: options.scope,
        label: options.label,
        timeoutKind: kind,
        timeoutSeconds,
        elapsedSeconds: timeoutError.elapsedSeconds,
        idleSeconds: Math.max(0, Math.floor((now - lastActivityAt) / 1000)),
        lastActivityAt: timeoutError.lastActivityAt
      });
      void abortTimedOutSession(session, timeoutError, options.logContext).finally(() => {
        reject(timeoutError);
      });
    };

    interval = setInterval(() => {
      if (settled) {
        cleanup();
        return;
      }
      const now = Date.now();
      const lastActivityAt = options.getLastActivityAt();
      if (now - lastHeartbeatAt >= PROMPT_TIMEOUT_HEARTBEAT_MS) {
        logger.debug("Agent run still waiting for activity", {
          ...options.logContext,
          scope: options.scope,
          label: options.label,
          elapsedSeconds: Math.floor((now - startedAt) / 1000),
          idleSeconds: Math.max(0, Math.floor((now - lastActivityAt) / 1000))
        });
        lastHeartbeatAt = now;
      }
      if (options.inactivityTimeoutSeconds > 0) {
        const inactivityMs = options.inactivityTimeoutSeconds * 1000;
        if (now - lastActivityAt >= inactivityMs) {
          triggerTimeout("inactivity", now, lastActivityAt);
          return;
        }
      }
      if (options.hardTimeoutSeconds && options.hardTimeoutSeconds > 0) {
        const hardTimeoutMs = options.hardTimeoutSeconds * 1000;
        if (now - startedAt >= hardTimeoutMs) {
          triggerTimeout("hard", now, lastActivityAt);
        }
      }
    }, PROMPT_TIMEOUT_POLL_MS);
  });

  try {
    await Promise.race([
      session.prompt(prompt).finally(() => {
        cleanup();
      }),
      monitorPromise
    ]);
  } finally {
    cleanup();
  }
}

export async function createConversationServices(
  config: AppConfig,
  conversation: ConversationRef,
  handlers: {
    sendAttachment: (filePath: string, title?: string) => Promise<void>;
    requestApproval: (summary: string, requestId: string) => Promise<void>;
  }
): Promise<ConversationServices> {
  await mkdir(config.agentDir, { recursive: true });
  const authStorage = AuthStorage.create(config.authFile);
  if (config.openAiApiKey) authStorage.setRuntimeApiKey("openai", config.openAiApiKey);
  if (config.anthropicApiKey) authStorage.setRuntimeApiKey("anthropic", config.anthropicApiKey);
  const modelRegistry = ModelRegistry.create(authStorage, config.modelsFile);
  logger.info("Created conversation services", {
    conversation: `${conversation.platform}:${conversation.chatId}:${conversation.threadId ?? "root"}`,
    authFile: config.authFile,
    modelsFile: config.modelsFile,
    availableModels: modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`)
  });
  return {
    config,
    authStorage,
    modelRegistry,
    sendAttachment: handlers.sendAttachment,
    requestApproval: handlers.requestApproval
  };
}

export async function runConversationTurn(
  services: ConversationServices,
  conversation: ConversationRef,
  userText: string,
  attachments: IncomingAttachment[],
  callbacks: ConversationTurnCallbacks = {}
): Promise<string> {
  const paths = getConversationPaths(services.config.stateRoot, conversation);
  await mkdir(paths.dir, { recursive: true });
  await mkdir(paths.attachmentsDir, { recursive: true });
  await mkdir(paths.scratchDir, { recursive: true });
  await mkdir(paths.skillsDir, { recursive: true });
  await mkdir(paths.sessionDir, { recursive: true });

  const memory = readMemory(services.config.workspaceRoot, paths);
  const skills = loadWorkspaceAndConversationSkills(services.config.workspaceRoot, paths);
  const recentCronDeliveries = formatRecentCronDeliveriesForPrompt(loadRecentCronDeliveries(paths));
  logger.info("Loaded conversation context", {
    conversationKey: paths.key,
    memoryChars: memory.length,
    skillCount: skills.length,
    attachmentCount: attachments.length,
    userTextChars: userText.length
  });
  const sessionManager = SessionManager.continueRecent(services.config.workspaceRoot, paths.sessionDir);
  const activeSessionFile = sessionManager.getSessionFile();
  const resourceLoader = buildResourceLoader(
    services.config,
    skills,
    buildTelegramPromptAppend(
      services.config.workspaceRoot,
      conversation,
      paths,
      memory,
      recentCronDeliveries,
      activeSessionFile
    )
  );
  await resourceLoader.reload();
  const approvalStore = new ApprovalStore(paths.approvalFile);

  const customTools: ToolDefinition[] = [
    createAttachTool(services),
    createComputerUseTool(conversation, services, approvalStore),
    createCronTaskTool(conversation, services)
  ];

  const resolved = describeResolvedModel(services.config, services.modelRegistry);
  logger.info("Starting agent turn", {
    conversationKey: paths.key,
    model: resolved.label,
    attachments: attachments.length,
    sessionFile: activeSessionFile
  });
  const { session } = await createAgentSession({
    cwd: services.config.workspaceRoot,
    agentDir: services.config.agentDir,
    authStorage: services.authStorage,
    modelRegistry: services.modelRegistry,
    model: resolved.model,
    thinkingLevel: services.config.thinkingLevel,
    sessionManager,
    resourceLoader,
    customTools
  });

  let streamedReply = "";
  let finalAssistantReply = "";
  let finalAssistantError = "";
  let finalAssistantStopReason = "";
  let actualModelLabel = "";
  let lastActivityAt = 0;
  let callbackQueue = Promise.resolve();
  let lastFinalCallbackText = "";
  const queueCallback = (name: "onTextDelta" | "onFinalText", value: string): void => {
    const callback = callbacks[name];
    if (!callback) return;
    callbackQueue = callbackQueue
      .then(async () => {
        await callback(value);
      })
      .catch((error) => {
        logger.warn("Conversation callback failed", {
          conversationKey: paths.key,
          callback: name,
          error
        });
      });
  };
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    lastActivityAt = Date.now();
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      streamedReply += event.assistantMessageEvent.delta;
      queueCallback("onTextDelta", event.assistantMessageEvent.delta);
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      finalAssistantReply = extractTextFromUnknownContent(event.message.content);
      const details = extractAssistantErrorDetails(event.message);
      finalAssistantError = details.errorMessage ?? "";
      finalAssistantStopReason = details.stopReason ?? "";
      actualModelLabel =
        details.provider && details.model ? `${details.provider}/${details.model}` : details.model ?? "";
      if (finalAssistantReply.trim()) {
        lastFinalCallbackText = finalAssistantReply;
        queueCallback("onFinalText", finalAssistantReply);
      }
    }
    if (event.type === "message_end") {
      const details = extractAssistantErrorDetails(event.message);
      logger.debug("Session message completed", {
        conversationKey: paths.key,
        role: event.message.role,
        extractedChars: extractTextFromUnknownContent(
          "content" in event.message ? (event.message as { content?: unknown }).content : undefined
        ).length,
        stopReason: details.stopReason,
        errorMessage: details.errorMessage,
        model: details.model,
        provider: details.provider
      });
    }
  });

  try {
    const prompt = buildUserPrompt(
      userText,
      attachments.map((attachment) => attachment.filePath)
    );
    logger.info("Prompting agent", {
      conversationKey: paths.key,
      promptChars: prompt.length
    });
    lastActivityAt = Date.now();
    await promptWithTimeouts(session, prompt, {
      scope: "interactive",
      label: paths.key,
      inactivityTimeoutSeconds: services.config.agentInactivityTimeoutSeconds,
      getLastActivityAt: () => lastActivityAt,
      messageForKind: () => "The model stopped responding before the request finished. Please try again.",
      logContext: {
        conversationKey: paths.key,
        requestedModel: resolved.label
      }
    });
    await callbackQueue;
    const extracted = extractLastAssistantText(session);
    if (!streamedReply.trim() && !finalAssistantReply.trim() && !extracted && finalAssistantError) {
      const modelText = actualModelLabel || resolved.label;
      throw new Error(`Model request failed for ${modelText}: ${finalAssistantError}`);
    }
    const reply = streamedReply.trim() || finalAssistantReply.trim() || extracted || "Done.";
    if (reply !== lastFinalCallbackText) {
      lastFinalCallbackText = reply;
      queueCallback("onFinalText", reply);
      await callbackQueue;
    }
    logger.info("Agent turn completed", {
      conversationKey: paths.key,
      requestedModel: resolved.label,
      actualModel: actualModelLabel || undefined,
      stopReason: finalAssistantStopReason || undefined,
      replyChars: reply.length,
      streamedChars: streamedReply.trim().length,
      finalChars: finalAssistantReply.trim().length,
      extractedChars: extracted.length,
      errorMessage: finalAssistantError || undefined
    });
    logger.debug("Session tail summary", {
      conversationKey: paths.key,
      tail: summarizeTailMessages(session)
    });
    return reply;
  } finally {
    unsubscribe();
    session.dispose();
    logger.debug("Disposed agent session", { conversationKey: paths.key });
  }
}

export async function runScheduledTask(
  services: ConversationServices,
  job: CronJob
): Promise<{
  runId: string;
  reply: string;
  summary: string;
  missingSkillNames: string[];
}> {
  const conversation: ConversationRef = {
    platform: "telegram",
    chatId: job.origin.chatId,
    threadId: job.origin.threadId,
    userId: job.origin.userId
  };
  const originPaths = getConversationPaths(services.config.stateRoot, conversation);
  const runId = createCronRunId();
  const runPaths = createCronRunPaths(services.config.stateRoot, job.id, runId);
  await mkdir(runPaths.dir, { recursive: true });
  await mkdir(runPaths.attachmentsDir, { recursive: true });
  await mkdir(runPaths.scratchDir, { recursive: true });

  const memory = readMemory(services.config.workspaceRoot, originPaths);
  const recentCronDeliveries = formatRecentCronDeliveriesForPrompt(loadRecentCronDeliveries(originPaths));
  const { skills, missingSkillNames } = resolveSelectedCronSkills(
    services.config.workspaceRoot,
    originPaths,
    job.skillNames
  );
  const resourceLoader = buildResourceLoader(
    services.config,
    skills,
    buildCronTaskPromptAppend({
      workspaceRoot: services.config.workspaceRoot,
      jobName: job.name,
      runDir: runPaths.dir,
      origin: conversation,
      memory,
      recentCronDeliveries,
      selectedSkills: job.skillNames
    })
  );
  await resourceLoader.reload();

  const sessionManager = SessionManager.create(services.config.workspaceRoot, runPaths.dir);
  const activeSessionFile = sessionManager.getSessionFile();

  const customTools: ToolDefinition[] = [createAttachTool(services)];
  const resolved = describeResolvedModel(services.config, services.modelRegistry, {
    modelProvider: job.modelProvider,
    modelId: job.modelId
  });
  logger.info("Starting scheduled task run", {
    jobId: job.id,
    runId,
    model: resolved.label,
    selectedSkills: job.skillNames,
    missingSkillNames,
    sessionFile: activeSessionFile
  });

  const { session } = await createAgentSession({
    cwd: services.config.workspaceRoot,
    agentDir: services.config.agentDir,
    authStorage: services.authStorage,
    modelRegistry: services.modelRegistry,
    model: resolved.model,
    thinkingLevel: services.config.thinkingLevel,
    sessionManager,
    resourceLoader,
    customTools
  });

  let streamedReply = "";
  let finalAssistantReply = "";
  let finalAssistantError = "";
  let finalAssistantStopReason = "";
  let actualModelLabel = "";
  let lastActivityAt = 0;

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    lastActivityAt = Date.now();
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      streamedReply += event.assistantMessageEvent.delta;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      finalAssistantReply = extractTextFromUnknownContent(event.message.content);
      const details = extractAssistantErrorDetails(event.message);
      finalAssistantError = details.errorMessage ?? "";
      finalAssistantStopReason = details.stopReason ?? "";
      actualModelLabel =
        details.provider && details.model ? `${details.provider}/${details.model}` : details.model ?? "";
    }
  });

  try {
    const prompt = missingSkillNames.length > 0
      ? `Requested skills missing: ${missingSkillNames.join(", ")}\n\n${job.prompt}`
      : job.prompt;
    lastActivityAt = Date.now();
    await promptWithTimeouts(session, prompt.trim(), {
      scope: "cron",
      label: `${job.id}:${runId}`,
      inactivityTimeoutSeconds: services.config.cronInactivityTimeoutSeconds,
      hardTimeoutSeconds: services.config.cronHardTimeoutSeconds,
      getLastActivityAt: () => lastActivityAt,
      messageForKind: (kind) =>
        kind === "hard"
          ? `Scheduled task "${job.name}" exceeded the maximum execution time and was aborted.`
          : `Scheduled task "${job.name}" timed out because the model stopped responding.`,
      logContext: {
        jobId: job.id,
        jobName: job.name,
        runId,
        requestedModel: resolved.label
      }
    });
    const extracted = extractLastAssistantText(session);
    if (!streamedReply.trim() && !finalAssistantReply.trim() && !extracted && finalAssistantError) {
      const modelText = actualModelLabel || resolved.label;
      throw new Error(`Model request failed for ${modelText}: ${finalAssistantError}`);
    }
    const reply = streamedReply.trim() || finalAssistantReply.trim() || extracted || "Done.";
    logger.info("Scheduled task run completed", {
      jobId: job.id,
      runId,
      requestedModel: resolved.label,
      actualModel: actualModelLabel || undefined,
      stopReason: finalAssistantStopReason || undefined,
      replyChars: reply.length,
      missingSkillNames
    });
    return {
      runId,
      reply,
      summary: summarizeCronResult(reply),
      missingSkillNames
    };
  } finally {
    unsubscribe();
    session.dispose();
  }
}
