export const AGENT_FILE_ROOT = "/mnt/oss/data/";
export const NAS_AGENT_FILE_ROOT = "/mnt/agenticfs/shared/";
export const AGENT_FILE_ROOTS = [AGENT_FILE_ROOT, NAS_AGENT_FILE_ROOT] as const;
export const DEFAULT_OSS_PREFIX = "agentcore/ppts";
export const MAX_PREVIEW_BYTES = 30 * 1024 * 1024;
export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
export const FILE_REFERENCE_PATTERN = /^\/f\/f_[A-Za-z0-9_-]{22}$/;

export type PreviewKind = "pptx" | "docx" | "pdf" | "image" | "video" | "markdown" | "text" | "unsupported";

export interface FileMetadata {
  path: string;
  name: string;
  extension: string;
  kind: PreviewKind;
  size: number;
  contentType: string;
  modifiedAt?: string;
  previewable: boolean;
  previewLimit: number;
}

export class FileAccessError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** Only the documented mount can be read. No URLs, traversal or ambiguous paths. */
export function normalizeAgentFilePath(input: string): string {
  let path = input.startsWith("sandbox:") ? input.slice(8) : input;
  if (/%[\da-f]{2}/i.test(path)) {
    if (/%(?:2f|5c)/i.test(path)) throw new FileAccessError(400, "INVALID_PATH", "文件路径不能包含编码的分隔符。");
    try { path = decodeURIComponent(path); }
    catch { throw new FileAccessError(400, "INVALID_PATH", "文件路径编码无效。"); }
  }
  const root = AGENT_FILE_ROOTS.find((root) => path.startsWith(root));
  if (!root || path.length > 2048 || /[\\\u0000-\u001f\u007f]/.test(path) || /%[\da-f]{2}/i.test(path)) {
    throw new FileAccessError(400, "INVALID_PATH", "只能读取 Agent 文件目录中的文件。");
  }
  const parts = path.slice(root.length).split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new FileAccessError(400, "INVALID_PATH", "文件路径无效。");
  }
  return path;
}

export function normalizeFileReference(input: string): string {
  if (FILE_REFERENCE_PATTERN.test(input)) return input;
  return normalizeAgentFilePath(input);
}

export function resolveObjectKey(path: string, prefix = DEFAULT_OSS_PREFIX): string {
  const normalized = normalizeAgentFilePath(path);
  if (!normalized.startsWith(AGENT_FILE_ROOT)) throw new FileAccessError(409, "STORAGE_PATH_MISMATCH", "此文件属于 NAS，请配置对应的文件存储后读取。");
  const root = prefix.replace(/\/$/, "");
  if (!root || root.startsWith("/") || /[\\\u0000-\u001f]/.test(root) || root.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new FileAccessError(503, "INVALID_CONFIG", "文件服务的目录配置无效。");
  }
  return `${root}/${normalized.slice(AGENT_FILE_ROOT.length)}`;
}

const imageTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml" };
const textExtensions = new Set(["txt", "md", "markdown", "json", "csv", "tsv", "log", "yaml", "yml", "xml", "html", "css", "js", "ts", "py", "sh", "sql"]);

export function describeFile(path: string): Pick<FileMetadata, "name" | "extension" | "kind" | "contentType" | "previewLimit"> {
  const name = path.split("/").at(-1) || "文件";
  const extension = name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "";
  const kind: PreviewKind = extension === "pptx" ? "pptx" : extension === "docx" ? "docx" : extension === "pdf" ? "pdf" : imageTypes[extension] ? "image" : extension === "mp4" ? "video" : ["md", "markdown"].includes(extension) ? "markdown" : textExtensions.has(extension) ? "text" : "unsupported";
  const contentType = kind === "pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    : kind === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : kind === "pdf" ? "application/pdf" : kind === "image" ? imageTypes[extension] : kind === "video" ? "video/mp4" : kind === "text" || kind === "markdown" ? "text/plain; charset=utf-8" : "application/octet-stream";
  return { name, extension, kind, contentType, previewLimit: kind === "text" || kind === "markdown" ? MAX_TEXT_PREVIEW_BYTES : MAX_PREVIEW_BYTES };
}

export function fileApiUrl(path: string, action: "metadata" | "content" | "download" = "metadata", conversationId?: string) {
  if (FILE_REFERENCE_PATTERN.test(path)) {
    const id = path.slice(3);
    const base = `/api/files/ref/${encodeURIComponent(id)}`;
    const query = new URLSearchParams();
    if (conversationId) query.set("conversationId", conversationId);
    if (action === "download") query.set("download", "1");
    const suffix = query.size ? `?${query}` : "";
    return action === "metadata" ? `${base}${suffix}` : `${base}/content${suffix}`;
  }
  const query = new URLSearchParams({ path });
  if (action === "download") query.set("download", "1");
  return `/api/files${action === "metadata" ? "" : "/content"}?${query}`;
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
