import { getAuth } from "@/lib/auth.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const allowed = new Set(["/sign-in/email", "/sign-up/email", "/sign-in/social", "/sign-out", "/get-session", "/change-password", "/callback/aliyun"]);
async function handle(request: Request) {
  const endpoint = new URL(request.url).pathname.slice("/api/auth".length);
  // Tokens and account-linking APIs are intentionally server-only / unavailable.
  if (!allowed.has(endpoint)) return Response.json({ error: "Not found" }, { status: 404 });
  if (request.method === "POST" && request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 16_384) { await reader.cancel(); return new Response(null, { status: 413 }); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    request = new Request(request, { body: Buffer.concat(chunks).toString("utf8") });
  }
  if (request.method === "POST" && ["/sign-up/email", "/sign-in/social"].includes(endpoint)) {
    if (Number(request.headers.get("content-length")) > 16_384) return new Response(null, { status: 413 });
    let body;
    try { body = await request.clone().json(); } catch { return Response.json({ message: "请求格式有误。" }, { status: 400 }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ message: "请求格式有误。" }, { status: 400 });
    if (endpoint === "/sign-up/email" && (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80 || typeof body.email !== "string" || body.email.trim().toLowerCase().endsWith(".invalid"))) {
      return Response.json({ message: "请输入有效的昵称和邮箱。" }, { status: 400 });
    }
    if (endpoint === "/sign-in/social" && (body.provider !== "aliyun" || body.idToken)) return new Response(null, { status: 400 });
  }
  const response = await (await getAuth()).handler(request);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export const GET = handle;
export const POST = handle;
