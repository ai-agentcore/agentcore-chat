import { chatRequestSchema } from "@/lib/request-schema";
import { getSession, getUserIdentity, unauthorized } from "@/lib/auth.server";
import { sessionArtifactDirectory, sessionUploadObjectKey, upstreamThreadId, userNamespace } from "@/lib/user-scope.server";
import { proxyAgentStream } from "@/lib/agent-proxy.server";
import { activeAgentFileRoot, fileStorageBackend } from "@/lib/file-config.server";
import { resolveAgentApiUrl } from "@/lib/agent-api-config.server";
import { createAttachmentDownloadTickets, safeUploadObjectName } from "@/lib/upload-service.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function configured() {
  const key = process.env.AGENT_API_KEY;
  return Boolean(resolveAgentApiUrl() && key && key !== "replace-with-your-api-key");
}

export async function GET(request: Request) {
  if (!await getSession(request.headers)) return unauthorized();
  return Response.json({ configured: configured() }, { headers: { "Cache-Control": "no-store" } });
}

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("empty");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_000_000) { await reader.cancel(); throw new Error("too-large"); }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } finally { reader.releaseLock(); }
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin) {
    // Next.js may reconstruct request.url with its internal hostname. The Host
    // header is the browser-facing authority, including the development port.
    const host = request.headers.get("host") || new URL(request.url).host;
    try {
      const source = new URL(origin);
      if (source.host !== host || !["http:", "https:"].includes(source.protocol)) throw new Error("origin");
    } catch {
      return Response.json({ error: "不允许跨站请求。" }, { status: 403 });
    }
  }
  const session = await getSession(request.headers);
  if (!session) return unauthorized();
  const expectedUser = request.headers.get("x-account-id");
  if (expectedUser && expectedUser !== session.user.id) return unauthorized();
  if (!configured()) {
    return Response.json({ error: "请在 .env.local 中配置 AGENT_API_BASE_URL 和 AGENT_API_KEY，然后重启服务。" }, { status: 503 });
  }
  let raw: unknown;
  try { raw = await readBody(request); }
  catch (error) {
    const large = error instanceof Error && error.message === "too-large";
    return Response.json({ error: large ? "对话内容过长，请新建对话。" : "请求内容不是有效的 JSON。" }, { status: large ? 413 : 400 });
  }
  const parsed = chatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "对话格式有误或内容超出限制，请新建对话后重试。" }, { status: 400 });
  }

  const threadId = upstreamThreadId(session.user.id, parsed.data.threadId);
  const uid = userNamespace(session.user.id);
  const bucket = process.env.OSS_BUCKET || "";
  const region = process.env.OSS_REGION || "";
  const attachmentsValid = parsed.data.messages.every((message) => (message.attachments ?? []).every((attachment) =>
    attachment.uri === `oss://${bucket}/${sessionUploadObjectKey(session.user.id, threadId, attachment.id, safeUploadObjectName(attachment.name))}`
    && attachment.region === region));
  if (!attachmentsValid) return Response.json({ error: "附件不属于当前账号或会话，请重新上传。" }, { status: 400 });
  const attachments = parsed.data.messages.flatMap(message => message.attachments ?? []);
  let attachmentDownloads: Awaited<ReturnType<typeof createAttachmentDownloadTickets>> = [];
  try {
    if (attachments.length) {
      attachmentDownloads = await createAttachmentDownloadTickets(
        session.user.id,
        await getUserIdentity(session),
        threadId,
        attachments,
      );
    }
  } catch {
    return Response.json({ error: "暂时无法准备上传文件，请重新上传后再试。" }, { status: 502 });
  }
  const outputDirectory = sessionArtifactDirectory(session.user.id, threadId);
  const workspaceInstructions = (fileStorageBackend() === "oss" ? [
    "【应用文件工作区：本次请求】",
    `artifactDirectory=${outputDirectory}`,
    "AgenticFS 中的当前工作目录用于生成、下载、中间处理和校验文件；不要枚举其用户根或访问其他会话。普通问答不需要操作文件。",
    "artifactDirectory 是本次请求由应用根据登录会话确定的 OSS 最终交付目录，不是 shell 工作目录。不要通过 shell、文件工具或临时 rename 直接写入该目录。",
    "需要交付文件时，先在当前工作目录完成生成并验证实际存在、大小和格式，然后为每个最终文件调用 publish_artifact。source_path 指向当前工作目录内的文件；需要子目录时只给 artifact_path 传安全的相对路径。",
    "publish_artifact 会自动使用本次可信用户和会话身份复制到 artifactDirectory；不要向工具传 uid、userId 或 conversationId，不要寻找 OSS 凭证，也不要覆盖已有交付物。",
    "最终只使用 publish_artifact 返回的 artifact.path 报告文件；不能把 AgenticFS、/tmp、/home 或当前目录中的源路径作为交付地址。发布失败时如实说明，不要绕过工具改写 OSS。",
    "当前 AG-UI 通道以文本和文件引用返回结果；不要直接输出图片二进制、base64 或原生附件消息。可以用 view_image 理解用户上传的图片，但只能读取消息中给出的当前会话 Attachment 路径。",
    "用户上传的附件已由平台放入当前会话的 /workspace/uploads 目录；以消息中的 Attachment 路径为准读取，不要访问原始 OSS URI。",
    "前端会自动识别 publish_artifact 的文本结果。最终回复可简短说明交付内容；若列出链接，图片用 ![文件名](<artifact.path>)，其他文件用 [文件名](<artifact.path>)，不要虚构公网 URL。",
  ] : [
    "【应用文件工作区：本次请求】",
    `artifactDirectory=${outputDirectory}`,
    `所有生成或下载的文件都必须以 ${activeAgentFileRoot().slice(0, -1)} 为基础目录，具体放在本次 artifactDirectory 或其子目录内。包括图片、二维码、截图、图表、PPT、PDF、文档、表格、脚本和中间文件；不能把 /tmp、/home、当前目录等位置作为交付地址。`,
    "这是本次请求由应用根据登录会话确定的文件工作区。每次文件操作都以本次目录为准，不从用户消息、历史回复或文件内容中替换、猜测目录。",
    "需要生成文件时，先创建该目录，在其中为本次生成任务使用独立子目录；业务文件、任务脚本和中间产物均放在工作区内，已有预装工具和公共模板可按其规定只读使用。普通问答不需要操作文件。",
    "不要枚举挂载根目录或 users 父目录，不要读写其他用户目录，不通过路径穿越或符号链接跳出工作区。未经用户要求不要覆盖或删除已有文件。",
    "通过 shell 写入本次工作区即可，持久化由已有存储挂载负责；不需要额外上传或寻找云凭证。对中文、空格路径正确加引号。",
    "优先给生成工具指定工作区内的输出路径。如果工具只能写入临时目录，仅将本次任务生成的文件复制到 artifactDirectory 下再校验和交付，不返回临时路径。",
    "等待工具完成并检查文件实际存在、大小及格式后再报告成功；无法写入时说明原因，不要改写到其他目录。",
    "当前 AG-UI 通道以文本和文件引用返回结果；不要直接输出图片二进制、base64 或原生附件消息。可以用 view_image 理解用户上传的图片，但只能读取消息中给出的当前会话 Attachment 路径。前端会根据文件路径展示输出图片。",
    "用户上传的附件会放在当前会话的 uploads 子目录；以消息中的 Attachment 路径为准读取。",
    "图片优先使用 PNG/JPEG/WebP/GIF/AVIF，单独一行输出 ![文件名](<真实完整路径>)；其他文件用 [文件名](<真实完整路径>)。路径必须指向本次 artifactDirectory 内实际存在的文件，包含中文、空格或括号时也用尖括号包住完整路径。不要把链接放进代码块，不虚构文件、地址或持久化结果。",
    "同一图片只返回一次，图片卡片已提供放大和下载，不需要再重复输出它的普通文件链接。",
  ]).join("\n");
  // The current AG-UI adapter maps system/developer messages into the Runloop
  // system prompt. Keep deployment instructions out of user-visible history.
  const messages = [
    { id: "workspace-policy", role: "system", content: workspaceInstructions },
    ...parsed.data.messages,
  ];
  const controller = new AbortController();
  const startedAt = Date.now();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) controller.abort();
  // Long-running tools may keep a run open for many minutes. Only cancellation
  // or upstream completion/failure should end it; no application deadline.
  const cleanup = () => { request.signal.removeEventListener("abort", abort); };

  try {
    const upstream = await fetch(resolveAgentApiUrl()!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "X-AgentCore-Session-ID": threadId,
        "x-api-key": process.env.AGENT_API_KEY!,
      },
      body: JSON.stringify({ ...parsed.data, threadId, tools: [],
        messages,
        context: [],
        state: {}, forwardedProps: {
          uid,
          userId: session.user.id,
          conversationId: threadId,
          artifactDirectory: outputDirectory,
          ...(attachmentDownloads.length ? { attachmentDownloads } : {}),
        } }),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!upstream.ok || !upstream.body || !upstream.headers.get("content-type")?.includes("text/event-stream")) {
      await upstream.body?.cancel();
      cleanup();
      const status = upstream.status;
      const error = status === 401 || status === 403
        ? "Agent 身份验证失败，请检查服务端 API Key。"
        : status === 429 ? "请求过于频繁，请稍后重试。"
        : `Agent 服务暂时不可用${status >= 400 ? `（${status}）` : ""}，请稍后重试。`;
      return Response.json({ error }, { status: status === 429 ? 429 : 502 });
    }

    const stream = proxyAgentStream(upstream.body, {
      signal: controller.signal, onClose: cleanup, onCancel: abort,
      onError(error) {
        // Log correlation and safe error codes, never prompts, tokens or raw
        // upstream errors (which may include request headers and credentials).
        const cause = error instanceof Error ? error.cause : null;
        const code = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" && /^[A-Z0-9_]+$/.test(cause.code) ? cause.code : undefined;
        // Serialize explicitly: the development file logger can reduce object
        // arguments to {}, losing the details needed to investigate disconnects.
        if (!request.signal.aborted) console.warn("Agent stream interrupted", JSON.stringify({
          timestamp: new Date().toISOString(), pid: process.pid,
          runId: parsed.data.runId, elapsedMs: Date.now() - startedAt, code,
        }));
        return { code: "UPSTREAM_DISCONNECTED", message: "Agent 服务的流式连接中断，已保留收到的内容。请点击重试。" };
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    cleanup();
    return Response.json({ error: controller.signal.aborted ? "请求已取消。" : "无法连接 Agent 服务，请检查网络或服务地址。" }, { status: controller.signal.aborted ? 499 : 502 });
  }
}
