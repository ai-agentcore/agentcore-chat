import { consumeAgentStream } from "../src/lib/agent-stream";

const baseUrl = process.env.E2E_BASE_URL || "http://127.0.0.1:3000";
// A disposable local account exercises the same login boundary as the browser.
const registration = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
  method: "POST", headers: { "Content-Type": "application/json", Origin: baseUrl },
  body: JSON.stringify({ name: "Agent smoke test", email: `smoke-${crypto.randomUUID()}@example.test`, password: crypto.randomUUID() + "-test" }),
});
if (!registration.ok) throw new Error(`Unable to create local smoke-test account (${registration.status})`);
const cookie = registration.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
const threadId = crypto.randomUUID();
const messages: { id: string; role: string; content: string }[] = [];

try {
  for (const prompt of ["请记住我的测试代号是青柠。只回复：记住了。", "我的测试代号是什么？只回复代号。"] ) {
    messages.push({ id: crypto.randomUUID(), role: "user", content: prompt });
    const started = Date.now();
    const response = await fetch(`${baseUrl}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: baseUrl }, body: JSON.stringify({ threadId, runId: crypto.randomUUID(), messages }), signal: AbortSignal.timeout(90_000) });
    let content = "";
    let firstChunk: number | undefined;
    let updates = 0;
    await consumeAgentStream(response, (snapshot) => {
      content = snapshot.content;
      if (content && firstChunk === undefined) firstChunk = Date.now() - started;
      updates++;
    });
    console.log(JSON.stringify({ turn: messages.filter((message) => message.role === "user").length, response: content, firstChunkMs: firstChunk, totalMs: Date.now() - started, updates }));
    messages.push({ id: crypto.randomUUID(), role: "assistant", content });
  }
  if (!messages.at(-1)?.content.includes("青柠")) throw new Error("Multi-turn memory verification failed");
  console.log("Live streaming and multi-turn context verified.");

} finally {
  await fetch(`${baseUrl}/api/auth/sign-out`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: baseUrl }, body: "{}" });
}
