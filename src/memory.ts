import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ConversationPaths } from "./types.js";

export function readMemory(workspaceRoot: string, conversationPaths: ConversationPaths): string {
  const parts: string[] = [];
  const workspaceMemory = resolve(workspaceRoot, "MEMORY.md");
  if (existsSync(workspaceMemory)) {
    const content = readFileSync(workspaceMemory, "utf8").trim();
    if (content) parts.push(`## Workspace Memory\n${content}`);
  }
  if (existsSync(conversationPaths.memoryFile)) {
    const content = readFileSync(conversationPaths.memoryFile, "utf8").trim();
    if (content) parts.push(`## Conversation Memory\n${content}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : "(no working memory yet)";
}
