import { expect, test, type Page } from "./fixtures";
import type { UploadedAttachment } from "../../src/lib/types";

type UploadRequest = { action: string; threadId: string; name: string; size: number; mimeType: string; uploadId?: string };
type ChatRequest = { threadId: string; messages: { content: string; attachments?: UploadedAttachment[] }[] };
const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;

async function mockUploads(page: Page, options: { pending?: Promise<void>; fail?: boolean } = {}) {
  const creates: UploadRequest[] = [];
  const uploads: Buffer[] = [];
  const chats: ChatRequest[] = [];
  await page.route("**/api/chat", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { configured: true } });
    chats.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "text/event-stream", body: frame({ type: "TEXT_MESSAGE_CONTENT", delta: "已收到图片附件。" }) + frame({ type: "RUN_FINISHED" }) });
  });
  await page.route("**/api/uploads", (route) => {
    const body: UploadRequest = route.request().postDataJSON();
    if (body.action === "create") {
      creates.push(body);
      return route.fulfill({ json: { uploadId: `up_${creates.length}`, objectName: "file.png", uploadUrl: `https://oss-upload.example.test/image-${creates.length}`, headers: { "Content-Type": body.mimeType } } });
    }
    return route.fulfill({ json: {
      id: body.uploadId, name: body.name, mimeType: body.mimeType, size: body.size,
      uri: `oss://chat-bucket/users/test/${body.threadId}/uploads/${body.uploadId}/file.png`, etag: '"image-etag"', region: "oss-cn-hangzhou",
    } });
  });
  await page.route("https://oss-upload.example.test/**", async (route) => {
    uploads.push(route.request().postDataBuffer()!);
    await options.pending;
    await route.fulfill({ status: options.fail ? 503 : 200 }).catch(() => {});
  });
  return { creates, uploads, chats };
}

// Dispatch native clipboard data without reading or replacing the user's system clipboard.
async function paste(page: Page, names: string[], text = "", oversized = false) {
  return page.getByRole("textbox", { name: "向 AgentCore 提问" }).evaluate(async (element, input) => {
    const canvas = document.createElement("canvas");
    canvas.width = 240; canvas.height = 160;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#deeee7"; context.fillRect(0, 0, 240, 160);
    context.fillStyle = "#38735c"; context.fillRect(24, 30, 80, 100);
    context.fillStyle = "#85b39e"; context.fillRect(120, 65, 96, 65);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
    const clipboardData = new DataTransfer();
    for (const name of input.names) clipboardData.items.add(new File([input.oversized ? new Uint8Array(33 * 1024 * 1024) : blob], name, { type: "image/png" }));
    if (input.text) clipboardData.setData("text/plain", input.text);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData });
    element.dispatchEvent(event);
    return { prevented: event.defaultPrevented, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
  }, { names, text, oversized });
}

test("pasted images preview before upload, then send as attachments without inline image bytes", async ({ page }) => {
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => { complete = resolve; });
  const state = await mockUploads(page, { pending });
  try {
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "向 AgentCore 提问" });
    await expect(input).toBeEnabled();
    const pasted = await paste(page, ["截图.png"]);
    expect(pasted.prevented).toBe(true);
    const thumbnail = page.getByRole("img", { name: "待发送图片：截图.png" });
    await expect(thumbnail).toBeVisible();
    await expect.poll(() => thumbnail.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(240);
    await expect(page.getByText("正在上传", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
    complete();
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
    expect(state.creates).toHaveLength(1); // items and files must not double-upload.
    expect(state.uploads[0]).toEqual(Buffer.from(pasted.bytes));
    await page.screenshot({ path: "artifacts/paste-image-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "artifacts/paste-image-mobile.png", fullPage: true });
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByTestId("ai-content")).toContainText("已收到图片附件");
    expect(state.chats[0].threadId).toBe(state.creates[0].threadId);
    expect(state.chats[0].messages.at(-1)?.content).toBe("");
    expect(state.chats[0].messages.at(-1)?.attachments?.[0]).toMatchObject({ name: "截图.png", mimeType: "image/png", etag: '"image-etag"' });
    expect(JSON.stringify(state.chats[0])).not.toMatch(/blob:|data:image|previewFile/);
    await expect(thumbnail).toHaveCount(0);
    await expect(page.locator(".user-message")).toContainText("截图.png");
    await expect.poll(() => page.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((key) => key.startsWith("agentcore-chat:v1:"))!) || "")).toContain("截图.png");
    await page.reload();
    await expect(page.locator(".user-message")).toContainText("截图.png");
  } finally { complete(); }
});

test("multiple pasted images can be removed and their preview URLs are released", async ({ page }) => {
  await page.addInitScript(() => {
    const original = URL.revokeObjectURL.bind(URL);
    const revoked: string[] = [];
    Object.assign(window, { revokedPreviewUrls: revoked });
    URL.revokeObjectURL = (url: string) => { revoked.push(url); original(url); };
  });
  const state = await mockUploads(page);
  await page.goto("/");
  await paste(page, ["第一张.png", "第二张.png"]);
  await expect(page.locator(".composer-attachments img")).toHaveCount(2);
  const firstUrl = await page.getByRole("img", { name: "待发送图片：第一张.png" }).getAttribute("src");
  await page.getByRole("button", { name: "移除附件：第一张.png" }).click();
  await expect(page.getByRole("img", { name: "待发送图片：第一张.png" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { revokedPreviewUrls: string[] }).revokedPreviewUrls)).toContain(firstUrl);
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("看看这张图片");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByTestId("ai-content")).toContainText("已收到图片附件");
  expect(state.chats[0].messages.at(-1)?.attachments?.map((item) => item.name)).toEqual(["第二张.png"]);
});

test("plain and mixed text paste keep native text behavior; image count and size limits apply", async ({ page }) => {
  const state = await mockUploads(page);
  await page.goto("/");
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("保留已有草稿");
  expect((await paste(page, [], "普通文本")).prevented).toBe(false);
  expect(state.creates).toHaveLength(0);
  expect((await paste(page, ["混合.png"], "附带文字")).prevented).toBe(false);
  await expect(page.getByRole("img", { name: "待发送图片：混合.png" })).toBeVisible();
  await page.getByRole("button", { name: "移除附件：混合.png" }).click();
  await paste(page, ["过大.png"], "", true);
  await expect(page.locator(".composer-attachments")).toContainText("32 MiB");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  expect(state.creates.every((item) => item.name !== "过大.png")).toBe(true);
  await page.getByRole("button", { name: "移除附件：过大.png" }).click();
  await paste(page, Array.from({ length: 11 }, (_, index) => `图片-${index + 1}.png`));
  await expect(page.locator(".composer-attachment")).toHaveCount(10);
  await expect(page.locator(".notice")).toContainText("最多添加 10 个文件");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  expect(state.creates).toHaveLength(11); // One earlier mixed paste plus ten accepted images.
  await page.getByRole("button", { name: /^新对话/ }).click();
  await expect(page.locator(".composer-attachment")).toHaveCount(0);
});

test("failed image uploads retain the draft and cannot be silently omitted on send", async ({ page }) => {
  const state = await mockUploads(page, { fail: true });
  await page.goto("/");
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("请解释截图");
  await paste(page, ["失败.png"]);
  await expect(page.locator(".composer-attachment")).toContainText("文件直传 OSS 失败");
  await expect(page.getByRole("img", { name: "待发送图片：失败.png" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "向 AgentCore 提问" })).toHaveValue("请解释截图");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  expect(state.chats).toHaveLength(0);
  await page.getByRole("button", { name: "移除附件：失败.png" }).click();
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
});
