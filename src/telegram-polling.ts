import { GrammyError, HttpError } from "grammy";
import type { Update } from "grammy/types";
import type { AppConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { TelegramAdapter } from "./telegram.js";
import { readTelegramUpdateOffset, writeTelegramUpdateOffset } from "./telegram-offset.js";

const logger = createLogger("telegram-polling");
const GET_UPDATES_LIMIT = 100;
const OFFSET_CONFIRMATION_TIMEOUT_SECONDS = 10;
const RESTART_BACKOFF_INITIAL_MS = 2_000;
const RESTART_BACKOFF_MAX_MS = 30_000;
const RESTART_BACKOFF_FACTOR = 1.8;
const RESTART_BACKOFF_JITTER = 0.25;
const ALLOWED_UPDATES = ["message", "callback_query"] as const;

type TelegramAdapterFactory = () => TelegramAdapter;
type TelegramApiAbortSignal = Parameters<TelegramAdapter["bot"]["api"]["getUpdates"]>[1];

interface TelegramPollingOptions {
  config: AppConfig;
  token: string;
  createAdapter: TelegramAdapterFactory;
  registerHandlers: (adapter: TelegramAdapter) => void;
  onAdapterReady?: (adapter: TelegramAdapter) => void | Promise<void>;
}

class TelegramPollingCycleError extends Error {
  constructor(
    readonly kind: "stall" | "request-timeout",
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "TelegramPollingCycleError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function computeBackoffMs(attempt: number): number {
  const base = Math.min(
    RESTART_BACKOFF_MAX_MS,
    RESTART_BACKOFF_INITIAL_MS * RESTART_BACKOFF_FACTOR ** Math.max(0, attempt - 1)
  );
  const jitterRange = base * RESTART_BACKOFF_JITTER;
  const jitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.floor(base + jitter));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function collectErrorCandidates(error: unknown, seen = new Set<unknown>()): unknown[] {
  if (!error || typeof error !== "object" || seen.has(error)) {
    return [error];
  }
  seen.add(error);
  const candidates: unknown[] = [error];
  const record = error as {
    cause?: unknown;
    error?: unknown;
    reason?: unknown;
    errors?: unknown;
  };
  for (const nested of [record.cause, record.error, record.reason]) {
    if (nested) {
      candidates.push(...collectErrorCandidates(nested, seen));
    }
  }
  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) {
      candidates.push(...collectErrorCandidates(nested, seen));
    }
  }
  return candidates;
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as { code?: unknown; errno?: unknown };
  if (typeof record.code === "string") {
    return record.code.toUpperCase();
  }
  if (typeof record.errno === "string") {
    return record.errno.toUpperCase();
  }
  if (typeof record.errno === "number") {
    return String(record.errno);
  }
  return undefined;
}

function getErrorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function isGetUpdatesConflict(error: unknown): boolean {
  for (const candidate of collectErrorCandidates(error)) {
    if (candidate instanceof GrammyError && candidate.error_code === 409) {
      const haystack = `${candidate.method} ${candidate.description} ${candidate.message}`.toLowerCase();
      return haystack.includes("getupdates");
    }
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const record = candidate as {
      error_code?: unknown;
      errorCode?: unknown;
      method?: unknown;
      description?: unknown;
      message?: unknown;
    };
    const errorCode = record.error_code ?? record.errorCode;
    if (errorCode !== 409) {
      continue;
    }
    const haystack = [record.method, record.description, record.message]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase();
    if (haystack.includes("getupdates")) {
      return true;
    }
  }
  return false;
}

function getTelegramRetryAfterSeconds(error: unknown): number | undefined {
  for (const candidate of collectErrorCandidates(error)) {
    if (candidate instanceof GrammyError) {
      const retryAfter = candidate.parameters.retry_after;
      if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
        return retryAfter;
      }
    }
  }
  return undefined;
}

function isRecoverablePollingError(error: unknown): boolean {
  if (error instanceof TelegramPollingCycleError) {
    return true;
  }
  for (const candidate of collectErrorCandidates(error)) {
    if (candidate instanceof GrammyError) {
      if (candidate.error_code === 429 || candidate.error_code >= 500) {
        return true;
      }
      continue;
    }
    if (candidate instanceof HttpError) {
      return true;
    }
    const code = getErrorCode(candidate);
    if (
      code &&
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "EPIPE",
        "ETIMEDOUT",
        "ESOCKETTIMEDOUT",
        "ENETUNREACH",
        "EHOSTUNREACH",
        "ENOTFOUND",
        "EAI_AGAIN",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
        "UND_ERR_SOCKET",
        "UND_ERR_ABORTED",
        "ECONNABORTED",
        "ERR_NETWORK"
      ].includes(code)
    ) {
      return true;
    }
    const name = getErrorName(candidate);
    if (
      name &&
      ["AbortError", "TimeoutError", "ConnectTimeoutError", "HeadersTimeoutError", "BodyTimeoutError"].includes(name)
    ) {
      return true;
    }
    const message = formatError(candidate).toLowerCase();
    if (
      message.includes("fetch failed") ||
      message.includes("network") ||
      message.includes("socket") ||
      message.includes("getaddrinfo") ||
      message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("aborted")
    ) {
      return true;
    }
  }
  return false;
}

function isSafeUpdateId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function callWithTimeout<T>(
  timeoutSeconds: number,
  operation: (signal: TelegramApiAbortSignal) => Promise<T>,
  label: string
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutSeconds) * 1000);
  timeout.unref?.();
  try {
    return await operation(controller.signal as TelegramApiAbortSignal);
  } catch (error) {
    if (timedOut) {
      throw new TelegramPollingCycleError(
        "request-timeout",
        `${label} timed out after ${timeoutSeconds}s`,
        error
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function confirmPersistedOffset(params: {
  adapter: TelegramAdapter;
  lastPersistedUpdateId: number | null;
}): Promise<void> {
  if (params.lastPersistedUpdateId === null || params.lastPersistedUpdateId >= Number.MAX_SAFE_INTEGER) {
    return;
  }
  try {
    await callWithTimeout(
      OFFSET_CONFIRMATION_TIMEOUT_SECONDS,
      (signal) =>
        params.adapter.bot.api.getUpdates(
          { offset: params.lastPersistedUpdateId! + 1, limit: 1, timeout: 0 },
          signal
        ),
      "Telegram offset confirmation"
    );
    logger.info("Confirmed persisted Telegram update offset", {
      lastPersistedUpdateId: params.lastPersistedUpdateId
    });
  } catch (error) {
    logger.warn("Telegram offset confirmation failed; continuing with duplicate guard", {
      lastPersistedUpdateId: params.lastPersistedUpdateId,
      error
    });
  }
}

async function runPollingCycle(params: {
  adapter: TelegramAdapter;
  config: AppConfig;
  token: string;
  getLastInMemoryUpdateId: () => number | null;
  getLastPersistedUpdateId: () => number | null;
  updateLastInMemoryUpdateId: (updateId: number) => void;
  updateLastPersistedUpdateId: (updateId: number) => void;
  resetRestartAttempts: () => void;
}): Promise<void> {
  let lastPollActivityAt = Date.now();
  let activePollStartedAt: number | undefined;
  let activePollAbort: AbortController | undefined;
  let stalled = false;

  const watchdog = setInterval(() => {
    const now = Date.now();
    const thresholdMs = params.config.telegramPollingStallThresholdSeconds * 1000;
    const elapsedMs = activePollStartedAt === undefined ? now - lastPollActivityAt : now - activePollStartedAt;
    if (elapsedMs <= thresholdMs) {
      return;
    }
    stalled = true;
    logger.warn("Telegram polling stall detected; aborting active poll", {
      elapsedMs,
      thresholdMs,
      activePoll: activePollStartedAt !== undefined,
      lastPollActivityAt: new Date(lastPollActivityAt).toISOString(),
      activePollStartedAt: activePollStartedAt ? new Date(activePollStartedAt).toISOString() : undefined
    });
    activePollAbort?.abort();
  }, Math.max(1, params.config.telegramPollingWatchdogSeconds) * 1000);
  watchdog.unref?.();

  try {
    while (true) {
      const lastInMemoryUpdateId = params.getLastInMemoryUpdateId();
      const offset =
        lastInMemoryUpdateId === null || lastInMemoryUpdateId >= Number.MAX_SAFE_INTEGER
          ? undefined
          : lastInMemoryUpdateId + 1;
      const controller = new AbortController();
      activePollAbort = controller;
      activePollStartedAt = Date.now();
      let requestTimedOut = false;
      const requestTimeout = setTimeout(() => {
        requestTimedOut = true;
        controller.abort();
      }, params.config.telegramGetUpdatesRequestTimeoutSeconds * 1000);
      requestTimeout.unref?.();

      let updates: Update[];
      try {
        updates = await params.adapter.bot.api.getUpdates(
          {
            offset,
            limit: GET_UPDATES_LIMIT,
            timeout: params.config.telegramGetUpdatesTimeoutSeconds,
            allowed_updates: ALLOWED_UPDATES
          },
          controller.signal as TelegramApiAbortSignal
        );
      } catch (error) {
        if (stalled) {
          throw new TelegramPollingCycleError("stall", "Telegram polling stalled", error);
        }
        if (requestTimedOut) {
          throw new TelegramPollingCycleError(
            "request-timeout",
            `Telegram getUpdates timed out after ${params.config.telegramGetUpdatesRequestTimeoutSeconds}s`,
            error
          );
        }
        throw error;
      } finally {
        clearTimeout(requestTimeout);
        if (activePollAbort === controller) {
          activePollAbort = undefined;
        }
        activePollStartedAt = undefined;
      }

      lastPollActivityAt = Date.now();
      params.resetRestartAttempts();
      logger.debug("Telegram getUpdates completed", {
        offset,
        updateCount: updates.length
      });

      for (const update of updates) {
        if (!isSafeUpdateId(update.update_id)) {
          logger.warn("Skipping Telegram update with invalid update_id", {
            updateId: update.update_id
          });
          continue;
        }
        const lastPersistedUpdateId = params.getLastPersistedUpdateId();
        if (lastPersistedUpdateId !== null && update.update_id <= lastPersistedUpdateId) {
          logger.debug("Skipping already-persisted Telegram update", {
            updateId: update.update_id,
            lastPersistedUpdateId
          });
          params.updateLastInMemoryUpdateId(update.update_id);
          continue;
        }
        try {
          await params.adapter.bot.handleUpdate(update);
        } catch (error) {
          params.updateLastInMemoryUpdateId(update.update_id);
          logger.error("Telegram update handler failed; update will replay after process restart", {
            updateId: update.update_id,
            error
          });
          continue;
        }

        params.updateLastInMemoryUpdateId(update.update_id);
        const latestPersistedUpdateId = params.getLastPersistedUpdateId();
        if (latestPersistedUpdateId === null || update.update_id > latestPersistedUpdateId) {
          try {
            await writeTelegramUpdateOffset(params.config.stateRoot, params.token, update.update_id);
            params.updateLastPersistedUpdateId(update.update_id);
            logger.debug("Persisted Telegram update offset", { updateId: update.update_id });
          } catch (error) {
            logger.error("Failed to persist Telegram update offset; continuing with in-memory offset", {
              updateId: update.update_id,
              error
            });
          }
        }
      }
    }
  } finally {
    clearInterval(watchdog);
  }
}

export async function startResilientTelegramPolling(options: TelegramPollingOptions): Promise<void> {
  let lastPersistedUpdateId = readTelegramUpdateOffset(options.config.stateRoot, options.token);
  let lastInMemoryUpdateId = lastPersistedUpdateId;
  let restartAttempts = 0;

  logger.info("Loaded Telegram update offset", {
    lastPersistedUpdateId
  });

  const updateLastInMemoryUpdateId = (updateId: number): void => {
    if (lastInMemoryUpdateId === null || updateId > lastInMemoryUpdateId) {
      lastInMemoryUpdateId = updateId;
    }
  };
  const updateLastPersistedUpdateId = (updateId: number): void => {
    if (lastPersistedUpdateId === null || updateId > lastPersistedUpdateId) {
      lastPersistedUpdateId = updateId;
    }
  };

  while (true) {
    const adapter = options.createAdapter();
    options.registerHandlers(adapter);
    adapter.bot.catch((error) => {
      logger.error("Telegram bot middleware error", { error });
      throw error;
    });

    try {
      await callWithTimeout(
        options.config.telegramGetUpdatesRequestTimeoutSeconds,
        (signal) => adapter.bot.init(signal),
        "Telegram bot initialization"
      );
      await options.onAdapterReady?.(adapter);
      await callWithTimeout(
        options.config.telegramGetUpdatesRequestTimeoutSeconds,
        (signal) => adapter.bot.api.deleteWebhook({ drop_pending_updates: false }, signal),
        "Telegram deleteWebhook"
      );
      logger.info("Telegram webhook cleared before polling");
      await confirmPersistedOffset({ adapter, lastPersistedUpdateId });
      logger.info("Telegram polling cycle started", {
        lastInMemoryUpdateId,
        lastPersistedUpdateId
      });
      await runPollingCycle({
        adapter,
        config: options.config,
        token: options.token,
        getLastInMemoryUpdateId: () => lastInMemoryUpdateId,
        getLastPersistedUpdateId: () => lastPersistedUpdateId,
        updateLastInMemoryUpdateId,
        updateLastPersistedUpdateId,
        resetRestartAttempts: () => {
          restartAttempts = 0;
        }
      });
    } catch (error) {
      if (isGetUpdatesConflict(error)) {
        logger.warn("Telegram getUpdates conflict; restarting polling with a fresh bot", { error });
      } else if (isRecoverablePollingError(error)) {
        logger.warn("Recoverable Telegram polling error; restarting polling", { error });
      } else {
        logger.error("Non-recoverable Telegram polling error", { error });
        throw error;
      }

      restartAttempts += 1;
      const retryAfterSeconds = getTelegramRetryAfterSeconds(error);
      const delayMs =
        retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : computeBackoffMs(restartAttempts);
      logger.info("Waiting before Telegram polling restart", {
        restartAttempts,
        delayMs
      });
      await sleep(delayMs);
    }
  }
}
