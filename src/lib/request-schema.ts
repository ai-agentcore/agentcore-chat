import { z } from "zod";

export const uploadedAttachmentSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  size: z.number().int().positive().max(32 * 1024 * 1024),
  uri: z.string().min(1).max(2048),
  etag: z.string().min(1).max(256),
  region: z.string().regex(/^oss-[a-z0-9-]+$/),
}).strict();

export const chatRequestSchema = z.object({
  threadId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  runId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  messages: z.array(z.object({
    id: z.string().min(1).max(128),
    role: z.enum(["user", "assistant"]),
    content: z.string().max(100_000),
    attachments: z.array(uploadedAttachmentSchema).max(10).optional(),
  }).refine((message) => message.content.trim() || message.attachments?.length, {
    message: "A message must contain text or an attachment",
  })).min(1).max(400),
}).refine((input) => input.messages.at(-1)?.role === "user", {
  message: "The last message must be a user message",
});
