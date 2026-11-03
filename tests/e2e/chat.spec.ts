import { expect, test, type Page } from "./fixtures";

const markdown = "当然可以。我们可以从一个小小的想法开始。\n\n## 让想法更进一步\n\n1. **描述目标**：告诉我你想解决什么问题。\n2. **一起探索**：我会帮你拆解思路。\n3. **动手实现**：把想法变成可以运行的代码。\n\n```typescript\nconst greeting = (name: string) => `你好，${name}！`;\nconsole.log(greeting('世界'));\n```\n\n| 能力 | 说明 |\n| --- | --- |\n| 写作 | 整理与表达想法 |\n| 编程 | 构建与调试代码 |\n\n你想先从哪一步开始？";
const frame = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
const answer = (content: string) => frame({ type: "RUN_STARTED" }) + frame({ type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" }) + frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: content }) + frame({ type: "TEXT_MESSAGE_END", messageId: "answer" }) + frame({ type: "RUN_FINISHED" });

async function mockAnswer(page: Page, content = markdown) {
  await page.route("**/api/chat", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { configured: true } })
    : route.fulfill({ contentType: "text/event-stream", body: answer(content) }));
}

test("welcome, renderer, multi-turn context, search, persistence, theme and export", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const payloads: { threadId: string; runId: string; messages: { role: string; content: string }[] }[] = [];
  await page.route("**/api/chat", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { configured: true } });
    payloads.push(route.request().postDataJSON());
    expect(route.request().headers()["x-api-key"]).toBeUndefined();
    return route.fulfill({ contentType: "text/event-stream", body: answer(markdown) });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "有什么我可以帮你的吗？" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "向 AgentCore 提问" })).toBeEnabled();
  await page.screenshot({ path: "artifacts/welcome-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "开发协作" }).click();
  await page.getByRole("button", { name: /实现一个功能/ }).click();
  await expect(page.getByRole("textbox", { name: "向 AgentCore 提问" })).toHaveValue(/实现一个功能/);
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("帮我把一个想法变成现实");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByTestId("ai-content").getByRole("heading", { name: "让想法更进一步" })).toBeVisible();
  await expect(page.getByTestId("ai-content").locator("pre")).toContainText("const greeting");
  await expect(page.getByTestId("ai-content").locator("table")).toBeVisible();
  await expect(page.getByRole("button", { name: "重新生成", exact: true })).toBeVisible();
  await page.screenshot({ path: "artifacts/conversation-desktop.png", fullPage: true });
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("继续");
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).press("Enter");
  await expect(page.getByTestId("ai-content")).toHaveCount(2);
  expect(payloads[1].threadId).toBe(payloads[0].threadId);
  expect(payloads[1].runId).not.toBe(payloads[0].runId);
  expect(payloads[1].messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.startsWith("agentcore-chat:v1:")) || "missing") || "{}").conversations?.[0]?.messages.length)).toBe(4);
  await page.reload();
  await expect(page.getByTestId("ai-content")).toHaveCount(2);
  await page.getByRole("button", { name: /^搜索对话/ }).click();
  await page.getByRole("textbox", { name: "搜索对话内容" }).fill("现实");
  await page.locator(".search-result").click();
  await expect(page.getByRole("dialog", { name: "搜索对话" })).not.toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出对话" }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/\.md$/);
  await page.getByRole("button", { name: "切换深色模式" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: "artifacts/conversation-dark.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("errors preserve partial output; retry reuses the question without duplicate history", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/chat", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { configured: true } });
    calls++;
    const input = route.request().postDataJSON();
    expect(input.messages).toHaveLength(1);
    return route.fulfill({ contentType: "text/event-stream", body: calls === 1
      ? frame({ type: "TEXT_MESSAGE_CONTENT", delta: "已收到的部分内容" }) + frame({ type: "RUN_ERROR", message: "测试错误，请重试" })
      : answer("重试成功") });
  });
  await page.goto("/");
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("测试错误恢复");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.locator(".message-error")).toContainText("测试错误");
  await expect(page.getByTestId("ai-content")).toContainText("部分内容");
  await page.getByRole("button", { name: "重新生成", exact: true }).click();
  await expect(page.getByTestId("ai-content")).toContainText("重试成功");
  await expect(page.locator(".user-message")).toHaveCount(1);
  await expect(page.locator(".message-error")).toHaveCount(0);
});

test("stop cancels an in-flight request and a new chat can send immediately", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { configured: true } });
    calls++;
    if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.fulfill({ contentType: "text/event-stream", body: answer("新的对话正常完成") }).catch(() => {});
  });
  await page.goto("/");
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("等一下");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
  await page.getByRole("button", { name: "停止生成" }).click();
  await expect(page.getByText("已停止生成", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^新对话/ }).click();
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("新问题");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByTestId("ai-content")).toContainText("新的对话正常完成");
  await expect(page.locator(".user-message")).toHaveCount(1);
});

test("a long-running request survives the former browser deadline and completes", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let requested = false;
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { configured: true } });
    requested = true;
    await pending;
    await route.fulfill({ contentType: "text/event-stream", body: answer("长任务正常完成") }).catch(() => {});
  });
  try {
    await page.goto("/");
    await page.clock.install();
    await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("执行一个长任务");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await page.clock.fastForward(10 * 60_000);
    await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
    await expect(page.locator(".message-error")).toHaveCount(0);
    release();
    await expect(page.getByTestId("ai-content")).toContainText("长任务正常完成");
    await expect(page.getByRole("button", { name: "停止生成" })).not.toBeVisible();
    await expect(page.locator(".message-error")).toHaveCount(0);
  } finally { release(); }
});

test("mobile layout, drawer, rename and delete", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAnswer(page, "你好！很高兴和你聊天。");
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "向 AgentCore 提问" })).toBeEnabled();
  await page.screenshot({ path: "artifacts/welcome-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "展开侧栏" }).click();
  await expect(page.getByRole("dialog", { name: "会话侧栏" })).toBeVisible();
  await page.getByRole("button", { name: /^新对话/ }).click();
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("你好");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByTestId("ai-content")).toContainText("很高兴");
  await page.getByLabel("当前对话选项").click();
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  await page.getByRole("textbox", { name: "对话名称" }).fill("我的第一段对话");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "展开侧栏" }).click();
  await expect(page.getByRole("button", { name: "我的第一段对话", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "收起侧栏" }).click();
  await page.getByLabel("当前对话选项").click();
  await page.getByRole("button", { name: "删除对话", exact: true }).click();
  await page.getByRole("dialog", { name: "删除这段对话？" }).getByRole("button", { name: "删除对话" }).click();
  await expect(page.getByRole("heading", { name: "有什么我可以帮你的吗？" })).toBeVisible();
});
