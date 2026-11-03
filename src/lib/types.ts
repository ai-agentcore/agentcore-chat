export type MessageStatus = "complete" | "streaming" | "stopped" | "error";

export interface ToolActivity {
  id: string;
  name: string;
  status: "running" | "complete";
  arguments?: string;
  result?: string;
  isError?: boolean;
}

export type RunActivity =
  | { id: string; type: "reasoning"; content: string }
  | { id: string; type: "tool"; toolId: string };

export interface UploadedAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  uri: string;
  etag: string;
  region: string;
}

export interface PendingAttachment {
  localId: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  attachment?: UploadedAttachment;
  error?: string;
  previewFile?: File;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  startedAt?: number;
  completedAt?: number;
  reasoning?: string;
  tools?: ToolActivity[];
  runActivities?: RunActivity[];
  attachments?: UploadedAttachment[];
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  project?: string;
  messages: ChatMessage[];
}

export interface ChatStore {
  conversations: Conversation[];
  activeId: string | null;
}

export type AgentEvent = { type: string; [key: string]: unknown };
