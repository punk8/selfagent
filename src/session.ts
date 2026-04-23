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
import type { AppConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { readMemory } from "./memory.js";
import { getConversationPaths } from "./paths.js";
import { loadWorkspaceAndConversationSkills } from "./skills.js";
import { buildTelegramPromptAppend, buildUserPrompt } from "./system-prompt.js";
import type { ComputerUseRequest, ConversationRef, IncomingAttachment } from "./types.js";

const logger = createLogger("session");

export interface ConversationServices {
  config: AppConfig;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  sendAttachment: (filePath: string, title?: string) => Promise<void>;
  requestApproval: (summary: string, requestId: string) => Promise<void>;
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

function buildResourceLoader(
  config: AppConfig,
  conversation: ConversationRef,
  memory: string,
  skills: Skill[]
): DefaultResourceLoader {
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
      const conversationPaths = getConversationPaths(config.stateRoot, conversation);
      return [...base, buildTelegramPromptAppend(config.workspaceRoot, conversation, conversationPaths, memory)];
    }
  });
}

function resolveConfiguredModel(config: AppConfig, modelRegistry: ModelRegistry) {
  if (config.modelProvider && config.modelId) {
    const model = modelRegistry.find(config.modelProvider, config.modelId);
    if (!model) {
      throw new Error(`Configured model not found: ${config.modelProvider}/${config.modelId}`);
    }
    return model;
  }
  if (config.modelProvider && config.modelId === undefined) {
    const available = modelRegistry.getAvailable().find((candidate) => candidate.provider === config.modelProvider);
    if (!available) {
      throw new Error(`No authenticated model available for provider: ${config.modelProvider}`);
    }
    return available;
  }
  return undefined;
}

function describeResolvedModel(
  config: AppConfig,
  modelRegistry: ModelRegistry
): { model: ReturnType<typeof resolveConfiguredModel>; label: string } {
  const model = resolveConfiguredModel(config, modelRegistry);
  if (model) {
    return { model, label: `${model.provider}/${model.id}` };
  }
  if (modelRegistry.getAvailable().length === 0) {
    throw new Error("No authenticated models are available for the agent runtime");
  }
  if (config.modelProvider) {
    return { model: undefined, label: `${config.modelProvider}/* (provider default)` };
  }
  return { model: undefined, label: "auto (runtime default)" };
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
  attachments: IncomingAttachment[]
): Promise<string> {
  const paths = getConversationPaths(services.config.stateRoot, conversation);
  await mkdir(paths.dir, { recursive: true });
  await mkdir(paths.attachmentsDir, { recursive: true });
  await mkdir(paths.scratchDir, { recursive: true });
  await mkdir(paths.skillsDir, { recursive: true });

  const memory = readMemory(services.config.workspaceRoot, paths);
  const skills = loadWorkspaceAndConversationSkills(services.config.workspaceRoot, paths);
  logger.info("Loaded conversation context", {
    conversationKey: paths.key,
    memoryChars: memory.length,
    skillCount: skills.length,
    attachmentCount: attachments.length,
    userTextChars: userText.length
  });
  const resourceLoader = buildResourceLoader(services.config, conversation, memory, skills);
  await resourceLoader.reload();

  const sessionManager =
    await exists(paths.sessionFile) ? SessionManager.open(paths.sessionFile, paths.dir, services.config.workspaceRoot) : SessionManager.create(services.config.workspaceRoot, paths.dir);
  const approvalStore = new ApprovalStore(paths.approvalFile);

  const customTools: ToolDefinition[] = [
    createAttachTool(services),
    createComputerUseTool(conversation, services, approvalStore)
  ];

  const resolved = describeResolvedModel(services.config, services.modelRegistry);
  logger.info("Starting agent turn", {
    conversationKey: paths.key,
    model: resolved.label,
    attachments: attachments.length,
    sessionFile: paths.sessionFile
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
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
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
    await session.prompt(prompt);
    const extracted = extractLastAssistantText(session);
    if (!streamedReply.trim() && !finalAssistantReply.trim() && !extracted && finalAssistantError) {
      const modelText = actualModelLabel || resolved.label;
      throw new Error(`Model request failed for ${modelText}: ${finalAssistantError}`);
    }
    const reply = streamedReply.trim() || finalAssistantReply.trim() || extracted || "Done.";
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

async function exists(path: string): Promise<boolean> {
  try {
    await import("node:fs/promises").then(({ access }) => access(path));
    return true;
  } catch {
    return false;
  }
}
