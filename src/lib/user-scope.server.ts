import { createHash } from "node:crypto";
import { AGENT_FILE_ROOT, DEFAULT_OSS_PREFIX, FileAccessError, normalizeAgentFilePath, resolveObjectKey } from "./files";
import { activeAgentFileRoot, fileStorageBackend, ossArtifactRoot } from "./file-config.server";

export type FileAccessMode = "user" | "shared";
export function fileAccessMode(): FileAccessMode {
  const mode = process.env.FILE_ACCESS_MODE || "user";
  if (mode !== "user" && mode !== "shared") throw new FileAccessError(503, "INVALID_CONFIG", "文件访问模式配置无效。");
  return mode;
}

export const userNamespace = (userId: string) => createHash("sha256").update(`agentcore-user:${userId}`).digest("hex").slice(0, 32);
const userFileDirectory = (userId: string) => fileStorageBackend() === "nas"
  ? `${activeAgentFileRoot()}${userNamespace(userId)}`
  : `${ossArtifactRoot()}${userNamespace(userId)}`;
export const artifactDirectory = (userId: string) => fileStorageBackend() === "nas" && fileAccessMode() === "shared"
  ? activeAgentFileRoot().slice(0, -1) : userFileDirectory(userId);
export const upstreamThreadId = (userId: string, threadId: string) => `u_${userNamespace(userId)}_${createHash("sha256").update(threadId).digest("hex").slice(0, 40)}`;
export const sessionArtifactDirectory = (userId: string, conversationId: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)) throw new FileAccessError(400, "INVALID_SESSION", "会话标识格式无效。");
  return `${userFileDirectory(userId)}/${conversationId}`;
};

/** Shared input convention with runloop: uploads are immutable children of one trusted session. */
export const sessionUploadDirectory = (userId: string, conversationId: string) =>
  `${sessionArtifactDirectory(userId, conversationId)}/uploads`;

export function sessionUploadObjectPrefix(userId: string, conversationId: string): string {
  // Upload transport is OSS even when the agent workspace backend is NAS. Keep the logical
  // users/<uid>/<conversationId>/uploads layout identical on both sides.
  sessionArtifactDirectory(userId, conversationId); // validates conversationId
  const directory = `${AGENT_FILE_ROOT}users/${userNamespace(userId)}/${conversationId}/uploads/file`;
  return resolveObjectKey(directory, process.env.OSS_OBJECT_PREFIX || DEFAULT_OSS_PREFIX).slice(0, -4);
}

export function sessionUploadObjectKey(userId: string, conversationId: string, uploadId: string, fileName: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uploadId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(fileName)) {
    throw new FileAccessError(400, "INVALID_UPLOAD_PATH", "上传文件路径无效。");
  }
  return `${sessionUploadObjectPrefix(userId, conversationId)}${uploadId}/${fileName}`;
}
export function assertUserFile(userId: string, path: string, mode = fileAccessMode()) {
  const normalized = normalizeAgentFilePath(path);
  if (!normalized.startsWith(activeAgentFileRoot())) throw new FileAccessError(409, "STORAGE_PATH_MISMATCH", "此文件不属于当前存储；旧文件需要迁移后使用新路径读取。");
  if (mode === "user" && !normalized.startsWith(`${userFileDirectory(userId)}/`)) throw new FileAccessError(403, "FILE_FORBIDDEN", "此文件不在当前账号的文件空间中，请让 Agent 将文件保存到当前账号的输出目录后再预览。");
  return normalized;
}
export function userOssPolicy(userId: string, mode = fileAccessMode()) {
  const bucket = process.env.OSS_BUCKET || "";
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new FileAccessError(503, "OSS_NOT_CONFIGURED", "请配置 OSS bucket。");
  const directory = mode === "shared" ? AGENT_FILE_ROOT : `${ossArtifactRoot()}${userNamespace(userId)}/`;
  const key = resolveObjectKey(`${directory}file`, process.env.OSS_OBJECT_PREFIX || DEFAULT_OSS_PREFIX).slice(0, -4);
  if (/[*?]/.test(key)) throw new FileAccessError(503, "OSS_NOT_CONFIGURED", "OSS 前缀不能包含通配符。");
  return JSON.stringify({ Version: "1", Statement: [{ Effect: "Allow", Action: ["oss:GetObject"], Resource: [`acs:oss:*:*:${bucket}/${key}*`] }] });
}
