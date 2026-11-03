import { getSession, getUserIdentity, unauthorized } from "./auth.server";
import { assertUserFile, fileAccessMode, userOssPolicy } from "./user-scope.server";
import { createOssFileStore } from "./oss-store.server";
import { createNasFileStore } from "./nas-store.server";
import { fileStorageBackend } from "./file-config.server";
import { getFileContent, getFileMetadata } from "./file-service.server";
import { FileAccessError } from "./files";
import { AppIdentityError } from "./app-identity.server";

export async function userFileRequest(request: Request, content = false) {
  const session = await getSession(request.headers);
  if (!session) return unauthorized();
  try {
    const mode = fileAccessMode();
    assertUserFile(session.user.id, new URL(request.url).searchParams.get("path") || "", mode);
    // Identity verification and the authorized file scope are independent.
    const identity = await getUserIdentity(session);
    if (fileStorageBackend() === "nas") return (content ? getFileContent : getFileMetadata)(request, () => createNasFileStore(identity));
    const policy = userOssPolicy(session.user.id, mode);
    return (content ? getFileContent : getFileMetadata)(request, () => createOssFileStore({ identity, policy }));
  } catch (error) {
    const reauth = error instanceof Error && error.message === "IDENTITY_REAUTH_REQUIRED";
    const known = error instanceof FileAccessError || error instanceof AppIdentityError;
    return Response.json({ error: reauth ? "阿里云授权已过期，请在账号设置中退出并重新登录。" : known ? error.message : "暂时无法读取文件。",
      code: reauth ? "IDENTITY_REAUTH_REQUIRED" : known ? error.code : "FILE_READ_FAILED" },
      { status: reauth ? 401 : known ? error.status : 502, headers: { "Cache-Control": "private, no-store" } });
  }
}
