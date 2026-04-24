import { mkdir } from "node:fs/promises";
import type { AppConfig } from "./config.js";
import { ApprovalStore } from "./approvals.js";
import { authorizeTelegramUserFromCode, isTelegramUserAllowed } from "./access.js";
import {
  appendCronRunRecord,
  appendRecentCronDelivery,
  isCronJobDue,
  loadCronJobs,
  saveCronJobs,
  updateCronJob
} from "./cron.js";
import { getConversationPaths } from "./paths.js";
import { createLogger } from "./logger.js";
import { SelfAgentTimeoutError, createConversationServices, runConversationTurn, runScheduledTask } from "./session.js";
import { TelegramAdapter } from "./telegram.js";
import { startResilientTelegramPolling } from "./telegram-polling.js";
import { createTelegramPreviewStream } from "./telegram-stream.js";
import type { ConversationRef } from "./types.js";

const logger = createLogger("runtime");
const TELEGRAM_COMMAND_PATTERN = /^\/(?:start|authorize|approve|deny)(?:@\S+)?(?:\s|$)/i;
const AUTHORIZATION_CODE_PATTERN = /^[A-Z2-9]{6,16}$/;
const TELEGRAM_PREVIEW_MIN_CHARS = 48;
const TELEGRAM_PREVIEW_THROTTLE_MS = 1000;
const CRON_TICK_MS = 30_000;

type TelegramFormattedAdapter = TelegramAdapter & {
  sendFormattedText?: (chatId: number, text: string, threadId?: number) => Promise<unknown>;
  sendPlainText?: (chatId: number, text: string, threadId?: number) => Promise<void>;
  sendFormattedPreview?: (chatId: number, text: string, threadId?: number) => Promise<unknown>;
  editFormattedPreview?: (chatId: number, messageId: number, text: string) => Promise<unknown>;
  finalizeFormattedPreview?: (chatId: number, messageId: number, text: string, threadId?: number) => Promise<unknown>;
};

function getFormattedTelegramAdapter(adapter: TelegramAdapter): TelegramFormattedAdapter {
  return adapter as TelegramFormattedAdapter;
}

async function sendTelegramFinalReply(
  adapter: TelegramFormattedAdapter,
  chatId: number,
  text: string,
  threadId?: number
): Promise<number[]> {
  if (typeof adapter.sendFormattedText === "function") {
    try {
      const result = await adapter.sendFormattedText(chatId, text, threadId);
      return result?.messageIds ?? [];
    } catch (error) {
      logger.warn("Formatted Telegram send failed, falling back to plain text", {
        chatId,
        threadId,
        error
      });
      if (typeof adapter.sendPlainText === "function") {
        await adapter.sendPlainText(chatId, text, threadId);
        return [];
      }
    }
  }
  await adapter.sendText(chatId, text, threadId);
  return [];
}

function getConversationFromMessage(message: {
  chat: { id: number };
  from?: { id: number };
  message_thread_id?: number;
}): ConversationRef {
  return {
    platform: "telegram",
    chatId: message.chat.id,
    threadId: message.message_thread_id,
    userId: message.from?.id
  };
}

export async function startTelegramRuntime(config: AppConfig): Promise<void> {
  if (config.channel !== "telegram") {
    throw new Error(`Unsupported configured channel: ${config.channel ?? "(none)"}`);
  }
  if (!config.telegramBotToken) {
    throw new Error("Missing Telegram bot token");
  }

  await mkdir(config.stateRoot, { recursive: true });
  let activeAdapter: TelegramAdapter | undefined;
  function getActiveAdapter(): TelegramAdapter {
    if (!activeAdapter) {
      throw new Error("Telegram adapter is not ready yet");
    }
    return activeAdapter;
  }
  function getActiveDeliveryAdapter(): TelegramFormattedAdapter {
    return getFormattedTelegramAdapter(getActiveAdapter());
  }

  const servicesCache = new Map<string, Awaited<ReturnType<typeof createConversationServices>>>();
  const conversationQueues = new Map<string, Promise<void>>();

  function enqueue(key: string, work: () => Promise<void>): void {
    const previous = conversationQueues.get(key) ?? Promise.resolve();
    logger.debug("Queueing conversation work", {
      conversationKey: key,
      alreadyQueued: conversationQueues.has(key)
    });
    const next = previous.then(work, work);
    conversationQueues.set(
      key,
      next.finally(() => {
        if (conversationQueues.get(key) === next) {
          conversationQueues.delete(key);
        }
      })
    );
  }

  async function getServices(conversation: ConversationRef) {
    const paths = getConversationPaths(config.stateRoot, conversation);
    if (!servicesCache.has(paths.key)) {
      logger.info("Creating conversation services", { conversationKey: paths.key });
      servicesCache.set(
        paths.key,
        await createConversationServices(config, conversation, {
          sendAttachment: async (filePath, title) => {
            await getActiveAdapter().sendAttachment(conversation.chatId, filePath, title, conversation.threadId);
          },
          requestApproval: async (summary, requestId) => {
            await getActiveAdapter().sendApprovalRequest(conversation.chatId, summary, requestId, conversation.threadId);
          }
        })
      );
    }
    return servicesCache.get(paths.key)!;
  }

  let cronTickRunning = false;
  let cronTimer: ReturnType<typeof setInterval> | undefined;
  const runCronTick = async (): Promise<void> => {
    if (cronTickRunning) {
      logger.debug("Cron tick skipped because a previous tick is still running");
      return;
    }
    if (!activeAdapter) {
      logger.debug("Cron tick skipped because Telegram adapter is not ready yet");
      return;
    }
    cronTickRunning = true;
    try {
      const jobs = loadCronJobs(config.stateRoot);
      const dueJobs = jobs.filter((job) => isCronJobDue(job));
      if (dueJobs.length === 0) {
        return;
      }
      logger.info("Cron tick found due jobs", {
        dueJobIds: dueJobs.map((job) => job.id),
        count: dueJobs.length
      });

      const nextJobs = [...jobs];
      let jobsChanged = false;

      for (const dueJob of dueJobs) {
        const jobIndex = nextJobs.findIndex((job) => job.id === dueJob.id);
        if (jobIndex < 0) {
          continue;
        }
        const job = nextJobs[jobIndex]!;
        const conversation: ConversationRef = {
          platform: "telegram",
          chatId: job.origin.chatId,
          threadId: job.origin.threadId,
          userId: job.origin.userId
        };
        const paths = getConversationPaths(config.stateRoot, conversation);
        const startedAt = new Date().toISOString();
        const services = await getServices(conversation);
        let deliveredMessageIds: number[] = [];
        try {
          const result = await runScheduledTask(services, job);
          deliveredMessageIds = await sendTelegramFinalReply(
            getActiveDeliveryAdapter(),
            conversation.chatId,
            result.reply,
            conversation.threadId
          );
          const finishedAt = new Date().toISOString();
          await appendRecentCronDelivery(paths, {
            jobId: job.id,
            jobName: job.name,
            runId: result.runId,
            deliveredAt: finishedAt,
            deliveredMessageIds,
            summary: result.summary,
            resultText: result.reply
          });
          await appendCronRunRecord(config.stateRoot, job.id, result.runId, {
            runId: result.runId,
            jobId: job.id,
            startedAt,
            finishedAt,
            status: "ok",
            resultText: result.reply,
            summary: result.summary,
            deliveredMessageIds
          });
          nextJobs[jobIndex] = updateCronJob(job, {
            lastRunAt: finishedAt,
            lastStatus: "ok",
            lastError: undefined,
            lastSummary: result.summary,
            lastDeliveredAt: finishedAt
          });
          jobsChanged = true;
          logger.info("Scheduled task delivered", {
            jobId: job.id,
            runId: result.runId,
            deliveredMessageIds
          });
        } catch (error) {
          const finishedAt = new Date().toISOString();
          const message = error instanceof Error ? error.message : String(error);
          logger.error("Scheduled task run failed", {
            jobId: job.id,
            error
          });
          if (error instanceof SelfAgentTimeoutError) {
            deliveredMessageIds = await sendTelegramFinalReply(
              getActiveDeliveryAdapter(),
              conversation.chatId,
              error.message,
              conversation.threadId
            );
          }
          const runId = `failed-${Date.now()}`;
          await appendCronRunRecord(config.stateRoot, job.id, runId, {
            runId,
            jobId: job.id,
            startedAt,
            finishedAt,
            status: "error",
            resultText: "",
            summary: message,
            deliveredMessageIds,
            error: message
          });
          nextJobs[jobIndex] = updateCronJob(job, {
            lastRunAt: finishedAt,
            lastStatus: "error",
            lastError: message,
            lastSummary: undefined
          });
          jobsChanged = true;
        }
      }

      if (jobsChanged) {
        await saveCronJobs(config.stateRoot, nextJobs);
      }
    } finally {
      cronTickRunning = false;
    }
  };

  function registerTelegramHandlers(adapter: TelegramAdapter): void {
    const deliveryAdapter = getFormattedTelegramAdapter(adapter);

  adapter.bot.command("start", async (ctx) => {
    logger.info("Received /start command", { chatId: ctx.chat.id, userId: ctx.from?.id });
    if (!isTelegramUserAllowed(config, ctx.from?.id)) {
      await ctx.reply("This bot is private. Ask the operator to start an authorization request and then send /authorize <code>.");
      return;
    }
    await ctx.reply("SelfAgent is online. Send a message to start a Telegram-backed agent session.");
  });

  adapter.bot.command("authorize", async (ctx) => {
    const rawText = ctx.msg.text ?? "";
    const code = rawText.replace(/^\/authorize(?:@\S+)?\s*/i, "").trim().toUpperCase();
    logger.info("Received /authorize command", {
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      hasCode: Boolean(code)
    });
    if (!ctx.from?.id) {
      await ctx.reply("Unable to identify the Telegram user for this authorization.");
      return;
    }
    if (!code) {
      await ctx.reply("Usage: /authorize <code>");
      return;
    }
    const result = await authorizeTelegramUserFromCode(config, code, ctx.from.id);
    if (!result.ok) {
      await ctx.reply(result.reason);
      return;
    }
    await ctx.reply("Authorization complete. This Telegram account is now allowed to use the bot.");
  });

  adapter.bot.command("approve", async (ctx) => {
    if (!isTelegramUserAllowed(config, ctx.from?.id)) {
      await ctx.reply("This bot is private. You are not on the allowlist.");
      return;
    }
    const conversation = getConversationFromMessage(ctx.msg);
    const paths = getConversationPaths(config.stateRoot, conversation);
    const store = new ApprovalStore(paths.approvalFile);
    const state = store.getState();
    if (!state.pending) {
      logger.info("Approval requested with no pending request", { conversationKey: paths.key });
      await ctx.reply("No pending computer-use approval request.");
      return;
    }
    await store.grant("session", ctx.from?.id);
    logger.info("Approved computer-use from command", { conversationKey: paths.key, actorUserId: ctx.from?.id });
    await ctx.reply("Computer-use approved for this session.");
  });

  adapter.bot.command("deny", async (ctx) => {
    if (!isTelegramUserAllowed(config, ctx.from?.id)) {
      await ctx.reply("This bot is private. You are not on the allowlist.");
      return;
    }
    const conversation = getConversationFromMessage(ctx.msg);
    const paths = getConversationPaths(config.stateRoot, conversation);
    const store = new ApprovalStore(paths.approvalFile);
    await store.deny();
    logger.info("Denied computer-use from command", { conversationKey: paths.key, actorUserId: ctx.from?.id });
    await ctx.reply("Pending computer-use approval cleared.");
  });

  adapter.bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const message = ctx.callbackQuery.message;
    if (!message) {
      logger.warn("Callback query missing message context", { data });
      await ctx.answerCallbackQuery({ text: "No message context available." });
      return;
    }
    const conversation = getConversationFromMessage(message);
    const paths = getConversationPaths(config.stateRoot, conversation);
    const store = new ApprovalStore(paths.approvalFile);
    const state = store.getState();
    const [, action, modeOrRequest, requestId] = data.split(":");
    if (!state.pending) {
      logger.info("Callback query received with no pending approval", { conversationKey: paths.key, data });
      await ctx.answerCallbackQuery({ text: "No pending request." });
      return;
    }
    const expectedRequestId = action === "approve" ? requestId : modeOrRequest;
    if (state.pending.requestId !== expectedRequestId) {
      logger.warn("Stale approval callback received", {
        conversationKey: paths.key,
        expectedRequestId: state.pending.requestId,
        receivedRequestId: expectedRequestId
      });
      await ctx.answerCallbackQuery({ text: "This approval request is stale." });
      return;
    }
    if (state.pending.requestedByUserId !== undefined && state.pending.requestedByUserId !== ctx.from.id) {
      logger.warn("Approval callback rejected due to user mismatch", {
        conversationKey: paths.key,
        requestedByUserId: state.pending.requestedByUserId,
        actorUserId: ctx.from.id
      });
      await ctx.answerCallbackQuery({ text: "Only the requesting user can approve this action." });
      return;
    }
    if (action === "approve") {
      const mode = modeOrRequest === "once" ? "once" : "session";
      await store.grant(mode, ctx.from.id);
      logger.info("Approved computer-use from callback", {
        conversationKey: paths.key,
        actorUserId: ctx.from.id,
        mode
      });
      await ctx.answerCallbackQuery({ text: mode === "once" ? "Approved once." : "Approved for this session." });
      await ctx.reply(
        mode === "once"
          ? "Computer-use approved once. Ask again to execute it."
          : "Computer-use approved for this session."
      );
      return;
    }
    if (action === "deny") {
      await store.deny();
      logger.info("Denied computer-use from callback", {
        conversationKey: paths.key,
        actorUserId: ctx.from.id
      });
      await ctx.answerCallbackQuery({ text: "Denied." });
      await ctx.reply("Computer-use request denied.");
    }
  });

  adapter.bot.on("message", async (ctx) => {
    const text = ctx.msg.text ?? ctx.msg.caption ?? "";
    const conversation = getConversationFromMessage(ctx.msg);
    const normalizedText = text.trim().toUpperCase();

    if (TELEGRAM_COMMAND_PATTERN.test(text.trim())) {
      logger.debug("Skipping generic message handler for Telegram command", {
        chatId: conversation.chatId,
        userId: conversation.userId,
        textPreview: text.slice(0, 120)
      });
      return;
    }

    if (conversation.userId && AUTHORIZATION_CODE_PATTERN.test(normalizedText)) {
      const authorization = await authorizeTelegramUserFromCode(config, normalizedText, conversation.userId);
      if (authorization.ok) {
        logger.info("Authorized Telegram user from bare code message", {
          chatId: conversation.chatId,
          userId: conversation.userId,
          profileId: authorization.profileId
        });
        await adapter.sendText(
          conversation.chatId,
          "Authorization complete. This Telegram account is now allowed to use the bot.",
          conversation.threadId
        );
        return;
      }
      logger.debug("Bare authorization code message did not authorize user", {
        chatId: conversation.chatId,
        userId: conversation.userId,
        reason: authorization.reason
      });
    }

    if (!isTelegramUserAllowed(config, conversation.userId)) {
      logger.warn("Blocked unauthorized Telegram message", {
        chatId: conversation.chatId,
        userId: conversation.userId,
        textPreview: text.slice(0, 120)
      });
      await adapter.sendText(
        conversation.chatId,
        "This bot is private. Ask the operator to start an authorization request and then send /authorize <code>.",
        conversation.threadId
      );
      return;
    }
    const paths = getConversationPaths(config.stateRoot, conversation);
    logger.info("Incoming Telegram message", {
      conversationKey: paths.key,
      chatId: conversation.chatId,
      userId: conversation.userId,
      threadId: conversation.threadId,
      textPreview: text.slice(0, 120),
      hasPhoto: Boolean(ctx.msg.photo?.length),
      hasDocument: Boolean(ctx.msg.document)
    });
    enqueue(paths.key, async () => {
      try {
        await mkdir(paths.attachmentsDir, { recursive: true });
        const attachments = await adapter.collectIncomingAttachments(ctx.msg, paths.attachmentsDir);
        logger.info("Conversation work started", {
          conversationKey: paths.key,
          attachmentCount: attachments.length
        });
        const services = await getServices(conversation);
        const previewStream =
          typeof deliveryAdapter.sendFormattedPreview === "function" &&
          typeof deliveryAdapter.editFormattedPreview === "function"
            ? createTelegramPreviewStream({
                minInitialChars: TELEGRAM_PREVIEW_MIN_CHARS,
                throttleMs: TELEGRAM_PREVIEW_THROTTLE_MS,
                sendPreview: (previewText) =>
                  deliveryAdapter.sendFormattedPreview!(conversation.chatId, previewText, conversation.threadId),
                editPreview: (messageId, previewText) =>
                  deliveryAdapter.editFormattedPreview!(conversation.chatId, messageId, previewText)
              })
            : undefined;
        let streamedPreviewText = "";
        let finalReplyFromCallback = "";
        const typingLoop = setInterval(() => {
          void adapter.sendTyping(conversation.chatId, conversation.threadId);
        }, 4000);
        try {
          await adapter.sendTyping(conversation.chatId, conversation.threadId);
          const reply = await runConversationTurn(services, conversation, text, attachments, {
            onTextDelta: (delta) => {
              if (!previewStream) return;
              streamedPreviewText += delta;
              void previewStream.update(streamedPreviewText);
            },
            onFinalText: (finalText) => {
              finalReplyFromCallback = finalText;
              streamedPreviewText = finalText;
              if (!previewStream) return;
              void previewStream.update(finalText);
            }
          });
          const finalReply = finalReplyFromCallback.trim() || reply;
          if (previewStream) {
            await previewStream.flush();
          }
          const previewDelivered =
            previewStream !== undefined &&
            !previewStream.failed() &&
            previewStream.messageId() !== undefined;
          if (previewDelivered && typeof deliveryAdapter.finalizeFormattedPreview === "function") {
            await deliveryAdapter.finalizeFormattedPreview!(
              conversation.chatId,
              previewStream.messageId()!,
              finalReply,
              conversation.threadId
            );
          } else {
            await sendTelegramFinalReply(deliveryAdapter, conversation.chatId, finalReply, conversation.threadId);
          }
          logger.info("Reply sent", {
            conversationKey: paths.key,
            replyChars: finalReply.length,
            previewDelivered
          });
        } finally {
          clearInterval(typingLoop);
          await previewStream?.stop();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Conversation handling failed", {
          conversationKey: paths.key,
          error
        });
        const outboundMessage = error instanceof SelfAgentTimeoutError ? message : `Error: ${message}`;
        await adapter.sendText(conversation.chatId, outboundMessage, conversation.threadId);
      }
    });
  });
  }

  let initialCronRunTriggered = false;
  await runCronTick();
  cronTimer = setInterval(() => {
    void runCronTick();
  }, CRON_TICK_MS);

  try {
    await startResilientTelegramPolling({
      config,
      token: config.telegramBotToken,
      createAdapter: () => {
        const adapter = new TelegramAdapter(config.telegramBotToken!);
        activeAdapter = adapter;
        return adapter;
      },
      registerHandlers: registerTelegramHandlers,
      onAdapterReady: async (adapter) => {
        const me = adapter.bot.botInfo;
        logger.info("Telegram bot authenticated", {
          username: me.username ?? me.first_name,
          id: me.id
        });
        logger.info("Polling Telegram updates");
        if (!initialCronRunTriggered) {
          initialCronRunTriggered = true;
          await runCronTick();
        }
      }
    });
  } finally {
    if (cronTimer) {
      clearInterval(cronTimer);
    }
  }
}
