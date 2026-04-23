import { createLogger } from "./logger.js";

const logger = createLogger("telegram-stream");
const DEFAULT_MIN_INITIAL_CHARS = 48;
const DEFAULT_THROTTLE_MS = 1000;

type PreviewSendResult = Promise<unknown> | unknown;

export interface TelegramPreviewStream {
  update(text: string): Promise<void>;
  flush(): Promise<void>;
  stop(): Promise<void>;
  messageId(): number | undefined;
  failed(): boolean;
}

export interface TelegramPreviewStreamOptions {
  minInitialChars?: number;
  throttleMs?: number;
  sendPreview: (text: string) => PreviewSendResult;
  editPreview: (messageId: number, text: string) => PreviewSendResult;
}

export function createTelegramPreviewStream(
  options: TelegramPreviewStreamOptions
): TelegramPreviewStream {
  const minInitialChars = Math.max(1, options.minInitialChars ?? DEFAULT_MIN_INITIAL_CHARS);
  const throttleMs = Math.max(250, options.throttleMs ?? DEFAULT_THROTTLE_MS);

  let latestText = "";
  let deliveredText = "";
  let previewMessageId: number | undefined;
  let lastAttemptAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let failed = false;
  let operation = Promise.resolve();

  function clearTimer(): void {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function normalize(text: string): string {
    return text.replace(/\u0000/g, "");
  }

  function shouldStartPreview(text: string): boolean {
    return text.trim().length >= minInitialChars;
  }

  function extractMessageId(result: unknown): number | undefined {
    if (typeof result === "number" && Number.isFinite(result)) {
      return Math.trunc(result);
    }
    if (Array.isArray(result)) {
      for (const entry of result) {
        const nested = extractMessageId(entry);
        if (nested !== undefined) return nested;
      }
      return undefined;
    }
    if (typeof result !== "object" || result === null) {
      return undefined;
    }
    const candidate = result as {
      message_id?: unknown;
      messageId?: unknown;
      id?: unknown;
      message?: unknown;
      messages?: unknown;
      deliveries?: unknown;
      results?: unknown;
    };
    if (typeof candidate.message_id === "number" && Number.isFinite(candidate.message_id)) {
      return Math.trunc(candidate.message_id);
    }
    if (typeof candidate.messageId === "number" && Number.isFinite(candidate.messageId)) {
      return Math.trunc(candidate.messageId);
    }
    if (typeof candidate.id === "number" && Number.isFinite(candidate.id)) {
      return Math.trunc(candidate.id);
    }
    return (
      extractMessageId(candidate.message) ??
      extractMessageId(candidate.messages) ??
      extractMessageId(candidate.deliveries) ??
      extractMessageId(candidate.results)
    );
  }

  async function deliver(force: boolean): Promise<void> {
    if (stopped || failed) return;

    const text = normalize(latestText);
    if (!text.trim()) return;
    if (!force && previewMessageId === undefined && !shouldStartPreview(text)) return;
    if (text === deliveredText) return;

    try {
      if (previewMessageId === undefined) {
        const result = await options.sendPreview(text);
        previewMessageId = extractMessageId(result);
        if (previewMessageId === undefined) {
          throw new Error("Preview send did not return a message id");
        }
      } else {
        await options.editPreview(previewMessageId, text);
      }
      deliveredText = text;
      lastAttemptAt = Date.now();
    } catch (error) {
      failed = true;
      clearTimer();
      logger.warn("Telegram preview stream disabled after delivery failure", {
        error,
        hasMessageId: previewMessageId !== undefined
      });
    }
  }

  function enqueue(force: boolean): Promise<void> {
    operation = operation.then(() => deliver(force));
    return operation;
  }

  function schedule(): Promise<void> {
    if (stopped || failed) return operation;

    clearTimer();
    const text = normalize(latestText);
    if (!text.trim()) return operation;
    if (previewMessageId === undefined && !shouldStartPreview(text)) return operation;

    const waitMs = Math.max(0, throttleMs - (Date.now() - lastAttemptAt));
    if (waitMs === 0) {
      return enqueue(false);
    }

    return new Promise((resolve) => {
      timer = setTimeout(() => {
        timer = undefined;
        void enqueue(false).finally(resolve);
      }, waitMs);
    });
  }

  return {
    async update(text: string): Promise<void> {
      latestText = normalize(text);
      await schedule();
    },
    async flush(): Promise<void> {
      clearTimer();
      await enqueue(true);
    },
    async stop(): Promise<void> {
      stopped = true;
      clearTimer();
      await operation;
    },
    messageId(): number | undefined {
      return previewMessageId;
    },
    failed(): boolean {
      return failed;
    }
  };
}
