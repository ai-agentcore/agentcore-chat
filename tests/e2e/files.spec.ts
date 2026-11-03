import { artifactDirectory } from "../../src/lib/user-scope.server";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "./fixtures";
import { describeFile } from "../../src/lib/files";

const frame = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
async function assistant(page: Page, content: string) {
  await page.route("**/api/chat", (route) => route.request().method() === "GET" ? route.fulfill({ json: { configured: true } }) : route.fulfill({ contentType: "text/event-stream", body: frame({ type: "TEXT_MESSAGE_CONTENT", delta: content }) + frame({ type: "RUN_FINISHED" }) }));
  await page.goto("/");
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("请展示生成的文件");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
}

test("file cards defer OSS reads until click, render a real PPTX in isolation and navigate slides", async ({ page }) => {
  const file = await readFile("tests/fixtures/preview-demo.pptx");
  const path = "/mnt/oss/data/产品方案.pptx";
  let fileRequests = 0;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/files?**", (route) => {
    fileRequests++;
    expect(new URL(route.request().url()).searchParams.get("path")).toBe(path);
    return route.fulfill({ json: { path, ...describeFile(path), size: file.length, previewable: true } });
  });
  await page.route("**/api/files/content?**", (route) => {
    fileRequests++;
    const download = new URL(route.request().url()).searchParams.get("download") === "1";
    return route.fulfill({ contentType: describeFile(path).contentType, headers: download ? { "Content-Disposition": "attachment; filename=preview-demo.pptx" } : {}, body: file });
  });
  await assistant(page, '演示文稿已经生成，你可以直接打开预览。\n\n<FileCard path="/mnt/oss/data/产品方案.pptx" name="产品方案.pptx" />\n\n需要的话，我也可以继续帮你调整内容。');
  await expect(page.getByRole("button", { name: "预览文件：产品方案.pptx" })).toBeVisible();
  expect(fileRequests).toBe(0);
  await page.screenshot({ path: "artifacts/file-card.png", fullPage: true });
  await page.getByRole("button", { name: "预览文件：产品方案.pptx" }).click();
  await expect(page.getByText("1 / 2", { exact: true })).toBeVisible({ timeout: 35_000 });
  const viewer = page.frameLocator('iframe[title="PPTX 幻灯片预览"]');
  await expect(viewer.locator("#stage")).toContainText("从对话到文件");
  await page.screenshot({ path: "artifacts/file-preview-pptx.png", fullPage: true });
  await page.getByRole("button", { name: "下一页幻灯片" }).click();
  await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
  await expect(viewer.locator("#stage")).toContainText("文件交付流程");
  await expect(viewer.locator("[_echarts_instance_] svg")).toBeVisible();
  await expect(viewer.locator("#stage")).toContainText("完成度");
  await page.screenshot({ path: "artifacts/file-preview-chart.png", fullPage: true });
  const frameHandle = page.frames().find((item) => item.url().includes("/api/files/pptx-viewer"))!;
  expect(await frameHandle.evaluate(() => { try { void parent.document; return false; } catch { return true; } })).toBe(true);
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "下载原文件" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.pptx$/);
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await expect(page.getByRole("dialog", { name: "产品方案.pptx" })).not.toBeVisible();
  expect(errors).toEqual([]);
});

test("agent-produced PPTX with minimal theme and layout relationships remains previewable", async ({ page }) => {
  const file = await readFile("tests/fixtures/preview-agent-minimal.pptx");
  const path = "/mnt/oss/data/preview-agent-minimal.pptx";
  await page.route("**/api/files?**", (route) => route.fulfill({
    json: { path, ...describeFile(path), size: file.length, previewable: true },
  }));
  await page.route("**/api/files/content?**", (route) => route.fulfill({
    contentType: describeFile(path).contentType,
    body: file,
  }));

  await assistant(page, `[兼容性演示文稿](<${path}>)`);
  await page.getByRole("button", { name: "预览文件：兼容性演示文稿" }).click();

  await expect(page.getByText("1 / 5", { exact: true })).toBeVisible({ timeout: 35_000 });
  await expect(page.frameLocator('iframe[title="PPTX 幻灯片预览"]').locator("#stage")).toContainText("欢度国庆");
});

test("a path-only code block becomes a rich card and click requests the file preview service", async ({ page }) => {
  const path = "/mnt/oss/data/大语言模型LLM全景解读.pptx";
  const file = await readFile("tests/fixtures/preview-demo.pptx");
  let metadataRequests = 0;
  let contentRequests = 0;
  await page.route("**/api/files?**", (route) => {
    metadataRequests++;
    expect(new URL(route.request().url()).searchParams.get("path")).toBe(path);
    return route.fulfill({ json: { path, ...describeFile(path), size: file.length, previewable: true } });
  });
  await page.route("**/api/files/content?**", (route) => {
    contentRequests++;
    expect(new URL(route.request().url()).searchParams.get("path")).toBe(path);
    return route.fulfill({ contentType: describeFile(path).contentType, body: file });
  });
  await assistant(page, `✅ 已复制到指定目录，校验一致：\n\n\`\`\`\n${path}\n\`\`\`\n\n- 文件已生成，可以查看。`);
  const card = page.getByRole("button", { name: "预览文件：大语言模型LLM全景解读.pptx" });
  await expect(card).toBeVisible();
  await expect(page.locator(".code-block")).toHaveCount(0);
  expect(metadataRequests).toBe(0); expect(contentRequests).toBe(0);
  await page.screenshot({ path: "artifacts/fenced-file-card.png", fullPage: true });
  await card.click();
  await expect(page.getByText("1 / 2", { exact: true })).toBeVisible({ timeout: 35_000 });
  expect(metadataRequests).toBe(1); expect(contentRequests).toBe(1);
  await expect(page.frameLocator('iframe[title="PPTX 幻灯片预览"]').locator("#stage")).toContainText("从对话到文件");
  await page.screenshot({ path: "artifacts/fenced-file-preview.png", fullPage: true });
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await page.reload();
  await expect(card).toBeVisible();
  expect(metadataRequests).toBe(1); expect(contentRequests).toBe(1);
});

test("Markdown file links open text safely, recover from errors and survive reload", async ({ page }) => {
  const path = "/mnt/oss/data/report.html";
  let available = false;
  await page.route("**/api/files?**", (route) => !available ? route.fulfill({ status: 404, json: { error: "文件不存在，可能尚未生成完成。" } }) : route.fulfill({ json: { path, ...describeFile(path), size: 70, previewable: true } }));
  await page.route("**/api/files/content?**", (route) => route.fulfill({ contentType: "text/plain", body: '<script>window.__fileExecuted = true</script>\n预览只展示源代码。' }));
  await assistant(page, "文件已经保存。\n\n[查看报告](sandbox:/mnt/oss/data/report.html)");
  await page.getByRole("button", { name: "预览文件：查看报告" }).click();
  await expect(page.locator(".file-preview-dialog").getByRole("alert")).toContainText("文件不存在");
  available = true;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByLabel("文件内容")).toContainText("<script>");
  expect(await page.evaluate(() => "__fileExecuted" in window)).toBe(false);
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "预览文件：查看报告" })).toBeVisible();
});

test("oversized files offer download without fetching content for preview", async ({ page }) => {
  const path = "/mnt/oss/data/large.pptx";
  let contentRequests = 0;
  await page.route("**/api/files?**", (route) => route.fulfill({ json: { path, ...describeFile(path), size: 50 * 1024 * 1024, previewable: false } }));
  await page.route("**/api/files/content?**", (route) => { contentRequests++; return route.abort(); });
  await assistant(page, "[大文件](/mnt/oss/data/large.pptx)");
  await page.getByRole("button", { name: "预览文件：大文件" }).click();
  await expect(page.getByRole("heading", { name: "文件较大，请下载查看" })).toBeVisible();
  expect(contentRequests).toBe(0);
});

test("mobile image preview fits the viewport and closes with Escape", async ({ page }) => {
  const path = "/mnt/oss/data/image.png";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/files?**", (route) => route.fulfill({ json: { path, ...describeFile(path), size: 67, previewable: true } }));
  await page.route("**/api/files/content?**", (route) => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") }));
  await assistant(page, "`/mnt/oss/data/image.png`");
  await page.getByRole("button", { name: "预览文件：image.png" }).click();
  const enlargedImage = page.getByRole("dialog", { name: "image.png" }).getByRole("img", { name: "image.png" });
  await expect(enlargedImage).toBeVisible();
  expect(await enlargedImage.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/file-preview-mobile.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "image.png" })).not.toBeVisible();
});

test("PDF preview receives the original file through a local blob URL", async ({ page }) => {
  const path = "/mnt/oss/data/report.pdf";
  const file = await readFile("tests/fixtures/preview-demo.pdf");
  await page.route("**/api/files?**", (route) => route.fulfill({ json: { path, ...describeFile(path), size: file.length, previewable: true } }));
  await page.route("**/api/files/content?**", (route) => route.fulfill({ contentType: "application/pdf", body: file }));
  await assistant(page, "[预览 PDF](/mnt/oss/data/report.pdf)");
  await page.getByRole("button", { name: "预览文件：预览 PDF" }).click();
  const iframe = page.getByTitle("预览 PDF PDF 预览");
  await expect(iframe).toBeVisible();
  await expect(iframe).toHaveAttribute("src", /^blob:http:\/\/127\.0\.0\.1:3000\//);
  expect(await iframe.evaluate(async (element) => (await (await fetch((element as HTMLIFrameElement).src)).text()).startsWith("%PDF-"))).toBe(true);
  await page.screenshot({ path: "artifacts/file-preview-pdf.png", fullPage: true });
});

test("code examples remain code and file components reject executable attributes", async ({ page }) => {
  await assistant(page, '示例：\n\n```jsx\n<FileCard path="/mnt/oss/data/example.pptx" />\n```\n\n`<FileCard path="/mnt/oss/data/inline.pptx" />`\n\n<FileCard path="/mnt/oss/data/bad.pptx" onClick={() => alert(1)} />');
  await expect(page.getByRole("article", { name: "AgentCore 的回复" })).toContainText("[文件引用格式无效]");
  await expect(page.getByRole("button", { name: /^预览文件：/ })).toHaveCount(0);
  await expect(page.locator("pre")).toContainText('path="/mnt/oss/data/example.pptx"');
});

test("unconfigured OSS service returns an actionable message", async ({ page, testAccount }) => {
  const response = await page.request.get(`/api/files?path=${encodeURIComponent(artifactDirectory(testAccount.userId) + "/example.pptx")}`);
  // This deployment intentionally leaves OSS values empty until the user sets them.
  if (response.status() === 503) expect((await response.json()).code).toBe("OSS_NOT_CONFIGURED");
  else expect([200, 403, 404, 502]).toContain(response.status());
});
