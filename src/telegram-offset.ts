import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const STORE_VERSION = 1;

interface TelegramUpdateOffsetFile {
  version: 1;
  lastUpdateId: number | null;
  botId: string | null;
}

function isValidUpdateId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function extractTelegramBotId(token: string): string | null {
  const [botId] = token.trim().split(":", 1);
  return botId && /^\d+$/.test(botId) ? botId : null;
}

export function getTelegramUpdateOffsetFile(stateRoot: string): string {
  return resolve(stateRoot, "telegram", "update-offset.json");
}

function parseOffsetFile(raw: string): TelegramUpdateOffsetFile | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<TelegramUpdateOffsetFile>;
    if (parsed.version !== STORE_VERSION) {
      return undefined;
    }
    if (parsed.lastUpdateId !== null && !isValidUpdateId(parsed.lastUpdateId)) {
      return undefined;
    }
    if (parsed.botId !== null && typeof parsed.botId !== "string") {
      return undefined;
    }
    return {
      version: STORE_VERSION,
      lastUpdateId: parsed.lastUpdateId ?? null,
      botId: parsed.botId ?? null
    };
  } catch {
    return undefined;
  }
}

export function readTelegramUpdateOffset(stateRoot: string, token: string): number | null {
  const filePath = getTelegramUpdateOffsetFile(stateRoot);
  if (!existsSync(filePath)) {
    return null;
  }
  const parsed = parseOffsetFile(readFileSync(filePath, "utf8"));
  if (!parsed) {
    return null;
  }
  const currentBotId = extractTelegramBotId(token);
  if (currentBotId && parsed.botId && parsed.botId !== currentBotId) {
    return null;
  }
  if (currentBotId && parsed.botId === null) {
    return null;
  }
  return parsed.lastUpdateId;
}

export async function writeTelegramUpdateOffset(
  stateRoot: string,
  token: string,
  updateId: number
): Promise<void> {
  if (!isValidUpdateId(updateId)) {
    throw new Error("Telegram update offset must be a non-negative safe integer");
  }
  const filePath = getTelegramUpdateOffsetFile(stateRoot);
  await mkdir(dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const payload: TelegramUpdateOffsetFile = {
    version: STORE_VERSION,
    lastUpdateId: updateId,
    botId: extractTelegramBotId(token)
  };
  await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempFile, filePath);
}
