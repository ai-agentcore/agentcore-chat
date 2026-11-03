import assert from "node:assert/strict";
import { test } from "node:test";
import { proxyAgentStream } from "../src/lib/agent-proxy.server";
import { consumeAgentStream } from "../src/lib/agent-stream";
import { readSSE } from "../src/lib/sse";
import { chatErrorMessage } from "../src/lib/chat-errors";

const encoder = new TextEncoder();
const frame = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
const response = (body: ReadableStream<Uint8Array>) => new Response(body, { headers: { "content-type": "text/event-stream" } });

test("a broken upstream frame produces a clean error event and preserves prior output", async () => {
  let pulls = 0;
  let cleanups = 0;
  const source = new ReadableStream<Uint8Array>({ pull(destination) {
    if (!pulls++) destination.enqueue(encoder.encode(frame({ type: "TEXT_MESSAGE_CONTENT", delta: "已收到的内容" }) + 'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"unfinished'));
    else destination.error(new TypeError("private upstream request headers"));
  } });
  const result = proxyAgentStream(source, { signal: new AbortController().signal, onClose: () => { cleanups++; }, onCancel() {}, onError: () => ({ code: "UPSTREAM_DISCONNECTED", message: "Agent 服务的流式连接中断" }) });
  let content = "";
  await assert.rejects(consumeAgentStream(response(result), (snapshot) => { content = snapshot.content; }), /Agent 服务的流式连接中断/);
  assert.equal(content, "已收到的内容");
  assert.equal(cleanups, 1);
});

test("idle tools get comment heartbeats without corrupting the eventual event", async () => {
  let sourceController!: ReadableStreamDefaultController<Uint8Array>;
  let canceled = false;
  const source = new ReadableStream<Uint8Array>({ start(controller) { sourceController = controller; }, cancel() { canceled = true; } });
  const result = proxyAgentStream(source, { signal: new AbortController().signal, onClose() {}, onCancel() {}, onError: () => ({ code: "ERROR", message: "unexpected" }), heartbeatMs: 5 });
  const reader = result.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), ": heartbeat\n\n");
  sourceController.enqueue(encoder.encode(frame({ type: "RUN_FINISHED" })));
  const remaining: string[] = [];
  while (true) { const next = await reader.read(); if (next.done) break; remaining.push(new TextDecoder().decode(next.value)); }
  assert.ok(remaining.join("").includes('"RUN_FINISHED"'));
  reader.releaseLock();
  assert.equal(canceled, true, "terminal events close even if the upstream socket remains open");
});

test("abort wakes a pending read and releases the upstream stream", async () => {
  const controller = new AbortController();
  let canceled = false;
  const result = proxyAgentStream(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } }), { signal: controller.signal, onClose() {}, onCancel() {}, onError: () => ({ code: "CANCELED", message: "请求已取消" }) });
  const iterator = readSSE(result);
  const pending = iterator.next();
  controller.abort();
  assert.deepEqual(JSON.parse((await pending).value!), { type: "RUN_ERROR", code: "CANCELED", message: "请求已取消" });
  assert.equal((await iterator.next()).done, true);
  assert.equal(canceled, true);
});

test("browser network failures have actionable messages while service errors retain their reason", () => {
  assert.match(chatErrorMessage(new TypeError("Network error"), true), /已保留收到的内容/);
  assert.match(chatErrorMessage(new TypeError("Failed to fetch"), false), /无法连接对话服务/);
  assert.equal(chatErrorMessage(new Error("Agent 执行超过 5 分钟"), true), "Agent 执行超过 5 分钟");
});
