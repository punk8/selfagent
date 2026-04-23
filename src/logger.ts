import { appendFile, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

interface LoggerConfig {
  level: LogLevel;
  filePath?: string;
  maxBytes: number;
  maxFiles: number;
}

interface LogFields {
  [key: string]: unknown;
}

const loggerConfig: LoggerConfig = {
  level: "info",
  maxBytes: 10 * 1024 * 1024,
  maxFiles: 5
};

let fileWriteQueue = Promise.resolve();

function normalizeLevel(value: string | undefined): LogLevel {
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

export function configureLogger(next: { level?: string; filePath?: string; maxBytes?: number; maxFiles?: number }): void {
  loggerConfig.level = normalizeLevel(next.level);
  loggerConfig.filePath = next.filePath?.trim() ? next.filePath : undefined;
  loggerConfig.maxBytes = typeof next.maxBytes === "number" && next.maxBytes > 0 ? next.maxBytes : loggerConfig.maxBytes;
  loggerConfig.maxFiles = typeof next.maxFiles === "number" && next.maxFiles > 0 ? Math.max(1, Math.floor(next.maxFiles)) : loggerConfig.maxFiles;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[loggerConfig.level];
}

function serializeFields(fields: LogFields | undefined): string {
  if (!fields) {
    return "";
  }
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return "";
  }
  return entries
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  if (value instanceof Error) {
    return JSON.stringify({
      name: value.name,
      message: value.message,
      stack: value.stack
    });
  }
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

async function writeToFile(line: string): Promise<void> {
  if (!loggerConfig.filePath) {
    return;
  }
  fileWriteQueue = fileWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const filePath = loggerConfig.filePath!;
      await mkdir(dirname(filePath), { recursive: true });
      await rotateIfNeeded(filePath, Buffer.byteLength(line, "utf8"));
      await appendFile(filePath, line, "utf8");
    });
  await fileWriteQueue;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function rotateIfNeeded(filePath: string, incomingBytes: number): Promise<void> {
  if (!(await pathExists(filePath))) {
    return;
  }
  const currentStat = await stat(filePath);
  if (currentStat.size + incomingBytes <= loggerConfig.maxBytes) {
    return;
  }

  const archiveCount = Math.max(0, loggerConfig.maxFiles - 1);
  if (archiveCount === 0) {
    await writeFile(filePath, "", "utf8");
    return;
  }

  const lastArchive = `${filePath}.${archiveCount}`;
  if (await pathExists(lastArchive)) {
    await unlink(lastArchive);
  }

  for (let index = archiveCount; index >= 1; index -= 1) {
    const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
    const target = `${filePath}.${index}`;
    if (await pathExists(source)) {
      await rename(source, target);
    }
  }
}

function emit(level: LogLevel, scope: string, message: string, fields?: LogFields): void {
  if (!shouldLog(level)) {
    return;
  }
  const timestamp = new Date().toISOString();
  const suffix = serializeFields(fields);
  const line = `${timestamp} ${level.toUpperCase()} [${scope}] ${message}${suffix ? ` ${suffix}` : ""}\n`;
  if (level === "error") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
  void writeToFile(line);
}

export function createLogger(scope: string) {
  return {
    debug(message: string, fields?: LogFields): void {
      emit("debug", scope, message, fields);
    },
    info(message: string, fields?: LogFields): void {
      emit("info", scope, message, fields);
    },
    warn(message: string, fields?: LogFields): void {
      emit("warn", scope, message, fields);
    },
    error(message: string, fields?: LogFields): void {
      emit("error", scope, message, fields);
    }
  };
}
