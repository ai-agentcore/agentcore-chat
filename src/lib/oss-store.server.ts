import OSS from "ali-oss";
import { Readable } from "node:stream";
import { FileAccessError } from "./files";
import { credentialProvider } from "./oss-credentials.server";
import { getStsCredentials, type StsGrant } from "./sts-credentials.server";
import type { FileStore } from "./file-store";
export type { FileStore, StoredFileInfo } from "./file-store";

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

export function createOssFileStore(grant: StsGrant): FileStore {
  const bucket = process.env.OSS_BUCKET;
  const region = process.env.OSS_REGION;
  if (!bucket || !region || bucket.startsWith("replace-")) {
    throw new FileAccessError(503, "OSS_NOT_CONFIGURED", "文件服务尚未配置，请配置服务端 OSS 环境变量。");
  }
  const getCredentials = credentialProvider(() => getStsCredentials(grant));
  // One client per file request; the provider shares and refreshes credentials
  // across requests. Existing download streams do not need to be restarted.
  let clientPromise: Promise<OSS> | undefined;
  const getClient = () => clientPromise ||= getCredentials().then((credentials) => new OSS({
    bucket, region, ...credentials,
    authorizationV4: true,
    secure: true,
    timeout: 30_000,
    endpoint: process.env.OSS_ENDPOINT || undefined,
    cname: process.env.OSS_CNAME === "true",
  }));

  return {
    async stat(key) {
      const result = await (await getClient()).head(key);
      const headers = result.res.headers as Record<string, unknown>;
      if (header(headers, "x-oss-object-type")?.toLowerCase() === "symlink") {
        throw new FileAccessError(403, "SYMLINK_NOT_ALLOWED", "不支持预览链接对象，请使用实际文件。");
      }
      const size = Number(header(headers, "content-length"));
      if (!Number.isSafeInteger(size) || size < 0) throw new FileAccessError(502, "INVALID_FILE_SIZE", "无法读取文件大小。");
      return { size, etag: header(headers, "etag"), modifiedAt: header(headers, "last-modified") };
    },
    async read(key, { range, etag, signal }) {
      signal.throwIfAborted();
      const result = await (await getClient()).getStream(key, { headers: { ...(range ? { Range: range } : {}), ...(etag ? { "If-Match": etag } : {}) } });
      const stream = result.stream as Readable | undefined;
      if (!stream) throw new FileAccessError(502, "EMPTY_STREAM", "文件服务未返回文件内容。");
      const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
      const abort = () => stream.destroy(new Error("File request aborted"));
      const cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      stream.once("close", cleanup);
      if (signal.aborted) abort();
      const headers = result.res.headers as Record<string, unknown>;
      const length = Number(header(headers, "content-length"));
      return { body, status: result.res.status, length: Number.isSafeInteger(length) && length >= 0 ? length : undefined, contentRange: header(headers, "content-range") };
    },
  };
}
