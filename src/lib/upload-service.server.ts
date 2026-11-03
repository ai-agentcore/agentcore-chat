import OSS from "ali-oss";
import { randomUUID } from "node:crypto";
import { FileAccessError } from "./files";
import { getStsCredentials, type StsGrant } from "./sts-credentials.server";
import { sessionUploadObjectKey } from "./user-scope.server";
import type { UploadedAttachment } from "./types";

export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface UploadInput {
  threadId: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface UploadLocator extends UploadInput {
  uploadId: string;
  objectName: string;
}

function uploadConfig() {
  const bucket = process.env.OSS_BUCKET?.trim() || "";
  const region = process.env.OSS_REGION?.trim() || "";
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || !/^oss-[a-z0-9-]+$/.test(region)) {
    throw new FileAccessError(503, "OSS_NOT_CONFIGURED", "文件上传尚未配置，请配置 OSS bucket 和 region。");
  }
  return { bucket, region };
}

function validateInput(input: UploadInput) {
  if (!SAFE_ID.test(input.threadId) || !input.name.trim() || input.name.length > 255
    || !input.mimeType || input.mimeType.length > 255 || /[\r\n]/.test(input.mimeType)
    || !Number.isSafeInteger(input.size) || input.size <= 0 || input.size > MAX_UPLOAD_BYTES) {
    throw new FileAccessError(400, "INVALID_UPLOAD", `请选择不超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB 的有效文件。`);
  }
}

export function safeUploadObjectName(name: string): string {
  const match = name.trim().match(/\.([A-Za-z0-9]{1,10})$/);
  return `file${match ? `.${match[1].toLowerCase()}` : ".bin"}`;
}

export function uploadOssPolicy(bucket: string, key: string): string {
  return JSON.stringify({ Version: "1", Statement: [{
    Effect: "Allow",
    Action: ["oss:PutObject", "oss:GetObject"],
    Resource: [`acs:oss:*:*:${bucket}/${key}`],
  }] });
}

export function downloadOssPolicy(bucket: string, key: string): string {
  return JSON.stringify({ Version: "1", Statement: [{
    Effect: "Allow",
    Action: ["oss:GetObject"],
    Resource: [`acs:oss:*:*:${bucket}/${key}`],
  }] });
}

async function client(grant: StsGrant) {
  const config = uploadConfig();
  const credentials = await getStsCredentials(grant);
  return { ...config, value: new OSS({
    ...config,
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
    stsToken: credentials.securityToken,
    authorizationV4: true,
    secure: true,
    timeout: 30_000,
    endpoint: process.env.OSS_ENDPOINT || undefined,
    cname: process.env.OSS_CNAME === "true",
  }) };
}

export async function createUploadTicket(userId: string, identity: StsGrant["identity"], input: UploadInput) {
  validateInput(input);
  const uploadId = `up_${randomUUID().replaceAll("-", "")}`;
  const objectName = safeUploadObjectName(input.name);
  const key = sessionUploadObjectKey(userId, input.threadId, uploadId, objectName);
  const { bucket, region, value } = await client({ identity, policy: uploadOssPolicy(uploadConfig().bucket, key) });
  const uploadUrl = value.signatureUrl(key, { method: "PUT", expires: 10 * 60, "Content-Type": input.mimeType });
  return {
    uploadId, objectName, uploadUrl,
    headers: { "Content-Type": input.mimeType },
    uri: `oss://${bucket}/${key}`,
    region,
  };
}

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

export async function confirmUpload(userId: string, identity: StsGrant["identity"], input: UploadLocator) {
  validateInput(input);
  if (!SAFE_ID.test(input.uploadId) || input.objectName !== safeUploadObjectName(input.name)) {
    throw new FileAccessError(400, "INVALID_UPLOAD", "上传文件引用无效。");
  }
  const key = sessionUploadObjectKey(userId, input.threadId, input.uploadId, input.objectName);
  const { bucket, region, value } = await client({ identity, policy: uploadOssPolicy(uploadConfig().bucket, key) });
  const result = await value.head(key);
  const headers = result.res.headers as Record<string, unknown>;
  if (header(headers, "x-oss-object-type")?.toLowerCase() === "symlink") {
    throw new FileAccessError(400, "INVALID_UPLOAD", "不支持链接对象。");
  }
  const actualSize = Number(header(headers, "content-length"));
  const etag = header(headers, "etag");
  const actualType = header(headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (actualSize !== input.size || !etag || actualType !== input.mimeType.toLowerCase()) {
    throw new FileAccessError(409, "UPLOAD_INCOMPLETE", "文件上传尚未完成，请重试。");
  }
  return {
    id: input.uploadId,
    name: input.name,
    mimeType: input.mimeType,
    size: actualSize,
    uri: `oss://${bucket}/${key}`,
    etag,
    region,
  };
}

/** Create short-lived server-to-server read tickets; file bytes still bypass Chat. */
export async function createAttachmentDownloadTickets(
  userId: string,
  identity: StsGrant["identity"],
  threadId: string,
  attachments: UploadedAttachment[],
) {
  const unique = [...new Map(attachments.map(attachment => [attachment.uri, attachment])).values()];
  return Promise.all(unique.map(async attachment => {
    const key = sessionUploadObjectKey(userId, threadId, attachment.id, safeUploadObjectName(attachment.name));
    const config = uploadConfig();
    const { bucket, value } = await client({ identity, policy: downloadOssPolicy(config.bucket, key) });
    return {
      uri: `oss://${bucket}/${key}`,
      url: value.signatureUrl(key, { method: "GET", expires: 10 * 60 }),
    };
  }));
}
