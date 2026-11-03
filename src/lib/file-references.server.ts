import type { FileStore } from "./file-store";
import { ossArtifactRoot } from "./file-config.server";
import { DEFAULT_OSS_PREFIX, FileAccessError, normalizeAgentFilePath, resolveObjectKey } from "./files";
import { upstreamThreadId, userNamespace } from "./user-scope.server";

export interface FileReference {
  id: string;
  path: string;
  name: string;
}

interface FileReferenceEntry {
  path: string;
  name: string;
  size: number;
  createdAt: string;
}

interface ConversationFileManifest {
  version: 1;
  conversationId: string;
  files: Record<string, FileReferenceEntry>;
}

const FILE_REFERENCE_ID = /^f_[A-Za-z0-9_-]{22}$/;
const CLIENT_CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MANIFEST_NAME = ".files.json";
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

function missing(error: unknown) {
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return status === 404 || ["NoSuchKey", "ENOENT", "ENOTDIR"].includes(code);
}

function validRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 2048 || value.startsWith("/") || /[\\\u0000-\u001f\u007f<>|`]/.test(value)) return false;
  return value.split("/").every((part) => part && part !== "." && part !== "..");
}

function validEntry(value: unknown): value is FileReferenceEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<FileReferenceEntry>;
  return validRelativePath(entry.path) && typeof entry.name === "string" && entry.name === entry.path.split("/").at(-1)
    && typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0
    && typeof entry.createdAt === "string" && Number.isFinite(Date.parse(entry.createdAt));
}

function parseManifest(value: string, conversationId: string): ConversationFileManifest | undefined {
  let manifest: unknown;
  try { manifest = JSON.parse(value); } catch { return undefined; }
  if (!manifest || typeof manifest !== "object") return undefined;
  const candidate = manifest as Partial<ConversationFileManifest>;
  if (candidate.version !== 1 || candidate.conversationId !== conversationId || !candidate.files
    || typeof candidate.files !== "object" || Array.isArray(candidate.files)) return undefined;
  return candidate as ConversationFileManifest;
}

async function limitedText(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MANIFEST_BYTES) {
        await reader.cancel();
        throw new FileAccessError(502, "INVALID_FILE_REFERENCE", "会话文件映射无效。");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

function upstreamConversation(userId: string, conversationId: string): string | undefined {
  if (!CLIENT_CONVERSATION_ID.test(conversationId)) return undefined;
  return upstreamThreadId(userId, conversationId);
}

export function conversationManifestObjectKey(userId: string, conversationId: string): string | undefined {
  const upstream = upstreamConversation(userId, conversationId);
  if (!upstream) return undefined;
  const path = `${ossArtifactRoot()}${userNamespace(userId)}/${upstream}/${MANIFEST_NAME}`;
  return resolveObjectKey(path, process.env.OSS_OBJECT_PREFIX || DEFAULT_OSS_PREFIX);
}

export async function findFileReference(userId: string, conversationId: string, id: string, store: FileStore, signal: AbortSignal): Promise<FileReference | undefined> {
  if (!FILE_REFERENCE_ID.test(id)) return undefined;
  const upstream = upstreamConversation(userId, conversationId);
  const key = conversationManifestObjectKey(userId, conversationId);
  if (!upstream || !key) return undefined;
  let info;
  try { info = await store.stat(key); }
  catch (error) { if (missing(error)) return undefined; throw error; }
  if (info.size > MAX_MANIFEST_BYTES) throw new FileAccessError(502, "INVALID_FILE_REFERENCE", "会话文件映射无效。");
  let result;
  try { result = await store.read(key, { etag: info.etag, signal }); }
  catch (error) { if (missing(error)) return undefined; throw error; }
  if (result.status !== 200) {
    await result.body.cancel();
    if (result.status === 404) return undefined;
    throw new FileAccessError(502, "INVALID_FILE_REFERENCE", "会话文件映射读取失败。");
  }
  const manifest = parseManifest(await limitedText(result.body), upstream);
  const entry = manifest?.files[id];
  if (!validEntry(entry)) return undefined;
  const path = normalizeAgentFilePath(`${ossArtifactRoot()}${userNamespace(userId)}/${upstream}/${entry.path}`);
  return { id, path, name: entry.name };
}
