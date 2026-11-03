import { z } from "zod";
import { getSession, getUserIdentity, unauthorized } from "@/lib/auth.server";
import { FileAccessError } from "@/lib/files";
import { confirmUpload, createUploadTicket } from "@/lib/upload-service.server";
import { upstreamThreadId } from "@/lib/user-scope.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const base = {
  threadId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  size: z.number().int().positive().max(32 * 1024 * 1024),
};
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), ...base }).strict(),
  z.object({ action: z.literal("confirm"), ...base,
    uploadId: z.string().min(1).max(128), objectName: z.string().min(1).max(255),
  }).strict(),
]);

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("host") || new URL(request.url).host;
  try {
    const source = new URL(origin);
    return source.host === host && ["http:", "https:"].includes(source.protocol);
  } catch { return false; }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "不允许跨站请求。" }, { status: 403 });
  const session = await getSession(request.headers);
  if (!session) return unauthorized();
  const expectedUser = request.headers.get("x-account-id");
  if (expectedUser && expectedUser !== session.user.id) return unauthorized();
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "上传请求格式有误。" }, { status: 400 });

  try {
    const identity = await getUserIdentity(session);
    const threadId = upstreamThreadId(session.user.id, parsed.data.threadId);
    const result = parsed.data.action === "create"
      ? await createUploadTicket(session.user.id, identity, { ...parsed.data, threadId })
      : await confirmUpload(session.user.id, identity, { ...parsed.data, threadId });
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const known = error instanceof FileAccessError;
    return Response.json({ error: known ? error.message : "文件上传服务暂时不可用。", code: known ? error.code : "UPLOAD_FAILED" },
      { status: known ? error.status : 502, headers: { "Cache-Control": "private, no-store" } });
  }
}
