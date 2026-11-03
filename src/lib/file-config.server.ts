import { AGENT_FILE_ROOT, NAS_AGENT_FILE_ROOT, FileAccessError } from "./files";

export function fileStorageBackend(): "oss" | "nas" {
  const backend = process.env.FILE_STORAGE_BACKEND || "oss";
  if (backend !== "oss" && backend !== "nas") throw new FileAccessError(503, "INVALID_CONFIG", "文件存储类型配置无效。");
  return backend;
}

export const activeAgentFileRoot = () => fileStorageBackend() === "nas" ? NAS_AGENT_FILE_ROOT : AGENT_FILE_ROOT;

/** OSS delivery root shared with agentcore-runloop; no application default. */
export function ossArtifactRoot(): string {
  const configured = process.env.AGENTCORE_ARTIFACT_ROOT?.trim();
  if (!configured) throw new FileAccessError(503, "INVALID_CONFIG", "请配置 AGENTCORE_ARTIFACT_ROOT。");
  const root = configured.endsWith("/") ? configured : `${configured}/`;
  if (!root.startsWith(AGENT_FILE_ROOT) || /[\\\u0000-\u001f\u007f<>|`]/.test(root)) {
    throw new FileAccessError(503, "INVALID_CONFIG", "AGENTCORE_ARTIFACT_ROOT 必须位于 OSS 文件挂载根内。");
  }
  const suffix = root.slice(AGENT_FILE_ROOT.length, -1);
  const parts = suffix ? suffix.split("/") : [];
  if (parts.some(part => !part || part === "." || part === "..")) {
    throw new FileAccessError(503, "INVALID_CONFIG", "AGENTCORE_ARTIFACT_ROOT 配置无效。");
  }
  return root;
}
