import assert from "node:assert/strict";
import { after, before, afterEach, beforeEach, test, mock } from "node:test";
import { GET, POST } from "../src/app/api/chat/route";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAuth } from "../src/lib/auth.server";
import { artifactDirectory, sessionArtifactDirectory, upstreamThreadId, userNamespace } from "../src/lib/user-scope.server";
import { GET as fileGet } from "../src/app/api/files/route";
const directory = mkdtempSync(join(tmpdir(), "agentcore-auth-test-"));
let cookie = "";
let userId = "";
before(async () => {
  process.env.BETTER_AUTH_SECRET = "unit-test-only-secret-not-a-real-production-secret";
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.AUTH_DATABASE_PATH = join(directory, "auth.sqlite");
  const auth = await getAuth();
  const result = await auth.api.signUpEmail({ body: { name: "Test", email: "test@example.test", password: "safe-test-password" }, asResponse: true });
  assert.equal(result.status, 200);
  cookie = result.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
  userId = (await result.json()).user.id;
});
after(() => rmSync(directory, { recursive: true, force: true }));

const payload = { threadId: "thread-test", runId: "run-test", messages: [{ id: "message-test", role: "user", content: "Hello" }] };
const request = (body: unknown = payload, origin = "http://localhost:3000") => new Request("http://localhost:3000/api/chat", { method: "POST", headers: { "Content-Type": "application/json", origin, cookie }, body: JSON.stringify(body) });
let previousBaseUrl: string | undefined;
let previousPath: string | undefined;
let previousKey: string | undefined;
beforeEach(() => {
  previousBaseUrl = process.env.AGENT_API_BASE_URL;
  previousPath = process.env.AGENT_API_PATH; previousKey = process.env.AGENT_API_KEY;
  process.env.AGENT_API_BASE_URL = "https://agent.example.test";
  process.env.AGENT_API_PATH = "/ag-ui/agent";
  process.env.AGENT_API_KEY = "test-server-only-secret";
});
afterEach(() => {
  mock.restoreAll();
  if (previousBaseUrl === undefined) delete process.env.AGENT_API_BASE_URL; else process.env.AGENT_API_BASE_URL = previousBaseUrl;
  if (previousPath === undefined) delete process.env.AGENT_API_PATH; else process.env.AGENT_API_PATH = previousPath;
  if (previousKey === undefined) delete process.env.AGENT_API_KEY; else process.env.AGENT_API_KEY = previousKey;
});

test("proxy sets the API key and identical session/thread IDs exclusively on the upstream request", async () => {
  const messages = [{ id: "earlier-user", role: "user", content: "Earlier question" }, { id: "earlier-assistant", role: "assistant", content: "Earlier answer" }, ...payload.messages];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://agent.example.test/ag-ui/agent");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-api-key"), "test-server-only-secret");
    const upstream = JSON.parse(init.body as string);
    assert.equal(headers.get("X-AgentCore-Session-ID"), upstreamThreadId(userId, payload.threadId));
    assert.equal(upstream.threadId, upstreamThreadId(userId, payload.threadId));
    assert.equal(upstream.messages.length, messages.length + 1);
    assert.equal(upstream.messages[0].role, "system");
    assert.match(upstream.messages[0].content, /test-artifacts\//);
    assert.match(upstream.messages[0].content, /publish_artifact/);
    assert.match(upstream.messages[0].content, /OSS 最终交付目录/);
    assert.doesNotMatch(upstream.messages[0].content, /通过 shell 写入本次工作区即可/);
    assert.equal(upstream.messages.at(-1).role, "user");
    assert.equal(upstream.messages.at(-1).id, payload.messages.at(-1)!.id);
    assert.equal(upstream.messages.at(-1).content, payload.messages.at(-1)!.content);
    assert.deepEqual(upstream.messages.slice(1), messages);
    assert.deepEqual(upstream.context, []);
    assert.deepEqual(upstream.tools, []);
    assert.equal(upstream.forwardedProps.uid, userNamespace(userId));
    assert.equal(upstream.forwardedProps.userId, userId);
    assert.equal(upstream.forwardedProps.artifactDirectory, sessionArtifactDirectory(userId, upstream.threadId));
    return new Response('data: {"type":"RUN_FINISHED"}\n\n', { headers: { "Content-Type": "text/event-stream", "Set-Cookie": "upstream-private=true" } });
  });
  const response = await POST(request({ ...payload, messages, apiKey: "client-supplied", tools: ["untrusted"], context: [{ value: "/other-directory" }], forwardedProps: { userId: "another-user", artifactDirectory: "/other-directory" } }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type")!, /text\/event-stream/);
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal(response.headers.get("x-api-key"), null);
  assert.equal(await response.text(), 'data: {"type":"RUN_FINISHED"}\n\n');
});

test("adds a short-lived server-to-server read ticket for each confirmed attachment", async (t) => {
  const keys = ["AGENT_IDENTITY_AUTH_MODE", "AGENTCORE_ARTIFACT_ROOT", "FILE_STORAGE_BACKEND", "OSS_BUCKET", "OSS_REGION", "OSS_OBJECT_PREFIX", "STS_BROKER_URL", "STS_BROKER_KEY_ID", "STS_BROKER_SECRET", "OSS_ENDPOINT", "OSS_CNAME"];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } });
  Object.assign(process.env, {
    AGENT_IDENTITY_AUTH_MODE: "user_id", AGENTCORE_ARTIFACT_ROOT: "/mnt/oss/data/test-artifacts", FILE_STORAGE_BACKEND: "oss",
    OSS_BUCKET: "chat-bucket", OSS_REGION: "oss-cn-hangzhou",
    OSS_OBJECT_PREFIX: "agentcore/files", STS_BROKER_URL: "https://broker.example.test/v1/sts",
    STS_BROKER_KEY_ID: "test", STS_BROKER_SECRET: "ac".repeat(32),
  });
  delete process.env.OSS_ENDPOINT; delete process.env.OSS_CNAME;
  const threadId = upstreamThreadId(userId, payload.threadId);
  const uid = userNamespace(userId);
  const attachment = {
    id: "up_ticket", name: "photo.png", mimeType: "image/png", size: 3,
    uri: `oss://chat-bucket/agentcore/files/users/${uid}/${threadId}/uploads/up_ticket/file.png`,
    etag: '"etag-ticket"', region: "oss-cn-hangzhou",
  };
  let upstream: { forwardedProps?: { attachmentDownloads?: Array<{ uri: string; url: string }> }; messages?: unknown[] } | undefined;
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://broker.example.test/v1/sts") {
      return Response.json({ version: 1, credentials: {
        accessKeyId: "test-access-key", accessKeySecret: "test-secret-key", securityToken: "test-security-token",
        expiration: new Date(Date.now() + 30 * 60_000).toISOString(),
      } }, { headers: { "X-STS-Response-Signature": "0".repeat(64) } });
    }
    upstream = JSON.parse(String(init?.body));
    return new Response('data: {"type":"RUN_FINISHED"}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  });
  // Use gateway-only Broker auth in this test; HMAC response verification is covered separately.
  delete process.env.STS_BROKER_KEY_ID; delete process.env.STS_BROKER_SECRET;
  const response = await POST(request({ ...payload, messages: [{ ...payload.messages[0], attachments: [attachment] }] }));
  assert.equal(response.status, 200); await response.text();
  const tickets = upstream?.forwardedProps?.attachmentDownloads;
  assert.ok(tickets);
  assert.deepEqual(tickets.map(item => item.uri), [attachment.uri]);
  const signed = new URL(tickets[0]!.url);
  assert.equal(signed.protocol, "https:");
  assert.equal(signed.hostname, "chat-bucket.oss-cn-hangzhou.aliyuncs.com");
  assert.equal(decodeURIComponent(signed.pathname), `/agentcore/files/users/${uid}/${threadId}/uploads/up_ticket/file.png`);
  assert.ok(signed.searchParams.size > 0);
  assert.equal(JSON.stringify(upstream?.messages).includes(signed.href), false);
});

test("invalid input and cross-origin requests never reach the upstream", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  assert.equal((await POST(request({}, "http://untrusted.test"))).status, 403);
  assert.equal((await POST(request({ ...payload, threadId: "bad\r\nheader" }))).status, 400);
  assert.equal((await POST(request({ ...payload, messages: [] }))).status, 400);
  assert.equal((await POST(request({ ...payload, messages: [{ id: "x", role: "assistant", content: "x" }] }))).status, 400);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("upstream errors do not expose credentials or upstream bodies", async () => {
  mock.method(globalThis, "fetch", async () => new Response("internal credentials: test-server-only-secret", { status: 401 }));
  const response = await POST(request());
  const text = await response.text();
  assert.equal(response.status, 502);
  assert.match(text, /身份验证失败/);
  assert.doesNotMatch(text, /test-server-only-secret/);
  assert.deepEqual(await (await GET(new Request("http://localhost:3000/api/chat", { headers: { cookie } }))).json(), { configured: true });
});

test("client stream cancellation aborts the upstream fetch", async () => {
  let upstreamSignal: AbortSignal | undefined | null;
  let canceled = false;
  mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    upstreamSignal = init.signal;
    return new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "Content-Type": "text/event-stream" } });
  });
  const response = await POST(request());
  await response.body!.cancel();
  assert.equal(upstreamSignal?.aborted, true);
  assert.equal(canceled, true);
});

test("long-running chat streams survive beyond five minutes and still finish normally", async (t) => {
  // Advance the old deadline without spending five minutes or calling the real Agent.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let upstreamSignal: AbortSignal | undefined | null;
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let canceled = false;
  mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    upstreamSignal = init.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
      cancel() { canceled = true; },
    }), { headers: { "Content-Type": "text/event-stream" } });
  });
  const response = await POST(request());
  try {
    const result = response.text();
    source.enqueue(new TextEncoder().encode('data: {"type":"TEXT_MESSAGE_CONTENT","delta":"开始执行"}\n\n'));
    t.mock.timers.tick(10 * 60_000);
    assert.equal(upstreamSignal?.aborted, false);
    source.enqueue(new TextEncoder().encode('data: {"type":"TEXT_MESSAGE_CONTENT","delta":"长任务完成"}\n\ndata: {"type":"RUN_FINISHED"}\n\n'));
    const body = await result;
    assert.match(body, /开始执行/);
    assert.match(body, /长任务完成/);
    assert.match(body, /RUN_FINISHED/);
    assert.doesNotMatch(body, /RUN_ERROR/);
    assert.equal(canceled, true, "the completed run releases the upstream connection");
  } finally {
    if (!canceled) source.error(new Error("test cleanup"));
  }
});

test("an upstream socket failure preserves partial output and logs safe correlation details", async () => {
  const log = mock.method(console, "warn", () => {});
  let pulls = 0;
  mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
    pull(destination) {
      if (!pulls++) {
        destination.enqueue(new TextEncoder().encode('data: {"type":"TEXT_MESSAGE_CONTENT","delta":"已有回复"}\n\n'));
      } else {
        destination.error(new TypeError("private upstream request headers", {
          cause: Object.assign(new Error("test-server-only-secret"), { code: "UND_ERR_SOCKET" }),
        }));
      }
    },
  }), { headers: { "Content-Type": "text/event-stream" } }));

  const result = await POST(request());
  const body = await result.text();
  assert.match(body, /已有回复/);
  assert.match(body, /"type":"RUN_ERROR"/);
  assert.match(body, /"code":"UPSTREAM_DISCONNECTED"/);
  assert.doesNotMatch(body, /private upstream|test-server-only-secret/);

  assert.equal(log.mock.callCount(), 1);
  const args = log.mock.calls[0].arguments as unknown[];
  assert.equal(args[0], "Agent stream interrupted");
  assert.equal(typeof args[1], "string", "details must survive development file logging");
  const details = JSON.parse(args[1] as string);
  assert.equal(details.runId, payload.runId);
  assert.equal(details.pid, process.pid);
  assert.equal(details.code, "UND_ERR_SOCKET");
  assert.ok(details.elapsedMs >= 0);
  assert.ok(Number.isFinite(Date.parse(details.timestamp)));
  assert.doesNotMatch(args[1] as string, /private upstream|test-server-only-secret/);
  assert.equal((await GET(new Request("http://localhost:3000/api/chat", { headers: { cookie } }))).status, 200);
});

test("missing config is reported without calling the upstream", async () => {
  delete process.env.AGENT_API_KEY;
  assert.equal((await POST(request())).status, 503);
  assert.deepEqual(await (await GET(new Request("http://localhost:3000/api/chat", { headers: { cookie } }))).json(), { configured: false });
});

test("origin validation uses the browser-facing Host when Next.js rewrites the URL", async () => {
  mock.method(globalThis, "fetch", async () => new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } }));
  const incoming = new Request("http://localhost:3000/api/chat", { method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", cookie }, body: JSON.stringify(payload) });
  const result = await POST(incoming);
  assert.equal(result.status, 200);
  await result.text();
});


test("anonymous APIs and another user's files fail before any upstream access", async () => {
  const network = mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  assert.equal((await GET(new Request("http://localhost:3000/api/chat"))).status, 401);
  assert.equal((await POST(new Request("http://localhost:3000/api/chat", { method: "POST", body: JSON.stringify(payload) }))).status, 401);
  assert.equal((await fileGet(new Request("http://localhost:3000/api/files?path=/mnt/oss/data/test.pdf"))).status, 401);
  const wrong = new Request("http://localhost:3000/api/files?path=" + encodeURIComponent(artifactDirectory("another-user") + "/test.pdf"), { headers: { cookie } });
  assert.equal((await fileGet(wrong)).status, 403);
  const staleTab = request(); staleTab.headers.set("x-account-id", "another-user");
  assert.equal((await POST(staleTab)).status, 401);
  assert.equal(network.mock.callCount(), 0);
});

test("shared file reads authorize the app session and send a read-only user-aware grant", async (t) => {
  const keys = ["AGENT_IDENTITY_AUTH_MODE", "FILE_ACCESS_MODE", "OSS_BUCKET", "OSS_REGION", "OSS_OBJECT_PREFIX", "STS_BROKER_URL", "STS_BROKER_KEY_ID", "STS_BROKER_SECRET"];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } });
  Object.assign(process.env, { AGENT_IDENTITY_AUTH_MODE: "user_id", FILE_ACCESS_MODE: "shared", OSS_BUCKET: "test-bucket", OSS_REGION: "oss-cn-hangzhou", OSS_OBJECT_PREFIX: "agentcore/ppts", STS_BROKER_URL: "https://broker.example.test/v1/sts", STS_BROKER_KEY_ID: "test", STS_BROKER_SECRET: "ac".repeat(32) });
  let grant: { identity: { type: string; userId: string }; policy: string } | undefined;
  mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    grant = JSON.parse(String(init.body));
    return Response.json({}, { status: 503 });
  });
  // Real session from the test login; token data is never sent in this grant.
  const result = await fileGet(new Request("http://localhost:3000/api/files?path=" + encodeURIComponent("/mnt/oss/data/shared.pptx"), { headers: { cookie } }));
  assert.equal(result.status, 502); // simulated broker unavailable, not FILE_FORBIDDEN
  assert.deepEqual(grant?.identity, { type: "userId", userId: `app:${userId}` });
  assert.deepEqual(JSON.parse(grant!.policy).Statement[0].Action, ["oss:GetObject"]);
  assert.equal(JSON.parse(grant!.policy).Statement[0].Resource[0], "acs:oss:*:*:test-bucket/agentcore/ppts/*");
  assert.equal((await fileGet(new Request("http://localhost:3000/api/files?path=/mnt/oss/data/shared.pptx"))).status, 401);

  // Simulate a previously verified cloud account whose stored token has now
  // expired. The fixture is inserted directly, not accepted through OIDC login.
  const adapter = (await (await getAuth()).$context).internalAdapter;
  const expiredToken = [Buffer.from('{"alg":"RS256"}').toString("base64url"), Buffer.from('{"sub":"test-cloud-subject","exp":1}').toString("base64url"), "test-signature"].join(".");
  const account = await adapter.createAccount({ userId, providerId: "aliyun", accountId: "test-cloud-subject", idToken: expiredToken });
  t.after(() => adapter.deleteAccount(account.id));
  const sharedCloud = await fileGet(new Request("http://localhost:3000/api/files?path=/mnt/oss/data/shared.pptx", { headers: { cookie } }));
  assert.equal(sharedCloud.status, 502); // reaches the mocked broker in shared mode
  assert.deepEqual(grant?.identity, { type: "userId", userId: `app:${userId}` });
  process.env.FILE_ACCESS_MODE = "user";
  const privateRequest = () => new Request("http://localhost:3000/api/files?path=" + encodeURIComponent(artifactDirectory(userId) + "/test.pptx"), { headers: { cookie } });
  assert.equal((await fileGet(privateRequest())).status, 502); // still user_id, independent of file scope
  process.env.AGENT_IDENTITY_AUTH_MODE = "login_provider";
  const privateCloud = await fileGet(privateRequest());
  assert.equal(privateCloud.status, 401);
  assert.equal((await privateCloud.json()).code, "IDENTITY_REAUTH_REQUIRED");
});

test("NAS chat uses the shared workspace and file routes retain login/path checks", async (t) => {
  const values = { FILE_STORAGE_BACKEND: "nas", FILE_ACCESS_MODE: "shared", AGENT_IDENTITY_AUTH_MODE: "user_id", NAS_ACCOUNT_ID: "" };
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const fetchMock = mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const upstream = JSON.parse(init.body as string);
    assert.equal(upstream.forwardedProps.userId, userId);
    assert.equal(upstream.forwardedProps.uid, userNamespace(userId));
    assert.equal(upstream.forwardedProps.artifactDirectory, sessionArtifactDirectory(userId, upstream.threadId));
    assert.match(upstream.forwardedProps.artifactDirectory, /^\/mnt\/agenticfs\/shared\/[a-f0-9]{32}\/u_[a-f0-9]{32}_[a-f0-9]{40}$/);
    assert.match(upstream.messages[0].content, /\/mnt\/agenticfs\/shared\//);
    assert.doesNotMatch(upstream.messages[0].content, /\/mnt\/oss\/data|映射到 OSS/);
    assert.deepEqual(upstream.context, []);
    return new Response('data: {"type":"RUN_FINISHED"}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  });
  const chat = await POST(request());
  assert.equal(chat.status, 200); await chat.text();
  const path = encodeURIComponent("/mnt/agenticfs/shared/报告.pdf");
  assert.equal((await fileGet(new Request(`http://localhost:3000/api/files?path=${path}`))).status, 401);
  const file = await fileGet(new Request(`http://localhost:3000/api/files?path=${path}`, { headers: { cookie } }));
  assert.equal(file.status, 503);
  assert.ok(["NAS_REQUIRES_LINUX", "NAS_NOT_CONFIGURED"].includes((await file.json()).code));
  const old = await fileGet(new Request("http://localhost:3000/api/files?path=/mnt/oss/data/报告.pdf", { headers: { cookie } }));
  assert.equal(old.status, 409);
  assert.equal(fetchMock.mock.callCount(), 1);
});
