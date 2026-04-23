import { resolve } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { LogLevel } from "./logger.js";
import type { ChannelProfile, ModelProfile, RootConfigFile } from "./state.js";
import { loadChannelProfilesFile, loadModelProfilesFile, loadRootConfigFile } from "./state.js";

export interface AppConfig {
  configFile: string;
  channelsFile: string;
  modelProfilesFile: string;
  channelAccessFile: string;
  channel?: "telegram";
  telegramBotToken?: string;
  workspaceRoot: string;
  stateRoot: string;
  agentDir: string;
  authFile: string;
  modelsFile: string;
  rootConfig: RootConfigFile;
  channelProfiles: Record<string, ChannelProfile>;
  modelProfiles: Record<string, ModelProfile>;
  defaultChannelProfileId?: string;
  defaultModelProfileId?: string;
  selectedChannelProfile?: ChannelProfile;
  selectedModelProfile?: ModelProfile;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  openAiApiKey?: string;
  anthropicApiKey?: string;
  logLevel: LogLevel;
  logFile?: string;
  logMaxBytes: number;
  logMaxFiles: number;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error"
  ) {
    return normalized;
  }
  return "info";
}

function parseThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported SELFAGENT_THINKING_LEVEL: ${value}`);
}

function parsePositiveInteger(value: string | number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

export function loadConfig(): AppConfig {
  const workspaceRoot = resolve(optionalEnv("SELFAGENT_WORKSPACE_ROOT") ?? process.cwd());
  const stateRoot = resolve(optionalEnv("SELFAGENT_STATE_DIR") ?? `${workspaceRoot}/.selfagent`);
  const configFile = resolve(optionalEnv("SELFAGENT_CONFIG_FILE") ?? `${stateRoot}/config.json`);
  const channelsFile = resolve(optionalEnv("SELFAGENT_CHANNELS_FILE") ?? `${stateRoot}/channels.json`);
  const modelProfilesFile = resolve(optionalEnv("SELFAGENT_MODEL_PROFILES_FILE") ?? `${stateRoot}/models.json`);
  const channelAccessFile = resolve(optionalEnv("SELFAGENT_CHANNEL_ACCESS_FILE") ?? `${stateRoot}/channel-access.json`);
  const agentDir = resolve(optionalEnv("SELFAGENT_AGENT_DIR") ?? `${stateRoot}/agent`);
  const authFile = resolve(optionalEnv("SELFAGENT_AUTH_FILE") ?? `${agentDir}/auth.json`);
  const modelsFile = resolve(optionalEnv("SELFAGENT_MODELS_FILE") ?? `${agentDir}/models.json`);
  const rootConfig = loadRootConfigFile(configFile);
  const channelProfiles = loadChannelProfilesFile(channelsFile).profiles;
  const modelProfiles = loadModelProfilesFile(modelProfilesFile).profiles;
  const defaultChannelProfileId = rootConfig.defaultChannelProfileId;
  const defaultModelProfileId = rootConfig.defaultModelProfileId;
  const selectedChannelProfile = defaultChannelProfileId ? channelProfiles[defaultChannelProfileId] : undefined;
  const selectedModelProfile = defaultModelProfileId ? modelProfiles[defaultModelProfileId] : undefined;
  const telegramBotToken =
    optionalEnv("TELEGRAM_BOT_TOKEN") ??
    (selectedChannelProfile?.kind === "telegram"
      ? selectedChannelProfile.telegramBotToken
      : rootConfig.telegramBotToken);
  const derivedChannel = selectedChannelProfile?.kind ?? rootConfig.channel;
  const derivedModelProvider =
    optionalEnv("SELFAGENT_MODEL_PROVIDER") ?? selectedModelProfile?.provider ?? rootConfig.modelProvider;
  const derivedModelId = optionalEnv("SELFAGENT_MODEL_ID") ?? selectedModelProfile?.modelId ?? rootConfig.modelId;

  return {
    configFile,
    channelsFile,
    modelProfilesFile,
    channelAccessFile,
    channel: derivedChannel,
    telegramBotToken,
    workspaceRoot,
    stateRoot,
    agentDir,
    authFile,
    modelsFile,
    rootConfig,
    channelProfiles,
    modelProfiles,
    defaultChannelProfileId,
    defaultModelProfileId,
    selectedChannelProfile,
    selectedModelProfile,
    modelProvider: derivedModelProvider,
    modelId: derivedModelId,
    thinkingLevel: parseThinkingLevel(optionalEnv("SELFAGENT_THINKING_LEVEL")) ?? rootConfig.thinkingLevel,
    openAiApiKey: optionalEnv("SELFAGENT_OPENAI_API_KEY"),
    anthropicApiKey: optionalEnv("SELFAGENT_ANTHROPIC_API_KEY"),
    logLevel: parseLogLevel(optionalEnv("SELFAGENT_LOG_LEVEL") ?? rootConfig.logLevel),
    logFile: optionalEnv("SELFAGENT_LOG_FILE") ?? rootConfig.logFile,
    logMaxBytes: parsePositiveInteger(optionalEnv("SELFAGENT_LOG_MAX_BYTES") ?? rootConfig.logMaxBytes, 10 * 1024 * 1024),
    logMaxFiles: parsePositiveInteger(optionalEnv("SELFAGENT_LOG_MAX_FILES") ?? rootConfig.logMaxFiles, 5)
  };
}
