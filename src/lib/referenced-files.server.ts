import { AppIdentityError } from "./app-identity.server";
import { getSession, getUserIdentity, unauthorized } from "./auth.server";
import { fileStorageBackend } from "./file-config.server";
import { findFileReference } from "./file-references.server";
import { FileAccessError } from "./files";
import { createOssFileStore } from "./oss-store.server";
import { userFileRequest } from "./user-files.server";
import { fileAccessMode, userOssPolicy } from "./user-scope.server";

const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

function referenceError(error: unknown) {
  const reauth = error instanceof Error && error.message === "IDENTITY_REAUTH_REQUIRED";
  const known = error instanceof FileAccessError || error instanceof AppIdentityError;
  return Response.json({
    error: reauth ? "阿里云授权已过期，请在账号设置中退出并重新登录。" : known ? error.message : "暂时无法读取文件编号。",
    code: reauth ? "IDENTITY_REAUTH_REQUIRED" : known ? error.code : "FILE_REFERENCE_READ_FAILED",
  }, { status: reauth ? 401 : known ? error.status : 502, headers: privateHeaders });
}

export async function referencedFileRequest(request: Request, id: string, content = false, download = false) {
  const session = await getSession(request.headers);
  if (!session) return unauthorized();
  if (fileStorageBackend() !== "oss") {
    return Response.json({ error: "文件编号不存在或不属于当前账号。", code: "FILE_REFERENCE_NOT_FOUND" }, { status: 404, headers: privateHeaders });
  }
  let store: ReturnType<typeof createOssFileStore> | undefined;
  try {
    const conversationId = new URL(request.url).searchParams.get("conversationId") || "";
    const identity = await getUserIdentity(session);
    store = createOssFileStore({ identity, policy: userOssPolicy(session.user.id, fileAccessMode()) });
    const reference = await findFileReference(session.user.id, conversationId, id, store, request.signal);
    if (!reference) return Response.json({ error: "文件编号不存在或不属于当前账号。", code: "FILE_REFERENCE_NOT_FOUND" }, { status: 404, headers: privateHeaders });
    const url = new URL(request.url);
    url.pathname = content ? "/api/files/content" : "/api/files";
    url.search = new URLSearchParams({ path: reference.path, ...(download ? { download: "1" } : {}) }).toString();
    const internal = new Request(url, { method: request.method, headers: request.headers, signal: request.signal });
    const response = await userFileRequest(internal, content);
    if (content || !response.ok) return response;
    const metadata = await response.json();
    return Response.json({ ...metadata, path: `/f/${reference.id}` }, { status: response.status, headers: response.headers });
  } catch (error) { return referenceError(error); }
  finally {
    try { await store?.close?.(); }
    catch { console.warn("File reference store cleanup failed."); }
  }
}
