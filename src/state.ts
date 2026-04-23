import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

interface PersistedStateFile {
  root: RootConfigFile;
  channels: ChannelProfilesFile;
  models: ModelProfilesFile;
  channelAccess: ChannelAccessFile;
}

type TomlValue = string | number | boolean | TomlValue[];

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

function createEmptyState(): PersistedStateFile {
  return {
    root: {},
    channels: { profiles: {} },
    models: { profiles: {} },
    channelAccess: {}
  };
}

function stripTomlComment(line: string): string {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (char === "#" && !inString) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseTomlPath(path: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < path.length; index += 1) {
    const char = path[index];
    if (inString) {
      if (escaped) {
        current += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        current += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === ".") {
      segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim() || path.endsWith('""')) {
    segments.push(current.trim());
  }
  return segments.filter(Boolean);
}

function splitTomlKeyValue(line: string): { key: string; value: string } | undefined {
  let inString = false;
  let escaped = false;
  let depth = 0;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[") {
      depth += 1;
      continue;
    }
    if (char === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === "=" && depth === 0) {
      return {
        key: line.slice(0, index).trim(),
        value: line.slice(index + 1).trim()
      };
    }
  }

  return undefined;
}

function splitTomlArrayItems(raw: string): string[] {
  const items: string[] = [];
  let current = "";
  let inString = false;
  let escaped = false;
  let depth = 0;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      current += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      current += char;
      continue;
    }
    if (char === "[") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === "]") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      if (current.trim()) {
        items.push(current.trim());
      }
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) {
    items.push(current.trim());
  }
  return items;
}

function parseTomlValue(raw: string): TomlValue {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed) as string;
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return splitTomlArrayItems(inner).map((item) => parseTomlValue(item));
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

function assignTomlPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let current: Record<string, unknown> = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const next = current[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[path[path.length - 1]!] = value;
}

function parseTomlDocument(content: string): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  let currentPath: string[] = [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      currentPath = parseTomlPath(line.slice(1, -1).trim());
      assignTomlPath(document, currentPath, {});
      continue;
    }

    const entry = splitTomlKeyValue(line);
    if (!entry) {
      continue;
    }
    assignTomlPath(document, [...currentPath, entry.key], parseTomlValue(entry.value));
  }

  return document;
}

function formatTomlValue(value: TomlValue): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "0";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return `[${value.map((item) => formatTomlValue(item)).join(", ")}]`;
}

function quoteTomlPathSegment(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment);
}

function formatSection(name: string, values: Record<string, unknown>): string[] {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return [];
  }
  return [
    `[${name}]`,
    ...entries.map(([key, value]) => `${key} = ${formatTomlValue(value as TomlValue)}`),
    ""
  ];
}

function serializeTomlState(state: PersistedStateFile): string {
  const lines: string[] = [
    "# SelfAgent configuration",
    "# This file is managed by the CLI.",
    ""
  ];

  lines.push(...formatSection("root", state.root as Record<string, unknown>));

  const authorization = state.channelAccess.telegramAuthorization;
  if (authorization) {
    lines.push(
      ...formatSection(
        "channelAccess.telegramAuthorization",
        authorization as unknown as Record<string, unknown>
      )
    );
  }

  for (const profileId of Object.keys(state.channels.profiles).sort()) {
    lines.push(
      ...formatSection(
        `channels.${quoteTomlPathSegment(profileId)}`,
        state.channels.profiles[profileId] as unknown as Record<string, unknown>
      )
    );
  }

  for (const profileId of Object.keys(state.models.profiles).sort()) {
    lines.push(
      ...formatSection(
        `models.${quoteTomlPathSegment(profileId)}`,
        state.models.profiles[profileId] as unknown as Record<string, unknown>
      )
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function normalizeRootConfig(value: unknown): RootConfigFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const candidate = value as Record<string, unknown>;
  return {
    defaultChannelProfileId:
      typeof candidate.defaultChannelProfileId === "string" ? candidate.defaultChannelProfileId : undefined,
    defaultModelProfileId:
      typeof candidate.defaultModelProfileId === "string" ? candidate.defaultModelProfileId : undefined,
    thinkingLevel: typeof candidate.thinkingLevel === "string" ? (candidate.thinkingLevel as ThinkingLevel) : undefined,
    logLevel: typeof candidate.logLevel === "string" ? (candidate.logLevel as LogLevel) : undefined,
    logFile: typeof candidate.logFile === "string" ? candidate.logFile : undefined,
    logMaxBytes: typeof candidate.logMaxBytes === "number" ? candidate.logMaxBytes : undefined,
    logMaxFiles: typeof candidate.logMaxFiles === "number" ? candidate.logMaxFiles : undefined,
    channel: candidate.channel === "telegram" ? "telegram" : undefined,
    telegramBotToken: typeof candidate.telegramBotToken === "string" ? candidate.telegramBotToken : undefined,
    modelProvider: typeof candidate.modelProvider === "string" ? candidate.modelProvider : undefined,
    modelId: typeof candidate.modelId === "string" ? candidate.modelId : undefined
  };
}

function normalizeChannelProfiles(value: unknown): ChannelProfilesFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { profiles: {} };
  }

  const profiles: Record<string, ChannelProfile> = {};
  for (const [profileId, rawProfile] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawProfile !== "object" || rawProfile === null || Array.isArray(rawProfile)) {
      continue;
    }
    const profile = rawProfile as Record<string, unknown>;
    if (profile.kind !== "telegram" || typeof profile.telegramBotToken !== "string" || typeof profile.createdAt !== "string") {
      continue;
    }
    profiles[profileId] = {
      kind: "telegram",
      telegramBotToken: profile.telegramBotToken,
      whitelistEnabled: typeof profile.whitelistEnabled === "boolean" ? profile.whitelistEnabled : undefined,
      allowedUserIds: Array.isArray(profile.allowedUserIds)
        ? profile.allowedUserIds.filter((item): item is number => typeof item === "number")
        : undefined,
      createdAt: profile.createdAt
    };
  }

  return { profiles };
}

function normalizeModelProfiles(value: unknown): ModelProfilesFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { profiles: {} };
  }

  const profiles: Record<string, ModelProfile> = {};
  for (const [profileId, rawProfile] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawProfile !== "object" || rawProfile === null || Array.isArray(rawProfile)) {
      continue;
    }
    const profile = rawProfile as Record<string, unknown>;
    if (profile.authMode === "oauth" && profile.provider === "openai-codex" && typeof profile.modelId === "string" && typeof profile.createdAt === "string") {
      profiles[profileId] = {
        authMode: "oauth",
        provider: "openai-codex",
        modelId: profile.modelId,
        createdAt: profile.createdAt
      };
      continue;
    }
    if (
      profile.authMode === "apiKey" &&
      (profile.provider === "openai" || profile.provider === "anthropic" || profile.provider === "minimax-cn") &&
      typeof profile.modelId === "string" &&
      typeof profile.apiKey === "string" &&
      typeof profile.createdAt === "string"
    ) {
      profiles[profileId] = {
        authMode: "apiKey",
        provider: profile.provider,
        modelId: profile.modelId,
        apiKey: profile.apiKey,
        createdAt: profile.createdAt,
        baseUrl: typeof profile.baseUrl === "string" ? profile.baseUrl : undefined,
        api: typeof profile.api === "string" ? (profile.api as ApiKeyModelProfile["api"]) : undefined,
        authHeader: typeof profile.authHeader === "boolean" ? profile.authHeader : undefined,
        contextWindow: typeof profile.contextWindow === "number" ? profile.contextWindow : undefined,
        maxTokens: typeof profile.maxTokens === "number" ? profile.maxTokens : undefined,
        reasoning: typeof profile.reasoning === "boolean" ? profile.reasoning : undefined
      };
    }
  }

  return { profiles };
}

function normalizeChannelAccess(value: unknown): ChannelAccessFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const candidate = value as Record<string, unknown>;
  const authorization = candidate.telegramAuthorization;
  if (typeof authorization !== "object" || authorization === null || Array.isArray(authorization)) {
    return {};
  }
  const request = authorization as Record<string, unknown>;
  if (
    typeof request.profileId !== "string" ||
    typeof request.code !== "string" ||
    typeof request.createdAt !== "string" ||
    typeof request.expiresAt !== "string"
  ) {
    return {};
  }
  return {
    telegramAuthorization: {
      profileId: request.profileId,
      code: request.code,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt
    }
  };
}

function loadLegacyState(filePath: string): PersistedStateFile {
  const stateDir = dirname(filePath);
  return {
    root: readJsonFile<RootConfigFile>(resolve(stateDir, "config.json"), {}),
    channels: readJsonFile<ChannelProfilesFile>(resolve(stateDir, "channels.json"), { profiles: {} }),
    models: readJsonFile<ModelProfilesFile>(resolve(stateDir, "models.json"), { profiles: {} }),
    channelAccess: readJsonFile<ChannelAccessFile>(resolve(stateDir, "channel-access.json"), {})
  };
}

function loadPersistedState(filePath: string): PersistedStateFile {
  if (!existsSync(filePath)) {
    return loadLegacyState(filePath);
  }

  try {
    const parsed = parseTomlDocument(readFileSync(filePath, "utf8"));
    return {
      root: normalizeRootConfig(parsed.root),
      channels: normalizeChannelProfiles(parsed.channels),
      models: normalizeModelProfiles(parsed.models),
      channelAccess: normalizeChannelAccess(parsed.channelAccess)
    };
  } catch {
    return createEmptyState();
  }
}

async function savePersistedState(filePath: string, nextState: PersistedStateFile): Promise<void> {
  await ensureDirectory(filePath);
  await writeFile(filePath, serializeTomlState(nextState), "utf8");
}

export function loadRootConfigFile(filePath: string): RootConfigFile {
  return loadPersistedState(filePath).root;
}

export function loadChannelProfilesFile(filePath: string): ChannelProfilesFile {
  return loadPersistedState(filePath).channels;
}

export function loadModelProfilesFile(filePath: string): ModelProfilesFile {
  return loadPersistedState(filePath).models;
}

export function loadChannelAccessFile(filePath: string): ChannelAccessFile {
  return loadPersistedState(filePath).channelAccess;
}

export async function saveRootConfigFile(filePath: string, config: RootConfigFile): Promise<void> {
  const state = loadPersistedState(filePath);
  state.root = config;
  await savePersistedState(filePath, state);
}

export async function saveChannelProfilesFile(filePath: string, config: ChannelProfilesFile): Promise<void> {
  const state = loadPersistedState(filePath);
  state.channels = {
    profiles: config.profiles ?? {}
  };
  await savePersistedState(filePath, state);
}

export async function saveModelProfilesFile(filePath: string, config: ModelProfilesFile): Promise<void> {
  const state = loadPersistedState(filePath);
  state.models = {
    profiles: config.profiles ?? {}
  };
  await savePersistedState(filePath, state);
}

export async function saveChannelAccessFile(filePath: string, config: ChannelAccessFile): Promise<void> {
  const state = loadPersistedState(filePath);
  state.channelAccess = config;
  await savePersistedState(filePath, state);
}
