import type { UploadedAttachment } from "./types";

type Ticket = {
  uploadId: string;
  objectName: string;
  uploadUrl: string;
  headers: Record<string, string>;
};

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error || "文件上传失败，请稍后重试。");
  return body as T;
}

export async function uploadAttachment(threadId: string, file: File, userId: string): Promise<UploadedAttachment> {
  const mimeType = file.type || "application/octet-stream";
  const common = { threadId, name: file.name, mimeType, size: file.size };
  const ticket = await json<Ticket>(await fetch("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Account-ID": userId },
    body: JSON.stringify({ action: "create", ...common }),
  }));
  const uploaded = await fetch(ticket.uploadUrl, { method: "PUT", headers: ticket.headers, body: file });
  if (!uploaded.ok) throw new Error("文件直传 OSS 失败，请检查网络后重试。");
  return json<UploadedAttachment>(await fetch("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Account-ID": userId },
    body: JSON.stringify({ action: "confirm", ...common, uploadId: ticket.uploadId, objectName: ticket.objectName }),
  }));
}
