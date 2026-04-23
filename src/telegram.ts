import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { lookup as lookupMime } from "mime-types";
import { createLogger } from "./logger.js";
import type { IncomingAttachment } from "./types.js";

const TEXT_CHUNK_SIZE = 3500;
const logger = createLogger("telegram");

function inferIsImage(filePath: string): boolean {
  const mime = lookupMime(filePath);
  return typeof mime === "string" && mime.startsWith("image/");
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
    this.bot = new Bot(token);
    logger.info("Telegram adapter initialized");
  }

  async sendText(chatId: number, text: string, threadId?: number): Promise<void> {
    const chunks = splitText(text);
    logger.info("Sending Telegram text", {
      chatId,
      threadId,
      chunkCount: chunks.length,
      totalChars: text.length
    });
    for (const chunk of chunks) {
      await this.bot.api.sendMessage(chatId, chunk, threadId ? ({ message_thread_id: threadId } as never) : undefined);
    }
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
      const filePath = resolve(attachmentsDir, `photo-${bestPhoto.file_unique_id}.jpg`);
      await this.downloadFile(bestPhoto.file_id, filePath);
      attachments.push({
        kind: "image",
        filePath,
        originalName: basename(filePath)
      });
      logger.info("Collected incoming photo attachment", { filePath });
    }

    if (message.document) {
      const originalName = message.document.file_name?.trim() || `document-${message.document.file_id}${extname(message.document.file_name ?? "")}`;
      const filePath = resolve(attachmentsDir, originalName);
      await this.downloadFile(message.document.file_id, filePath);
      attachments.push({
        kind: "document",
        filePath,
        originalName
      });
      logger.info("Collected incoming document attachment", { filePath, originalName });
    }

    logger.info("Collected incoming attachments", { count: attachments.length, attachmentsDir });
    return attachments;
  }
}

function splitText(text: string): string[] {
  if (!text.trim()) return ["(empty response)"];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TEXT_CHUNK_SIZE) {
    let splitIndex = remaining.lastIndexOf("\n", TEXT_CHUNK_SIZE);
    if (splitIndex < TEXT_CHUNK_SIZE * 0.5) {
      splitIndex = TEXT_CHUNK_SIZE;
    }
    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
