import { expect, test, type Page } from "./fixtures";
import { describeFile } from "../../src/lib/files";
import { wordFixture } from "./word-fixture";

async function showFile(page: Page, path: string) {
  const frame = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
  await page.route("**/api/chat", route => route.request().method() === "GET"
    ? route.fulfill({ json: { configured: true } })
    : route.fulfill({ contentType: "text/event-stream", body: frame({ type: "TEXT_MESSAGE_CONTENT", delta: `[查看文件](<${path}>)` }) + frame({ type: "RUN_FINISHED" }) }));
  await page.goto("/");
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("展示文件");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.getByRole("button", { name: "预览文件：查看文件" }).click();
}

async function serveFile(page: Page, path: string, body: Buffer | string) {
  await page.route("**/api/files?**", route => route.fulfill({ json: { path, ...describeFile(path), size: Buffer.byteLength(body), previewable: true } }));
  await page.route("**/api/files/content?**", route => route.fulfill({
    contentType: describeFile(path).contentType,
    headers: new URL(route.request().url()).searchParams.has("download")
      ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(describeFile(path).name)}` } : {},
    body,
  }));
}

test("Markdown preview renders headings, tables, code and math with the chat renderer", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const content = '# 项目周报\n\n这是一份 **Markdown** 文档。\n\n## 本周进展\n\n- Markdown 预览\n- Word 预览\n\n| 项目 | 状态 |\n| --- | --- |\n| 文件预览 | 已完成 |\n\n```ts\nconst ready = true;\n```\n\n公式：$E = mc^2$\n\n<script>window.__markdownExecuted = true</script>';
  await serveFile(page, "/mnt/oss/data/周报.md", content);
  await showFile(page, "/mnt/oss/data/周报.md");
  const preview = page.getByRole("document", { name: "Markdown 文件内容" });
  await expect(preview.getByRole("heading", { name: "项目周报" })).toBeVisible();
  await expect(preview.getByRole("table")).toContainText("已完成");
  await expect(preview.locator("li")).toHaveCount(2);
  await expect(preview.locator(".code-block")).toContainText("const ready = true;");
  await expect(preview.getByRole("button", { name: "复制代码" })).toBeVisible();
  await expect(preview.locator(".katex")).toBeVisible();
  expect(await page.evaluate(() => "__markdownExecuted" in window)).toBe(false);
  const background = await preview.evaluate(element => getComputedStyle(element).backgroundColor);
  await page.screenshot({ path: "artifacts/markdown-preview-desktop.png", fullPage: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await expect.poll(() => preview.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(background);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(preview.getByRole("heading", { name: "项目周报" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/markdown-preview-mobile-dark.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("DOCX preview renders a real document, isolates its HTML and offers the original download", async ({ page }) => {
  const errors: string[] = [];
  const externalRequests: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://example.invalid/**", route => { externalRequests.push(route.request().url()); return route.abort(); });
  const file = await wordFixture();
  await serveFile(page, "/mnt/oss/data/交付报告.docx", file);
  await showFile(page, "/mnt/oss/data/交付报告.docx");
  await expect(page.getByText("共 2 页", { exact: true })).toBeVisible();
  const viewer = page.frameLocator('iframe[title="Word 文档预览"]');
  await expect(viewer.locator("section.docx")).toHaveCount(2);
  await expect(viewer.locator("#stage")).toContainText("项目交付报告");
  await expect(viewer.locator("#stage")).toContainText("下一步计划");
  await expect(viewer.locator("table")).toContainText("已完成");
  await expect(viewer.locator("img")).toBeVisible();
  expect(await viewer.locator("img").evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
  await expect(viewer.locator("#stage")).not.toContainText("UNSAFE_HTML_PART");
  const frame = page.frames().find(item => item.url().includes("/api/files/docx-viewer"))!;
  expect(await frame.evaluate(() => { try { void parent.document; return false; } catch { return true; } })).toBe(true);
  expect(await page.evaluate(() => "__wordExecuted" in window)).toBe(false);
  expect(externalRequests).toEqual([]);
  const downloadLink = page.getByRole("link", { name: "下载原文件" });
  // Chromium downloads can bypass page routing. Check the original-file link
  // here and validate the downloaded bytes in the file-service unit test,
  // keeping this browser test from making a real OSS request.
  const downloadUrl = new URL((await downloadLink.getAttribute("href"))!, page.url());
  expect(downloadUrl.searchParams.get("path")).toBe("/mnt/oss/data/交付报告.docx");
  expect(downloadUrl.searchParams.get("download")).toBe("1");
  await expect(downloadLink).toHaveAttribute("download", "交付报告.docx");
  await page.screenshot({ path: "artifacts/docx-preview-desktop.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("DOCX parse failures can be retried and mobile pages fit the viewport", async ({ page }) => {
  let valid = false;
  const file = await wordFixture();
  const path = "/mnt/oss/data/retry.docx";
  await page.route("**/api/files?**", route => route.fulfill({ json: { path, ...describeFile(path), size: file.length, previewable: true } }));
  await page.route("**/api/files/content?**", route => route.fulfill({ contentType: describeFile(path).contentType, body: valid ? file : "broken docx" }));
  await page.setViewportSize({ width: 390, height: 844 });
  await showFile(page, path);
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Word 文档解析失败");
  valid = true;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText("共 2 页", { exact: true })).toBeVisible();
  const frame = page.frames().find(item => item.url().includes("/api/files/docx-viewer"))!;
  expect(await frame.evaluate(() => {
    const page = document.querySelector("section.docx")!.getBoundingClientRect();
    return page.left >= 0 && page.right <= innerWidth + 1;
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/docx-preview-mobile.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("empty Markdown files show an empty state", async ({ page }) => {
  await serveFile(page, "/mnt/oss/data/empty.markdown", "");
  await showFile(page, "/mnt/oss/data/empty.markdown");
  await expect(page.getByRole("document", { name: "Markdown 文件内容" })).toContainText("（空文件）");
});
