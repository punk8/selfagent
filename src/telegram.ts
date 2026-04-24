import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { lookup as lookupMime } from "mime-types";
import { createLogger } from "./logger.js";
import { getNodeHttpProxyAgent } from "./network.js";
import { prepareTelegramTextChunks, renderTelegramPreview } from "./telegram-format.js";
import type { IncomingAttachment } from "./types.js";

const logger = createLogger("telegram");
const TELEGRAM_PARSE_ERROR_PATTERN = /can't parse entities|parse entities|find end of the entity/i;
const TELEGRAM_EMPTY_TEXT_ERROR_PATTERN = /message text is empty/i;
const TELEGRAM_NOT_MODIFIED_PATTERN = /message is not modified/i;
const SAFE_ATTACHMENT_NAME_MAX_LENGTH = 180;

export type TelegramFormattedSendResult = {
  messageIds: number[];
};

export type TelegramFormattedEditResult = {
  messageId: number;
  mode: "html" | "plain";
  overflowMessageIds: number[];
};

export type TelegramPreviewSendResult = {
  messageId: number;
  mode: "html" | "plain";
};

export type TelegramPreviewFinalizeResult = {
  messageId: number;
  mode: "html" | "plain";
  overflowMessageIds: number[];
};

function inferIsImage(filePath: string): boolean {
  const mime = lookupMime(filePath);
  return typeof mime === "string" && mime.startsWith("image/");
}

function sanitizeFilenameSegment(value: string, fallback: string): string {
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]+/g, "_")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  return sanitized || fallback;
}

function safeBasename(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  return basename(trimmed.replace(/\\/g, "/")) || fallback;
}

function createSafeAttachmentName(params: {
  preferredName?: string;
  fallbackStem: string;
  uniqueId: string;
  fallbackExtension?: string;
}): { storageName: string; originalName: string } {
  const rawBaseName = safeBasename(params.preferredName, params.fallbackStem);
  const rawExtension = extname(rawBaseName) || params.fallbackExtension || "";
  const rawStem = rawExtension ? rawBaseName.slice(0, -rawExtension.length) : rawBaseName;
  const stem = sanitizeFilenameSegment(rawStem, params.fallbackStem);
  const extensionBody = sanitizeFilenameSegment(rawExtension.replace(/^\.+/, ""), "");
  const extension = extensionBody ? `.${extensionBody.slice(0, 24)}` : "";
  const uniqueId = sanitizeFilenameSegment(params.uniqueId, "file").slice(0, 32);
  const suffix = `-${uniqueId}-${randomUUID().slice(0, 8)}${extension}`;
  const maxStemLength = Math.max(1, SAFE_ATTACHMENT_NAME_MAX_LENGTH - suffix.length);

  return {
    storageName: `${stem.slice(0, maxStemLength)}${suffix}`,
    originalName: sanitizeFilenameSegment(rawBaseName, params.fallbackStem)
  };
}

function resolveAttachmentPath(attachmentsDir: string, storageName: string): string {
  const root = resolve(attachmentsDir);
  const filePath = resolve(root, storageName);
  const relativePath = relative(root, filePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Resolved Telegram attachment path escaped the attachments directory");
  }
  return filePath;
}

function buildApprovalKeyboard(requestId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Approve Once", `cu:approve:once:${requestId}`)
    .text("Approve Session", `cu:approve:session:${requestId}`)
    .row()
    .text("Deny", `cu:deny:${requestId}`);
}

export class TelegramAdapter {
  readonly bot: Bot;

  constructor(private readonly token: string) {
    const proxyAgent = getNodeHttpProxyAgent();
    this.bot = new Bot(token, proxyAgent ? { client: { baseFetchConfig: { agent: proxyAgent } } } : undefined);
    logger.info("Telegram adapter initialized");
  }

  async sendText(chatId: number, text: string, threadId?: number): Promise<void> {
    await this.sendFormattedText(chatId, text, threadId);
  }

  async sendPlainText(chatId: number, text: string, threadId?: number): Promise<void> {
    const chunks = prepareTelegramTextChunks(text).map((chunk) => chunk.plainText.trim() || "(empty response)");
    logger.info("Sending Telegram plain text", {
      chatId,
      threadId,
      chunkCount: chunks.length,
      totalChars: text.length
    });
    for (const chunk of chunks) {
      await this.bot.api.sendMessage(chatId, chunk, threadId ? ({ message_thread_id: threadId } as never) : undefined);
    }
  }

  async sendFormattedText(chatId: number, text: string, threadId?: number): Promise<TelegramFormattedSendResult> {
    const chunks = prepareTelegramTextChunks(text);
    logger.info("Sending Telegram formatted text", {
      chatId,
      threadId,
      chunkCount: chunks.length,
      totalChars: text.length
    });

    const messageIds: number[] = [];
    for (const chunk of chunks) {
      const sent = await this.sendPreparedChunk(chatId, chunk, threadId);
      messageIds.push(sent.messageId);
    }

    return { messageIds };
  }

  async editFormattedText(
    chatId: number,
    messageId: number,
    text: string,
    threadId?: number
  ): Promise<TelegramFormattedEditResult> {
    const chunks = prepareTelegramTextChunks(text);
    const firstChunk = chunks[0] ?? { html: "", plainText: text.trim() || "(empty response)" };
    const overflow = chunks.slice(1);

    logger.info("Editing Telegram formatted text", {
      chatId,
      threadId,
      messageId,
      chunkCount: chunks.length,
      totalChars: text.length
    });

    const edited = await this.editPreparedChunk(chatId, messageId, firstChunk);
    const overflowMessageIds: number[] = [];
    for (const chunk of overflow) {
      const sent = await this.sendPreparedChunk(chatId, chunk, threadId);
      overflowMessageIds.push(sent.messageId);
    }

    return {
      messageId,
      mode: edited.mode,
      overflowMessageIds
    };
  }

  async sendFormattedPreview(chatId: number, text: string, threadId?: number): Promise<TelegramPreviewSendResult> {
    const chunk = this.preparePreviewChunk(text);
    logger.info("Sending Telegram preview text", {
      chatId,
      threadId,
      totalChars: text.length,
      previewChars: chunk.plainText.length
    });
    return this.sendPreparedChunk(chatId, chunk, threadId);
  }

  async editFormattedPreview(chatId: number, messageId: number, text: string): Promise<{ mode: "html" | "plain" }> {
    const chunk = this.preparePreviewChunk(text);
    logger.info("Editing Telegram preview text", {
      chatId,
      messageId,
      totalChars: text.length,
      previewChars: chunk.plainText.length
    });
    return this.editPreparedChunk(chatId, messageId, chunk);
  }

  async finalizeFormattedPreview(
    chatId: number,
    messageId: number,
    text: string,
    threadId?: number
  ): Promise<TelegramPreviewFinalizeResult> {
    const chunks = prepareTelegramTextChunks(text);
    const firstChunk = chunks[0] ?? { html: "", plainText: text.trim() || "(empty response)" };
    const overflow = chunks.slice(1);

    logger.info("Finalizing Telegram preview text", {
      chatId,
      threadId,
      messageId,
      chunkCount: chunks.length,
      totalChars: text.length
    });

    const edited = await this.editPreparedChunk(chatId, messageId, firstChunk);
    const overflowMessageIds: number[] = [];
    for (const chunk of overflow) {
      const sent = await this.sendPreparedChunk(chatId, chunk, threadId);
      overflowMessageIds.push(sent.messageId);
    }

    return {
      messageId,
      mode: edited.mode,
      overflowMessageIds
    };
  }

  async sendAttachment(chatId: number, filePath: string, title?: string, threadId?: number): Promise<void> {
    const inputFile = new InputFile(filePath, title ?? basename(filePath));
    const options = threadId ? ({ message_thread_id: threadId } as never) : undefined;
    logger.info("Sending Telegram attachment", {
      chatId,
      threadId,
      filePath,
      title: title ?? basename(filePath),
      kind: inferIsImage(filePath) ? "image" : "document"
    });
    if (inferIsImage(filePath)) {
      await this.bot.api.sendPhoto(chatId, inputFile, options);
      return;
    }
    await this.bot.api.sendDocument(chatId, inputFile, options);
  }

  async sendApprovalRequest(chatId: number, summary: string, requestId: string, threadId?: number): Promise<void> {
    const text = `Computer-use approval required.\n\nRequested action: ${summary}\n\nChoose how to approve this request.`;
    const options = {
      ...(threadId ? ({ message_thread_id: threadId } as Record<string, unknown>) : {}),
      reply_markup: buildApprovalKeyboard(requestId)
    };
    logger.info("Sending approval request", { chatId, threadId, requestId, summary });
    await this.bot.api.sendMessage(chatId, text, options as never);
  }

  async sendTyping(chatId: number, threadId?: number): Promise<void> {
    logger.debug("Sending typing action", { chatId, threadId });
    await this.bot.api.sendChatAction(chatId, "typing", threadId ? ({ message_thread_id: threadId } as never) : undefined);
  }

  async downloadFile(fileId: string, outputPath: string): Promise<void> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) {
      throw new Error("Telegram file did not include file_path");
    }
    await mkdir(resolve(outputPath, ".."), { recursive: true });
    logger.info("Downloading Telegram file", { fileId, telegramFilePath: file.file_path, outputPath });
    const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download Telegram file: ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(outputPath, bytes);
  }

  async collectIncomingAttachments(
    message: {
      photo?: Array<{ file_id: string; file_unique_id: string }>;
      document?: { file_id: string; file_name?: string };
    },
    attachmentsDir: string
  ): Promise<IncomingAttachment[]> {
    const attachments: IncomingAttachment[] = [];
    await mkdir(attachmentsDir, { recursive: true });

    if (message.photo && message.photo.length > 0) {
      const bestPhoto = message.photo[message.photo.length - 1];
      const safeName = createSafeAttachmentName({
        fallbackStem: "photo",
        uniqueId: bestPhoto.file_unique_id,
        fallbackExtension: ".jpg"
      });
      const filePath = resolveAttachmentPath(attachmentsDir, safeName.storageName);
      await this.downloadFile(bestPhoto.file_id, filePath);
      attachments.push({
        kind: "image",
        filePath,
        originalName: safeName.originalName
      });
      logger.info("Collected incoming photo attachment", { filePath });
    }

    if (message.document) {
      const safeName = createSafeAttachmentName({
        preferredName: message.document.file_name,
        fallbackStem: "document",
        uniqueId: message.document.file_id
      });
      const filePath = resolveAttachmentPath(attachmentsDir, safeName.storageName);
      await this.downloadFile(message.document.file_id, filePath);
      attachments.push({
        kind: "document",
        filePath,
        originalName: safeName.originalName
      });
      logger.info("Collected incoming document attachment", {
        filePath,
        originalName: safeName.originalName,
        storageName: safeName.storageName
      });
    }

    logger.info("Collected incoming attachments", { count: attachments.length, attachmentsDir });
    return attachments;
  }

  private async sendPreparedChunk(
    chatId: number,
    chunk: { html: string; plainText: string },
    threadId?: number
  ): Promise<{ messageId: number; mode: "html" | "plain" }> {
    const options = threadId ? ({ message_thread_id: threadId } as never) : undefined;
    const fallbackText = chunk.plainText.trim() || "(empty response)";

    if (!chunk.html.trim()) {
      const sent = await this.bot.api.sendMessage(chatId, fallbackText, options);
      return { messageId: sent.message_id, mode: "plain" };
    }

    try {
      const sent = await this.bot.api.sendMessage(
        chatId,
        chunk.html,
        {
          ...(threadId ? ({ message_thread_id: threadId } as Record<string, unknown>) : {}),
          parse_mode: "HTML"
        } as never
      );
      return { messageId: sent.message_id, mode: "html" };
    } catch (error) {
      if (!isTelegramFormattingFailure(error)) {
        throw error;
      }

      logger.warn("Telegram HTML send failed; retrying with plain text", {
        chatId,
        threadId,
        error: getTelegramErrorDescription(error)
      });
      const sent = await this.bot.api.sendMessage(chatId, fallbackText, options);
      return { messageId: sent.message_id, mode: "plain" };
    }
  }

  private async editPreparedChunk(
    chatId: number,
    messageId: number,
    chunk: { html: string; plainText: string }
  ): Promise<{ mode: "html" | "plain" }> {
    const fallbackText = chunk.plainText.trim() || "(empty response)";

    if (!chunk.html.trim()) {
      await this.tryEditMessageText(chatId, messageId, fallbackText);
      return { mode: "plain" };
    }

    try {
      await this.tryEditMessageText(chatId, messageId, chunk.html, { parse_mode: "HTML" });
      return { mode: "html" };
    } catch (error) {
      if (!isTelegramFormattingFailure(error)) {
        throw error;
      }

      logger.warn("Telegram HTML edit failed; retrying with plain text", {
        chatId,
        messageId,
        error: getTelegramErrorDescription(error)
      });
      await this.tryEditMessageText(chatId, messageId, fallbackText);
      return { mode: "plain" };
    }
  }

  private preparePreviewChunk(text: string): { html: string; plainText: string } {
    const preview = renderTelegramPreview(text);
    if (!preview) {
      return {
        html: "",
        plainText: text.trim() || "(empty response)"
      };
    }
    return {
      html: preview.html,
      plainText: preview.text
    };
  }

  private async tryEditMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options?: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.bot.api.editMessageText(chatId, messageId, text, options as never);
    } catch (error) {
      if (isTelegramNotModified(error)) {
        return;
      }
      throw error;
    }
  }
}

function getTelegramErrorDescription(error: unknown): string {
  if (error && typeof error === "object") {
    if ("description" in error && typeof error.description === "string") {
      return error.description;
    }
    if ("message" in error && typeof error.message === "string") {
      return error.message;
    }
  }
  return String(error);
}

function isTelegramFormattingFailure(error: unknown): boolean {
  const description = getTelegramErrorDescription(error);
  return TELEGRAM_PARSE_ERROR_PATTERN.test(description) || TELEGRAM_EMPTY_TEXT_ERROR_PATTERN.test(description);
}

function isTelegramNotModified(error: unknown): boolean {
  return TELEGRAM_NOT_MODIFIED_PATTERN.test(getTelegramErrorDescription(error));
}
