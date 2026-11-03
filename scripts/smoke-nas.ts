// Opt-in live check: asks the configured Agent to write one uniquely named TXT.
// Uses the real chat/file handlers and an isolated local login database.
import nextEnv from "@next/env";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAuth } from "../src/lib/auth.server";
import { POST as chat } from "../src/app/api/chat/route";
import { userFileRequest } from "../src/lib/user-files.server";
import { consumeAgentStream } from "../src/lib/agent-stream";
import { prepareArtifactContent } from "../src/lib/artifact-content";

nextEnv.loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
if (process.env.FILE_STORAGE_BACKEND !== "nas" || process.env.FILE_ACCESS_MODE !== "shared") throw new Error("Configure NAS shared mode before running this check.");
const directory = await mkdtemp(join(tmpdir(), "agentcore-nas-live-"));
process.env.AUTH_DATABASE_PATH = join(directory, "auth.sqlite");
process.env.ALIYUN_OAUTH_CLIENT_ID = "";
const origin = process.env.BETTER_AUTH_URL || "http://127.0.0.1:3000";
const id = randomUUID();
const path = `/mnt/agenticfs/shared/chat-read-check-${id}.txt`;
const expected = `AgentCore NAS read check ${id}\n`;
const report: Record<string, unknown> = { timestamp: new Date().toISOString(), path,
  expectedBytes: Buffer.byteLength(expected), expectedSha256: createHash("sha256").update(expected).digest("hex"), platform: process.platform };
let cookie = "";
try {
  const auth = await getAuth();
  const signup = await auth.api.signUpEmail({ body: { name: "NAS read check", email: `nas-${id}@example.test`, password: randomUUID() }, asResponse: true });
  if (!signup.ok) throw new Error(`Test login failed (${signup.status})`);
  cookie = signup.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  const prompt = `请使用 shell/Python 生成一个小文本测试文件。只创建 ${path}，不得覆盖已有文件，用独占创建模式。文件 UTF-8 内容必须精确为 ${JSON.stringify(expected)}（最后有一个换行）。写完后读取这个文件，核对字节数和 SHA256。只检查这个文件，不读取其他已有文件。若有 findmnt，可用 findmnt -T 此文件 -n -o TARGET,SOURCE,FSTYPE 查看此文件对应的挂载位置；不输出挂载选项、环境变量或凭证。最终返回文件的 Markdown 下载链接，以及实际字节数、SHA256、挂载目标与来源。工具结果只用文本。`;
  const response = await chat(new Request(`${origin}/api/chat`, { method: "POST",
    headers: { "Content-Type": "application/json", origin, cookie }, signal: AbortSignal.timeout(240_000),
    body: JSON.stringify({ threadId: `nas-check-${id}`, runId: randomUUID(), messages: [{ id: randomUUID(), role: "user", content: prompt }] }) }));
  report.chatStatus = response.status;
  if (!response.ok) { report.chatError = await response.json(); throw new Error(`Chat failed (${response.status})`); }
  let content = "";
  await consumeAgentStream(response, (snapshot) => { content = snapshot.content; });
  report.agentReply = content;
  report.artifactRecognized = prepareArtifactContent(content).includes(`filePath="${encodeURIComponent(path)}"`);
  const request = new Request(`${origin}/api/files?${new URLSearchParams({ path })}`, { headers: { cookie } });
  const metadata = await userFileRequest(request);
  report.metadataStatus = metadata.status;
  report.metadata = await metadata.json();
  if (metadata.ok) {
    const response = await userFileRequest(request, true);
    report.contentStatus = response.status;
    if (response.ok) {
      const body = await response.text();
      report.contentMatches = body === expected;
      report.actualSha256 = createHash("sha256").update(body).digest("hex");
    } else report.contentError = await response.json();
  }
  report.passed = report.artifactRecognized === true && report.contentMatches === true;
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : "Live check failed";
  process.exitCode = 1;
} finally {
  if (cookie) await (await getAuth()).api.signOut({ headers: new Headers({ cookie }) }).catch(() => {});
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/nas-live-read.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  await rm(directory, { recursive: true, force: true });
}
