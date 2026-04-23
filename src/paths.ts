import { resolve } from "node:path";
import type { ConversationPaths, ConversationRef } from "./types.js";

function sanitizePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function getConversationPaths(stateRoot: string, conversation: ConversationRef): ConversationPaths {
  const key = conversation.threadId
    ? `telegram-chat-${conversation.chatId}-thread-${conversation.threadId}`
    : `telegram-chat-${conversation.chatId}`;
  const dir = resolve(stateRoot, "conversations", "telegram", sanitizePart(key));
  return {
    key,
    dir,
    sessionFile: resolve(dir, "session.jsonl"),
    attachmentsDir: resolve(dir, "attachments"),
    skillsDir: resolve(dir, "skills"),
    scratchDir: resolve(dir, "scratch"),
    memoryFile: resolve(dir, "MEMORY.md"),
    approvalFile: resolve(dir, "approvals.json")
  };
}
