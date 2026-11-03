import assert from "node:assert/strict";
import { test } from "node:test";
import { readSSE } from "../src/lib/sse";
import { AgentRun, consumeAgentStream, restorePublishedArtifactLinks } from "../src/lib/agent-stream";
import { restoreStore } from "../src/lib/storage";

function stream(text: string, chunkSize = 1) {
  const bytes = new TextEncoder().encode(text);
  let position = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (position === bytes.length) return controller.close();
      controller.enqueue(bytes.slice(position, position + chunkSize));
      position = Math.min(bytes.length, position + chunkSize);
    },
  });
}
const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
const response = (text: string) => new Response(stream(text), { headers: { "Content-Type": "text/event-stream" } });

test("SSE keeps split UTF-8, CRLF boundaries, multiline data and a final unterminated frame", async () => {
  const input = "\uFEFF: heartbeat\r\nevent: message\r\ndata: 你好🙂\r\ndata: 第二行\r\n\r\ndata: {\"type\":\"RUN_FINISHED\"}";
  const received = [];
  for await (const event of readSSE(stream(input))) received.push(event);
  assert.deepEqual(received, ["你好🙂\n第二行", '{"type":"RUN_FINISHED"}']);
});

test("SSE supports bare CR and empty data fields", async () => {
  const received = [];
  for await (const event of readSSE(stream("data\r\r:ping\rdata: last\r\r"))) received.push(event);
  assert.deepEqual(received, ["", "last"]);
});

test("reader delivers content before the response stream closes", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const input = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const iterator = readSSE(input);
  controller.enqueue(new TextEncoder().encode("data: first\n\n"));
  assert.equal((await iterator.next()).value, "first");
  controller.enqueue(new TextEncoder().encode("data: second\n\n"));
  assert.equal((await iterator.next()).value, "second");
  controller.close();
  assert.equal((await iterator.next()).done, true);
});

test("AG-UI keeps separate assistant messages and does not render tool/user text as answers", () => {
  const run = new AgentRun();
  run.apply({ type: "TEXT_MESSAGE_START", messageId: "one", role: "assistant" });
  run.apply({ type: "TEXT_MESSAGE_CONTENT", messageId: "one", delta: "Hello" });
  run.apply({ type: "TEXT_MESSAGE_CHUNK", messageId: "two", delta: "世界" });
  run.apply({ type: "TEXT_MESSAGE_CHUNK", delta: "！" });
  run.apply({ type: "TEXT_MESSAGE_START", messageId: "tool", role: "tool" });
  run.apply({ type: "TEXT_MESSAGE_CONTENT", messageId: "tool", delta: "private tool payload" });
  run.apply({ type: "REASONING_MESSAGE_CONTENT", delta: "思考摘要" });
  run.apply({ type: "TOOL_CALL_START", toolCallId: "call-1", toolCallName: "search" });
  run.apply({ type: "TOOL_CALL_END", toolCallId: "call-1" });
  assert.equal(run.snapshot().tools?.[0].status, "running");
  run.apply({ type: "TOOL_CALL_RESULT", toolCallId: "call-1", content: "done" });
  assert.equal(run.snapshot().content, "Hello\n\n世界！");
  assert.equal(run.snapshot().reasoning, "思考摘要");
  assert.equal(run.snapshot().tools?.[0].status, "complete");
  assert.equal(run.snapshot().tools?.[0].result, "done");
});

test("interleaved tools keep streamed arguments and structured, empty or out-of-order results by ID", () => {
  const run = new AgentRun();
  run.apply({ type: "TOOL_CALL_START", toolCallId: "a", toolCallName: "calculate" });
  run.apply({ type: "TOOL_CALL_ARGS", toolCallId: "a", delta: '{"expression":' });
  run.apply({ type: "TOOL_CALL_CHUNK", toolCallId: "b", toolCallName: "search", delta: '{"query":"hello"}' });
  run.apply({ type: "TOOL_CALL_ARGS", toolCallId: "a", delta: '"7*8"}' });
  run.apply({ type: "TOOL_CALL_END", toolCallId: "a" });
  assert.equal(run.snapshot().tools?.[0].status, "running");
  run.apply({ type: "TOOL_CALL_RESULT", toolCallId: "b", content: { results: ["hello"] } });
  run.apply({ type: "TOOL_CALL_RESULT", toolCallId: "a", content: "56" });
  run.apply({ type: "TOOL_CALL_RESULT", toolCallId: "orphan", content: "" });
  const tools = run.snapshot().tools!;
  assert.equal(tools[0].arguments, '{"expression":"7*8"}');
  assert.equal(tools[0].result, "56");
  assert.deepEqual(JSON.parse(tools[1].result!), { results: ["hello"] });
  assert.equal(tools[2].result, "");
  assert.equal(tools[2].status, "complete");
  const restored = restoreStore(JSON.stringify({ activeId: "t", conversations: [{ id: "t", title: "tool results", createdAt: 1, updatedAt: 1, messages: [{ id: "a", role: "assistant", status: "complete", ...run.snapshot() }] }] }));
  assert.deepEqual(restored.conversations[0].messages[0].tools, tools);
  assert.deepEqual(restored.conversations[0].messages[0].runActivities, run.snapshot().runActivities);
});

test("reasoning and tools retain their protocol timeline order", () => {
  const run = new AgentRun();
  run.apply({ type: "REASONING_MESSAGE_START", messageId: "plan" });
  run.apply({ type: "REASONING_MESSAGE_CONTENT", messageId: "plan", delta: "先读取资料。" });
  run.apply({ type: "TOOL_CALL_START", toolCallId: "read", toolCallName: "read_builtin_skill" });
  run.apply({ type: "TOOL_CALL_RESULT", toolCallId: "read", content: "done" });
  run.apply({ type: "THINKING_TEXT_MESSAGE_START", messageId: "next" });
  run.apply({ type: "THINKING_TEXT_MESSAGE_CONTENT", messageId: "next", delta: "再整理答案。" });
  assert.deepEqual(run.snapshot().runActivities?.map((activity) => activity.type), ["reasoning", "tool", "reasoning"]);
  assert.equal(run.snapshot().reasoning, "先读取资料。\n\n再整理答案。");
});

test("runloop promotes the final thinking candidate without duplicating it in activity", () => {
  const run = new AgentRun();
  run.apply({ type: "THINKING_TEXT_MESSAGE_START", messageId: "progress" });
  run.apply({ type: "THINKING_TEXT_MESSAGE_CONTENT", messageId: "progress", delta: "我先检查工作区。" });
  run.apply({ type: "THINKING_TEXT_MESSAGE_END", messageId: "progress" });
  run.apply({ type: "TOOL_CALL_START", toolCallId: "inspect", toolCallName: "grep" });
  run.apply({ type: "TOOL_CALL_ARGS", toolCallId: "inspect", delta: "{}" });
  run.apply({ type: "TOOL_CALL_END", toolCallId: "inspect" });
  run.apply({ type: "TOOL_CALL_RESULT", toolCallId: "inspect", content: "ok" });
  run.apply({ type: "THINKING_TEXT_MESSAGE_START", messageId: "answer" });
  run.apply({ type: "THINKING_TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "检查完成。" });
  run.apply({ type: "THINKING_TEXT_MESSAGE_END", messageId: "answer" });
  run.apply({ type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" });
  run.apply({ type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "检查完成。" });
  run.apply({ type: "TEXT_MESSAGE_END", messageId: "answer" });
  run.apply({ type: "RUN_FINISHED", threadId: "thread", runId: "run" });

  const snapshot = run.snapshot();
  assert.equal(snapshot.content, "检查完成。");
  assert.equal(snapshot.reasoning, "我先检查工作区。");
  assert.deepEqual(snapshot.runActivities?.map((activity) => activity.type), ["reasoning", "tool"]);
});

test("runloop nested tool error envelopes remain explicit failures", () => {
  const run = new AgentRun();
  run.apply({ type: "TOOL_CALL_START", toolCallId: "read", toolCallName: "read_skill_file" });
  run.apply({
    type: "TOOL_CALL_RESULT",
    toolCallId: "read",
    content: JSON.stringify({ result: "permission denied", isError: true }),
  });
  assert.equal(run.snapshot().tools?.[0].isError, true);
});

test("publish_artifact tool results automatically add validated opaque and legacy artifact links", () => {
  const run = new AgentRun();
  run.apply({ type: "TOOL_CALL_START", toolCallId: "publish-1", toolCallName: "mcp__agentcore__publish_artifact" });
  run.apply({ type: "TOOL_CALL_RESULT", toolCallId: "publish-1", content: JSON.stringify({
    content: [{ type: "text", text: JSON.stringify({ artifact: { path: "/f/f_abcdefghijklmnopqrstuv", name: "报告.pdf" } }) }],
  }) });
  assert.equal(run.snapshot().content, "[报告.pdf](</f/f_abcdefghijklmnopqrstuv>)");

  run.apply({ type: "TEXT_MESSAGE_CONTENT", delta: "已交付：/f/f_abcdefghijklmnopqrstuv" });
  assert.equal(run.snapshot().content, "已交付：/f/f_abcdefghijklmnopqrstuv\n\n[报告.pdf](</f/f_abcdefghijklmnopqrstuv>)");

  run.apply({ type: "TOOL_CALL_START", toolCallId: "publish-2", toolCallName: "publish_artifact" });
  run.apply({ type: "TOOL_CALL_RESULT", toolCallId: "publish-2", content: { artifact: { path: "/mnt/oss/data/users/u1/c1/legacy.pdf", name: "旧文件.pdf" } } });
  assert.match(run.snapshot().content, /\[legacy\.pdf\]\(<\/mnt\/oss\/data\/users\/u1\/c1\/legacy\.pdf>\)/);

  run.apply({ type: "TOOL_CALL_START", toolCallId: "publish-3", toolCallName: "publish_artifact" });
  run.apply({ type: "TOOL_CALL_RESULT", toolCallId: "publish-3", content: { artifact: { path: "/tmp/escape.pdf", name: "escape.pdf" } } });
  assert.doesNotMatch(run.snapshot().content, /escape\.pdf/);
});

test("published SVG replaces model-authored relative or absolute image links with the verified artifact name", () => {
  for (const target of ["/f/f_abcdefghijklmnopqrstuv", "https://cdn.example.com/f/f_abcdefghijklmnopqrstuv"]) {
    const run = new AgentRun();
    run.apply({ type: "TOOL_CALL_START", toolCallId: "publish-svg", toolCallName: "publish_artifact" });
    run.apply({ type: "TOOL_CALL_RESULT", toolCallId: "publish-svg", content: {
      artifact: { path: "/f/f_abcdefghijklmnopqrstuv", name: "cat-on-tree.svg" },
    } });
    run.apply({ type: "TEXT_MESSAGE_CONTENT", delta: `文件已生成。\n\n![小猫上树](<${target}>)` });
    assert.equal(run.snapshot().content, "文件已生成。\n\n![cat-on-tree.svg](</f/f_abcdefghijklmnopqrstuv>)");
  }
});

test("saved conversations restore verified SVG links from persisted tool results", () => {
  const result = JSON.stringify({ artifact: { path: "/f/f_abcdefghijklmnopqrstuv", name: "cat-on-tree.svg" } });
  const content = restorePublishedArtifactLinks(
    "![小猫上树](<https://cdn.example.com/f/f_abcdefghijklmnopqrstuv>)",
    [{ id: "publish-svg", name: "publish_artifact", status: "complete", result }],
  );
  assert.equal(content, "![cat-on-tree.svg](</f/f_abcdefghijklmnopqrstuv>)");
});

test("a tools-only response with a real result is successful", async () => {
  await consumeAgentStream(response(frame({ type: "TOOL_CALL_RESULT", toolCallId: "one", content: "56" }) + frame({ type: "RUN_FINISHED" })), () => {});
});

test("stream applies content incrementally and exits on RUN_FINISHED even if upstream stays open", async () => {
  let canceled = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { canceled = true; } });
  controller.enqueue(new TextEncoder().encode(frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "one", delta: "Hello" }) + frame({ type: "RUN_FINISHED" })));
  const updates: string[] = [];
  await consumeAgentStream(new Response(body, { headers: { "Content-Type": "text/event-stream" } }), (value) => updates.push(value.content));
  assert.equal(updates[0], "Hello");
  assert.equal(canceled, true);
});

test("truncated streams fail while preserving received content", async () => {
  let content = "";
  await assert.rejects(consumeAgentStream(response(frame({ type: "TEXT_MESSAGE_CONTENT", delta: "部分内容" })), (value) => { content = value.content; }), /连接提前断开/);
  assert.equal(content, "部分内容");
});

test("protocol errors, invalid events and empty answers are actionable", async () => {
  await assert.rejects(consumeAgentStream(response(frame({ type: "RUN_ERROR", message: "Agent unavailable" })), () => {}), /Agent unavailable/);
  await assert.rejects(consumeAgentStream(response("data: broken-json\n\n"), () => {}), /无法解析/);
  await assert.rejects(consumeAgentStream(response(frame({ type: "RUN_FINISHED" })), () => {}), /未返回文本/);
  await assert.rejects(consumeAgentStream(new Response("{}"), () => {}), /未返回流式响应/);
  await assert.rejects(consumeAgentStream(Response.json({ error: "身份验证失败" }, { status: 502 }), () => {}), /身份验证失败/);
});

test("DONE terminator is supported", async () => {
  let content = "";
  await consumeAgentStream(response(frame({ type: "TEXT_MESSAGE_CHUNK", delta: "done" }) + "data: [DONE]\n\n"), (value) => { content = value.content; });
  assert.equal(content, "done");
});

test("unsupported binary outputs explain path-based delivery and preserve received text", async () => {
  let content = "";
  await assert.rejects(consumeAgentStream(response(
    frame({ type: "TEXT_MESSAGE_CONTENT", delta: "图片已生成。" }) +
    frame({ type: "RUN_ERROR", message: "AG-UI v1 does not support non-text Message or Tool Result output." }),
  ), (value) => { content = value.content; }), /当前通道只支持文本.*publish_artifact.*artifact\.path.*Markdown/);
  assert.equal(content, "图片已生成。");
});

test("restoring a closed tab marks interrupted responses as stopped", () => {
  const restored = restoreStore(JSON.stringify({ activeId: "thread", conversations: [{ id: "thread", title: "hello", createdAt: 1, updatedAt: 2, messages: [{ id: "msg", role: "assistant", content: "partial", status: "streaming" }] }] }));
  assert.equal(restored.conversations[0].messages[0].status, "stopped");
  assert.equal(restored.conversations[0].messages[0].content, "partial");
  assert.throws(() => restoreStore('{"conversations":"wrong"}'));
});

test("conversation organization survives browser storage restore", () => {
  const restored = restoreStore(JSON.stringify({
    activeId: "pinned",
    conversations: [
      { id: "pinned", title: "置顶会话", createdAt: 1, updatedAt: 3, pinned: true, messages: [] },
      { id: "project", title: "项目会话", createdAt: 1, updatedAt: 2, project: "发布准备", messages: [] },
      { id: "recent", title: "最近会话", createdAt: 1, updatedAt: 1, messages: [] },
    ],
  }));
  assert.equal(restored.conversations[0].pinned, true);
  assert.equal(restored.conversations[1].project, "发布准备");
  assert.equal(restored.conversations[2].project, undefined);
});
