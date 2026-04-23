export interface ConversationRef {
  platform: "telegram";
  chatId: number;
  threadId?: number;
  userId?: number;
}

export interface ConversationPaths {
  key: string;
  dir: string;
  sessionFile: string;
  attachmentsDir: string;
  skillsDir: string;
  scratchDir: string;
  memoryFile: string;
  approvalFile: string;
}

export interface IncomingAttachment {
  kind: "image" | "document";
  filePath: string;
  originalName: string;
}

export interface ApprovalRequest {
  requestId: string;
  requestedByUserId?: number;
  summary: string;
  createdAt: string;
}

export interface ApprovalState {
  pending?: ApprovalRequest;
  sessionGrantedToUserId?: number;
  sessionGrantedAt?: string;
  oneTimeGrantedToUserId?: number;
  oneTimeGrantedAt?: string;
}

export interface ComputerUseRequest {
  action: "open_app" | "open_url" | "type_text" | "press_key";
  summary: string;
  app?: string;
  url?: string;
  text?: string;
  key?: string;
}

export interface ToolContextBridge {
  workspaceRoot: string;
  stateRoot: string;
  conversation: ConversationRef;
  paths: ConversationPaths;
}
