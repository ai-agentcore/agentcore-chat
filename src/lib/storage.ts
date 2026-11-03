import { z } from "zod";
import type { ChatStore } from "./types";
import { isFailedToolResult } from "./tool-result";

export const STORAGE_KEY = "agentcore-chat:v1";
export const emptyStore: ChatStore = { conversations: [], activeId: null };

const storedMessage = z.object({
  id: z.string(), role: z.enum(["user", "assistant"]), content: z.string(),
  status: z.enum(["complete", "streaming", "stopped", "error"]),
  startedAt: z.number().nonnegative().optional(), completedAt: z.number().nonnegative().optional(),
  reasoning: z.string().optional(), error: z.string().optional(),
  runActivities: z.array(z.discriminatedUnion("type", [
    z.object({ id: z.string(), type: z.literal("reasoning"), content: z.string() }),
    z.object({ id: z.string(), type: z.literal("tool"), toolId: z.string() }),
  ])).optional(),
  attachments: z.array(z.object({
    id: z.string(), name: z.string(), mimeType: z.string(), size: z.number(),
    uri: z.string(), etag: z.string(), region: z.string(),
  })).optional(),
  tools: z.array(z.object({
    id: z.string(), name: z.string(), status: z.enum(["running", "complete"]),
    arguments: z.string().optional(), result: z.string().optional(), isError: z.boolean().optional(),
  })).optional(),
});

const storedChat = z.object({
  activeId: z.string().nullable(),
  conversations: z.array(z.object({
    id: z.string(), title: z.string(), createdAt: z.number(), updatedAt: z.number(),
    pinned: z.boolean().optional(), project: z.string().min(1).max(48).optional(),
    messages: z.array(storedMessage),
  })),
});

export function restoreStore(raw: string | null): ChatStore {
  if (!raw) return { ...emptyStore };
  const result = storedChat.safeParse(JSON.parse(raw));
  if (!result.success) throw new Error("Invalid saved conversations");
  return {
    activeId: result.data.conversations.some((chat) => chat.id === result.data.activeId) ? result.data.activeId : null,
    conversations: result.data.conversations.map((chat) => ({
      ...chat,
      messages: chat.messages.map((message) => ({
        ...message,
        status: message.status === "streaming" ? "stopped" as const : message.status,
        ...(message.tools ? { tools: message.tools.map((tool) => isFailedToolResult(tool.result) ? { ...tool, isError: true } : tool) } : {}),
      })),
    })),
  };
}
