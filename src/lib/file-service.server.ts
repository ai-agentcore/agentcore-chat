import type { FileStore } from "./file-store";
import { DEFAULT_OSS_PREFIX, NAS_AGENT_FILE_ROOT, FileAccessError, describeFile, normalizeAgentFilePath, resolveObjectKey, type FileMetadata } from "./files";
import { fileStorageBackend } from "./file-config.server";

type StoreFactory = () => FileStore;
const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" };

function requestedFile(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new FileAccessError(403, "CROSS_SITE_REQUEST", "不允许跨站读取文件。");
  const params = new URL(request.url).searchParams;
  const path = normalizeAgentFilePath(params.get("path") || "");
  const backend = fileStorageBackend();
  if (backend === "nas" && !path.startsWith(NAS_AGENT_FILE_ROOT)) throw new FileAccessError(409, "STORAGE_PATH_MISMATCH", "旧 OSS 文件需要迁移到 NAS 后使用新路径读取。");
  const key = backend === "nas" ? path.slice(NAS_AGENT_FILE_ROOT.length) : resolveObjectKey(path, process.env.OSS_OBJECT_PREFIX || DEFAULT_OSS_PREFIX);
  return { path, key, download: params.get("download") === "1" };
}

function fileError(error: unknown) {
  if (error instanceof FileAccessError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: privateHeaders });
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (status === 404 || ["NoSuchKey", "ENOENT", "ENOTDIR"].includes(code)) return Response.json({ error: "文件不存在，可能尚未生成完成或已被移除。", code: "FILE_NOT_FOUND" }, { status: 404, headers: privateHeaders });
  if (["EACCES", "EPERM", "ELOOP"].includes(code)) return Response.json({ error: "文件访问未获授权，请检查 NAS 接入点和文件读取权限。", code: "NAS_ACCESS_DENIED" }, { status: 403, headers: privateHeaders });
  if (code === "ESTALE") return Response.json({ error: "文件已更新，请重新打开预览。", code: "FILE_CHANGED" }, { status: 409, headers: privateHeaders });
  if (["STS_NOT_CONFIGURED", "STS_UNAVAILABLE", "IDENTITY_REAUTH_REQUIRED"].includes(code)) return Response.json({ error: code === "IDENTITY_REAUTH_REQUIRED" ? "授权已过期，请重新登录。" : "暂时无法获取 NAS 临时凭证，请检查 STS Broker 配置。", code }, { status: [401, 502, 503].includes(status) ? status : 502, headers: privateHeaders });
  if (status === 403 || ["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "SecurityTokenExpired"].includes(code)) return Response.json({ error: "文件访问未获授权，请检查 OSS 凭证和读取权限。", code: "OSS_ACCESS_DENIED" }, { status: 403, headers: privateHeaders });
  if (status === 412) return Response.json({ error: "文件已更新，请重新打开预览。", code: "FILE_CHANGED" }, { status: 409, headers: privateHeaders });
  if (status === 416) return Response.json({ error: "文件读取范围无效。", code: "INVALID_RANGE" }, { status: 416, headers: privateHeaders });
  return Response.json({ error: "暂时无法读取文件，请稍后重试。", code: "FILE_READ_FAILED" }, { status: 502, headers: privateHeaders });
}

function defaultStore(): never {
  throw new FileAccessError(401, "IDENTITY_REQUIRED", "文件访问需要有效的用户身份和目录级授权策略。");
}

async function closeStore(store?: FileStore) {
  try { await store?.close?.(); }
  catch { console.warn("File store cleanup failed."); }
}

/** Keep a NAS mount alive until the last byte or cancellation, including HEAD/errors. */
function leasedBody(body: ReadableStream<Uint8Array>, store: FileStore) {
  const reader = body.getReader();
  let closed = false;
  let finishing: Promise<void> | undefined;
  const finish = () => finishing ||= (async () => {
    closed = true;
    reader.releaseLock();
    await closeStore(store);
  })();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (closed) return;
        if (done) { await finish(); controller.close(); }
        else controller.enqueue(value);
      } catch (error) { await finish(); controller.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { await finish(); } },
  });
}

export async function getFileMetadata(request: Request, factory: StoreFactory = defaultStore) {
  let store: FileStore | undefined;
  try {
    const { path, key } = requestedFile(request);
    store = factory();
    const info = await store.stat(key);
    const description = describeFile(path);
    const metadata: FileMetadata = { path, ...description, size: info.size, modifiedAt: info.modifiedAt, previewable: description.kind === "video" || (description.kind !== "unsupported" && info.size <= description.previewLimit) };
    return Response.json(metadata, { headers: privateHeaders });
  } catch (error) { return fileError(error); }
  finally { await closeStore(store); }
}

export function validateRange(value: string | null, size: number): string | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new FileAccessError(416, "INVALID_RANGE", "文件读取范围无效。");
  const start = match[1] ? Number(match[1]) : undefined;
  const end = match[2] ? Number(match[2]) : undefined;
  if (size === 0 || (start !== undefined && (!Number.isSafeInteger(start) || start >= size)) || (end !== undefined && !Number.isSafeInteger(end)) || (start !== undefined && end !== undefined && end < start) || (start === undefined && end === 0)) {
    throw new FileAccessError(416, "INVALID_RANGE", "文件读取范围无效。");
  }
  return value;
}

export async function getFileContent(request: Request, factory: StoreFactory = defaultStore) {
  let store: FileStore | undefined;
  try {
    const { path, key, download } = requestedFile(request);
    store = factory();
    const info = await store.stat(key);
    const file = describeFile(path);
    if (!download && (file.kind === "unsupported" || (file.kind !== "video" && info.size > file.previewLimit))) {
      throw new FileAccessError(413, "PREVIEW_UNAVAILABLE", "此文件无法在线预览，请下载后查看。");
    }
    const range = validateRange(request.headers.get("range"), info.size);
    const headers = new Headers({ ...privateHeaders,
      "Content-Type": file.contentType,
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="file${file.extension ? `.${file.extension.replace(/[^a-z0-9]/g, "")}` : ""}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Accept-Ranges": "bytes",
    });
    if (info.etag) headers.set("ETag", info.etag);
    if (info.modifiedAt) headers.set("Last-Modified", info.modifiedAt);
    if (request.method === "HEAD") { headers.set("Content-Length", String(info.size)); return new Response(null, { headers }); }
    const result = await store.read(key, { range, etag: info.etag, signal: request.signal });
    if (![200, 206].includes(result.status)) { await result.body.cancel(); throw new FileAccessError(502, "INVALID_FILE_RESPONSE", "文件服务返回异常，请重试。"); }
    if (result.length !== undefined) headers.set("Content-Length", String(result.length));
    if (result.contentRange) headers.set("Content-Range", result.contentRange);
    const response = new Response(store.close ? leasedBody(result.body, store) : result.body, { status: result.status, headers });
    store = undefined;
    return response;
  } catch (error) { return fileError(error); }
  finally { await closeStore(store); }
}
