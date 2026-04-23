import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { LogLevel } from "./logger.js";

export interface RootConfigFile {
  defaultChannelProfileId?: string;
  defaultModelProfileId?: string;
  thinkingLevel?: ThinkingLevel;
  logLevel?: LogLevel;
  logFile?: string;
  logMaxBytes?: number;
  logMaxFiles?: number;

  // Legacy compatibility fields
  channel?: "telegram";
  telegramBotToken?: string;
  modelProvider?: string;
  modelId?: string;
}

export interface TelegramChannelProfile {
  kind: "telegram";
  telegramBotToken: string;
  whitelistEnabled?: boolean;
  allowedUserIds?: number[];
  createdAt: string;
}

export type ChannelProfile = TelegramChannelProfile;

export interface ChannelProfilesFile {
  profiles: Record<string, ChannelProfile>;
}

export interface TelegramAuthorizationRequest {
  profileId: string;
  code: string;
  createdAt: string;
  expiresAt: string;
}

export interface ChannelAccessFile {
  telegramAuthorization?: TelegramAuthorizationRequest;
}

interface BaseModelProfile {
  modelId: string;
  createdAt: string;
}

export interface ApiKeyModelProfile extends BaseModelProfile {
  authMode: "apiKey";
  provider: "openai" | "anthropic" | "minimax-cn";
  apiKey: string;
  baseUrl?: string;
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  authHeader?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

export interface OAuthModelProfile extends BaseModelProfile {
  authMode: "oauth";
  provider: "openai-codex";
}

export type ModelProfile = ApiKeyModelProfile | OAuthModelProfile;

export interface ModelProfilesFile {
  profiles: Record<string, ModelProfile>;
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function ensureDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export function loadRootConfigFile(filePath: string): RootConfigFile {
  return readJsonFile<RootConfigFile>(filePath, {});
}

export function loadChannelProfilesFile(filePath: string): ChannelProfilesFile {
  const parsed = readJsonFile<ChannelProfilesFile>(filePath, { profiles: {} });
  return {
    profiles: parsed.profiles ?? {}
  };
}

export function loadModelProfilesFile(filePath: string): ModelProfilesFile {
  const parsed = readJsonFile<ModelProfilesFile>(filePath, { profiles: {} });
  return {
    profiles: parsed.profiles ?? {}
  };
}

export function loadChannelAccessFile(filePath: string): ChannelAccessFile {
  return readJsonFile<ChannelAccessFile>(filePath, {});
}

export async function saveRootConfigFile(filePath: string, config: RootConfigFile): Promise<void> {
  await ensureDirectory(filePath);
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function saveChannelProfilesFile(filePath: string, config: ChannelProfilesFile): Promise<void> {
  await ensureDirectory(filePath);
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function saveModelProfilesFile(filePath: string, config: ModelProfilesFile): Promise<void> {
  await ensureDirectory(filePath);
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function saveChannelAccessFile(filePath: string, config: ChannelAccessFile): Promise<void> {
  await ensureDirectory(filePath);
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
