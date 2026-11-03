import { test, expect, type Page } from "./fixtures";

declare global {
  interface Window { executionTestStream?: ReadableStreamDefaultController<Uint8Array> }
}

// Hold a real browser ReadableStream open so the UI sees separate live events.
async function startRun(page: Page) {
  await page.route("**/api/chat", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { configured: true } }) : route.abort());
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "向 AgentCore 提问" })).toBeEnabled();
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (input !== "/api/chat" || init?.method !== "POST") return originalFetch(input, init);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          window.executionTestStream = controller;
          init.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    };
  });
  const start = Date.now();
  await page.clock.setFixedTime(start);
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("整理这份报告，生成一份演示文稿");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await emit(page, [
    { type: "REASONING_MESSAGE_CONTENT", delta: "先整理报告要点，再生成演示文稿并检查输出文件。" },
    { type: "TOOL_CALL_START", toolCallId: "shell", toolCallName: "bash" },
    { type: "TOOL_CALL_ARGS", toolCallId: "shell", delta: '{"command":"generate_slides"}' },
    { type: "TOOL_CALL_RESULT", toolCallId: "shell", content: "已生成 8 页演示文稿。" },
    { type: "TOOL_CALL_START", toolCallId: "publish", toolCallName: "mcp__agentcore__publish_artifact" },
  ]);
  return start;
}

async function emit(page: Page, events: object[], close = false) {
  await page.evaluate(({ events, close }) => {
    const stream = window.executionTestStream;
    if (!stream) throw new Error("The test stream has not started");
    stream.enqueue(new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
    if (close) stream.close();
  }, { events, close });
}

test("compact process expands with keyboard, times the run and preserves its duration after reload", async ({ page }) => {
  const start = await startRun(page);
  const group = page.locator(".tool-activity-group");
  const summary = group.locator(":scope > summary");
  await expect(summary).toContainText("已处理 0 秒");
  await expect(group).toHaveAttribute("open", "");
  await expect(page.locator(".agent-selector, .model-chip, .header-subtitle")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "添加文件", exact: true })).toBeVisible();

  await page.clock.setFixedTime(start + 65_000);
  await expect(summary).toContainText("已处理 1 分 5 秒");
  await expect(group.getByRole("list", { name: "执行活动时间线", exact: true })).toContainText("整理报告要点");
  const shell = group.locator('[data-tool-name="bash"]');
  await shell.locator("summary").click();
  await expect(shell.getByRole("region", { name: "调用参数" })).toContainText("generate_slides");
  await expect(shell.getByRole("region", { name: "执行结果" })).toContainText("8 页");

  await emit(page, [
    { type: "TOOL_CALL_RESULT", toolCallId: "publish", content: "发布完成。" },
    { type: "TEXT_MESSAGE_CONTENT", delta: "演示文稿已生成，共 **8 页**。\n\n内容包含报告要点、关键数据和下一步计划，可以继续调整配色或补充细节。" },
    { type: "RUN_FINISHED" },
  ], true);
  await expect(summary).toContainText("用时 1 分 5 秒");
  await expect(group).not.toHaveAttribute("open");
  await expect(page.getByTestId("ai-content")).toContainText("8 页");
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("agentcore-chat:v1:") && localStorage.getItem(key)?.includes('"completedAt"')))).toBe(true);
  await page.clock.setFixedTime(start + 300_000);
  await page.reload();
  await expect(summary).toContainText("用时 1 分 5 秒");
  await expect(group).not.toHaveAttribute("open");
  await page.screenshot({ path: "artifacts/execution-process-light.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "切换深色模式" }).click();
  await page.screenshot({ path: "artifacts/execution-process-dark.png", fullPage: true, animations: "disabled" });
  await summary.click();
  await page.screenshot({ path: "artifacts/execution-process-expanded.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(group).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/execution-process-mobile.png", fullPage: true, animations: "disabled" });
});

for (const outcome of ["error", "stop"] as const) {
  test(`${outcome} freezes the timer and shows unfinished steps without claiming success`, async ({ page }) => {
    const start = await startRun(page);
    await page.clock.setFixedTime(start + 12_000);
    const summary = page.locator(".tool-activity-group > summary");
    await expect(summary).toContainText("已处理 12 秒");
    if (outcome === "error") {
      await emit(page, [{ type: "RUN_ERROR", message: "连接已中断，请重试。" }], true);
      await expect(page.getByRole("article", { name: "AgentCore 的回复" }).getByRole("alert")).toContainText("连接已中断");
    } else await page.getByRole("button", { name: "停止生成", exact: true }).click();
    await expect(summary).toContainText("用时 12 秒");
    await page.clock.setFixedTime(start + 120_000);
    await summary.click();
    const pending = page.locator('[data-tool-name="mcp__agentcore__publish_artifact"]');
    await expect(pending).toContainText("未完成");
    await expect(summary.locator(".spin")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("agentcore-chat:v1:") && localStorage.getItem(key)?.includes('"completedAt"')))).toBe(true);
    await page.reload();
    await expect(summary).toContainText("用时 12 秒");
  });
}

test("older history and an interrupted tab do not invent elapsed times", async ({ page, testAccount }) => {
  await page.addInitScript(({ userId }) => {
    localStorage.setItem(`agentcore-chat:v1:${userId}`, JSON.stringify({ activeId: "old", conversations: [{
      id: "old", title: "历史对话", createdAt: 1, updatedAt: 2, messages: [
        { id: "old-a", role: "assistant", status: "complete", content: "旧版回复。", reasoning: "分析记录" },
        { id: "interrupted", role: "assistant", status: "streaming", startedAt: 1000, content: "关闭前收到的内容。", tools: [{ id: "tool", name: "bash", status: "running" }] },
        { id: "elapsed-only", role: "assistant", status: "complete", startedAt: 1000, completedAt: 8000, content: "只有耗时记录的回复。" },
      ],
    }] }));
  }, { userId: testAccount.userId });
  await page.goto("/");
  await expect(page.locator(".tool-activity-group")).toHaveCount(3);
  await expect(page.locator(".tool-activity-group > summary")).toHaveCount(2);
  await expect(page.locator(".tool-activity-duration")).toHaveText("用时 7 秒");
  await expect(page.locator(".tool-activity-duration .tool-chevron")).toHaveCount(0);
  const disclosureTitles = page.locator(".tool-activity-group > summary .tool-group-title");
  await expect(disclosureTitles.first()).toHaveText("用时");
  await expect(disclosureTitles.last()).toHaveText("用时");
});
