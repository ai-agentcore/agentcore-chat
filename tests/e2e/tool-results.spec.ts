import { test, expect } from "./fixtures";

const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;

test("tool results expand as JSON or Markdown and survive reload", async ({ page }) => {
  await page.route("**/api/chat", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { configured: true } })
    : route.fulfill({ contentType: "text/event-stream", body: [
      { type: "TOOL_CALL_START", toolCallId: "compute", toolCallName: "execute_shell_command" },
      { type: "TOOL_CALL_ARGS", toolCallId: "compute", delta: '{"command":"printf 56"}' },
      { type: "TOOL_CALL_END", toolCallId: "compute" },
      { type: "TOOL_CALL_RESULT", toolCallId: "compute", content: '{"stdout":"56","exitCode":0}' },
      { type: "TOOL_CALL_START", toolCallId: "report", toolCallName: "generate_report" },
      { type: "TOOL_CALL_RESULT", toolCallId: "report", content: "### 计算完成\n\n结果是 **56**。\n\n[查看报告](/mnt/oss/data/users/test/report.pdf)" },
      { type: "TEXT_MESSAGE_CONTENT", delta: "计算已经完成，可以展开查看工具结果。" },
      { type: "RUN_FINISHED" },
    ].map(frame).join("") }));
  await page.goto("/");
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("用工具计算 7×8");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.locator(".tool-activity-group > summary").click();
  const compute = page.locator('.tool-activity[data-tool-name="execute_shell_command"]');
  await expect(compute).toContainText("完成");
  await compute.locator("summary").click();
  await expect(compute.getByRole("region", { name: "调用参数" })).toContainText("printf 56");
  await expect(compute.getByRole("region", { name: "执行结果" })).toContainText('"stdout": "56"');
  const report = page.locator('.tool-activity[data-tool-name="generate_report"]');
  await report.locator("summary").click();
  await expect(report.getByRole("heading", { name: "计算完成" })).toBeVisible();
  await expect(report.locator(".file-card")).toBeVisible();
  await page.screenshot({ path: "artifacts/tool-results-desktop.png", fullPage: true });
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("agentcore-chat:v1:")).some(key => localStorage.getItem(key)?.includes('stdout')))).toBe(true);
  await page.reload();
  await page.locator(".tool-activity-group > summary").click();
  await compute.locator("summary").click();
  await expect(compute.getByRole("region", { name: "执行结果" })).toContainText('"stdout": "56"');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(compute).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/tool-results-mobile.png", fullPage: true });
});

test("network errors are explained and retry preserves the question", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/chat", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { configured: true } });
    calls++;
    if (calls === 1) return route.abort("failed");
    const partial = frame({ type: "TEXT_MESSAGE_CONTENT", delta: "已收到的部分内容" });
    return route.fulfill({ contentType: "text/event-stream", body: partial + frame({ type: "RUN_ERROR", code: "UPSTREAM_DISCONNECTED", message: "Agent 服务的流式连接中断，已保留收到的内容。请点击重试。" }) });
  });
  await page.goto("/");
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("测试连接故障");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.locator(".message-error")).toContainText("无法连接对话服务");
  await page.getByRole("button", { name: "重新生成", exact: true }).click();
  await expect(page.locator(".message-error")).toContainText("Agent 服务的流式连接中断");
  await expect(page.getByTestId("ai-content")).toContainText("已收到的部分内容");
  await expect(page.locator(".user-message")).toHaveCount(1);
});

test("real Agent tool result reaches the expandable renderer", async ({ page }) => {
  test.skip(process.env.LIVE_AGENT !== "1", "Set LIVE_AGENT=1 to call the configured Agent.");
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("请调用 execute_shell_command 工具执行 printf 56，只执行这一条简单命令，不读写文件，不访问网络，然后告诉我结果。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.locator(".tool-activity-group > summary").click();
  const tool = page.locator('.tool-activity[data-tool-name="execute_shell_command"]').first();
  await expect(tool).toContainText("完成", { timeout: 100_000 });
  await tool.locator("summary").click();
  await expect(tool.getByRole("region", { name: "执行结果" })).toContainText("56");
  await expect(page.getByRole("button", { name: "重新生成", exact: true })).toBeVisible({ timeout: 100_000 });
  await expect(page.locator(".message-error")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/tool-results-live.png", fullPage: true });
});
