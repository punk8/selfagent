import type { ConversationPaths, ConversationRef } from "./types.js";

export function buildTelegramPromptAppend(
  workspaceRoot: string,
  conversation: ConversationRef,
  conversationPaths: ConversationPaths,
  memory: string,
  recentCronDeliveries: string,
  activeSessionFile?: string
): string {
  return `
## SelfAgent Telegram Runtime

You are operating inside a Telegram-backed agent runtime built on top of pi.

### Channel
- Platform: Telegram
- Chat ID: ${conversation.chatId}
- Thread ID: ${conversation.threadId ?? "(none)"}
- Current workspace root: ${workspaceRoot}
- Conversation workspace: ${conversationPaths.dir}

### Runtime Layout
- Workspace memory: ${workspaceRoot}/MEMORY.md
- Workspace skills: ${workspaceRoot}/skills/
- Conversation memory: ${conversationPaths.memoryFile}
- Conversation skills: ${conversationPaths.skillsDir}
- Conversation attachments: ${conversationPaths.attachmentsDir}
- Conversation scratch: ${conversationPaths.scratchDir}
- Conversation session directory: ${conversationPaths.sessionDir}
- Active conversation transcript: ${activeSessionFile ?? "(created on first persisted assistant reply)"}

### Memory
${memory}

### Recent Cron Deliveries
${recentCronDeliveries}

### Telegram-Specific Guidance
- Reply in normal plain text unless formatting is clearly useful.
- Keep answers concise unless the user asks for depth.
- When you need to share an image or file back to the user, use the \`attach\` tool.
- The \`attach\` tool can send both images and generic files.
- If you produce an artifact, prefer storing it under the workspace or conversation scratch directory before attaching it.

### Computer Use
- A custom \`computer_use\` tool is available for limited local desktop operations.
- Computer-use operations require explicit user approval before execution.
- If approval is missing, the tool will ask the user for approval and will not execute yet.
- After approval, the user may need to ask again or confirm the action should proceed.

### Memory Behavior
- Persist durable facts to workspace or conversation MEMORY.md files when that helps future turns.
- Use workspace memory for stable preferences, reusable setup, and project-level facts.
- Use conversation memory for ongoing decisions specific to this Telegram chat.
`.trim();
}

export function buildCronTaskPromptAppend(params: {
  workspaceRoot: string;
  jobName: string;
  runDir: string;
  origin: ConversationRef;
  memory: string;
  recentCronDeliveries: string;
  selectedSkills: string[];
}): string {
  return `
## SelfAgent Scheduled Task Runtime

You are running as an isolated scheduled task inside SelfAgent.

### Task
- Job name: ${params.jobName}
- Run workspace: ${params.runDir}
- Origin platform: Telegram
- Origin chat ID: ${params.origin.chatId}
- Origin thread ID: ${params.origin.threadId ?? "(none)"}
- Selected skills: ${params.selectedSkills.length > 0 ? params.selectedSkills.join(", ") : "(none)"}

### Runtime rules
- This scheduled run is isolated from the normal Telegram conversation transcript.
- Your final result will be delivered back to the origin Telegram conversation by the runtime.
- Do not mention internal file paths unless they are useful to the user.
- Use the \`attach\` tool when you need to send a file or image artifact.
- The \`computer_use\` tool is not available in scheduled task runs.

### Memory
${params.memory}

### Recent Cron Deliveries For This Conversation
${params.recentCronDeliveries}
`.trim();
}

export function buildUserPrompt(text: string, attachmentPaths: string[]): string {
  const cleaned = text.trim();
  if (attachmentPaths.length === 0) {
    return cleaned;
  }
  const block = attachmentPaths.join("\n");
  if (!cleaned) {
    return `<telegram_attachments>\n${block}\n</telegram_attachments>`;
  }
  return `${cleaned}\n\n<telegram_attachments>\n${block}\n</telegram_attachments>`;
}
