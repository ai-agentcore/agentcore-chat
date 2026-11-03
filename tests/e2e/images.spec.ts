import { describeFile, fileApiUrl } from "../../src/lib/files";
import { expect, test, type Page } from "./fixtures";

const frame = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
async function assistant(page: Page, content: string) {
  await page.route("**/api/chat", (route) => route.request().method() === "GET" ? route.fulfill({ json: { configured: true } }) : route.fulfill({ contentType: "text/event-stream", body: frame({ type: "TEXT_MESSAGE_CONTENT", delta: content }) + frame({ type: "RUN_FINISHED" }) }));
  await page.goto("/");
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("展示生成的图片");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
}

// A visible raster fixture with a known aspect ratio, not a live login QR code.
async function fixtureImage(page: Page) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640; canvas.height = 400;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#f1f6f3"; ctx.fillRect(0, 0, 640, 400);
    ctx.fillStyle = "#254f40"; ctx.font = "500 30px sans-serif"; ctx.fillText("AgentCore · 图片预览", 44, 65);
    [75, 130, 105, 175, 210, 240].forEach((height, index) => {
      ctx.fillStyle = index === 5 ? "#254f40" : "#7aaa96";
      ctx.fillRect(48 + index * 92, 340 - height, 62, height);
    });
    ctx.fillStyle = "#53695f"; ctx.font = "14px sans-serif"; ctx.fillText("PREVIEW TEST  /  640 × 400", 44, 377);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  return Buffer.from(data, "base64");
}

test("image Markdown renders inline, enlarges without refetching, downloads and survives reload", async ({ page }) => {
  const path = "/mnt/oss/data/users/example/图表 (预览).png";
  const name = "图表 (预览).png";
  const bytes = await fixtureImage(page);
  let contentRequests = 0;
  await page.route("**/api/files?**", (route) => {
    expect(new URL(route.request().url()).searchParams.get("path")).toBe(path);
    return route.fulfill({ json: { path, ...describeFile(path), size: bytes.length, previewable: true } });
  });
  await page.route("**/api/files/content?**", (route) => {
    contentRequests++;
    expect(new URL(route.request().url()).searchParams.get("path")).toBe(path);
    return route.fulfill({ contentType: "image/png", body: bytes });
  });
  await assistant(page, `图片已生成，点击可以放大查看。\n\n![${name}](<${path}>)`);
  const inline = page.locator(".image-artifact").getByRole("img", { name });
  await expect(inline).toBeVisible();
  await expect(inline).toHaveAttribute("src", /^blob:/);
  expect(await inline.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(640);
  const initialRequests = contentRequests;
  expect(initialRequests).toBeGreaterThan(0);
  await expect(page.getByRole("link", { name: `下载图片：${name}` })).toHaveAttribute("href", fileApiUrl(path, "download"));
  await page.screenshot({ path: "artifacts/inline-image-desktop.png", fullPage: true });
  const button = page.getByRole("button", { name: `预览文件：${name}` });
  await button.focus(); await page.keyboard.press("Enter");
  const modal = page.getByRole("dialog", { name });
  await expect(modal.getByRole("img", { name })).toBeVisible();
  expect(contentRequests).toBe(initialRequests);
  await expect(modal.getByRole("link", { name: "下载原文件" })).toHaveAttribute("href", fileApiUrl(path, "download"));
  await page.screenshot({ path: "artifacts/inline-image-enlarged.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
  await expect(button).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(inline).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/inline-image-mobile.png", fullPage: true });
});

test("image loading failures can retry without regenerating and oversized images do not fetch bytes", async ({ page }) => {
  const path = "/mnt/oss/data/image.png";
  const bytes = await fixtureImage(page);
  let available = false;
  let size = bytes.length;
  let contentRequests = 0;
  await page.route("**/api/files?**", (route) => !available ? route.fulfill({ status: 404, json: { error: "文件不存在，可能尚未生成完成。" } }) : route.fulfill({ json: { path, ...describeFile(path), size, previewable: size < 30 * 1024 * 1024 } }));
  await page.route("**/api/files/content?**", (route) => { contentRequests++; return route.fulfill({ contentType: "image/png", body: bytes }); });
  await assistant(page, `\`\`\`\n${path}\n\`\`\``);
  const card = page.locator(".image-artifact");
  await expect(card.getByRole("alert")).toContainText("文件不存在");
  expect(contentRequests).toBe(0);
  available = true;
  await card.getByRole("button", { name: "重试", exact: true }).click();
  await expect(card.getByRole("img")).toBeVisible();
  expect(contentRequests).toBe(1);
  size = 31 * 1024 * 1024;
  await page.reload();
  await expect(card).toContainText("图片较大，请下载原文件查看");
  await expect(card.getByRole("link", { name: "下载图片：image.png" })).toBeVisible();
  expect(contentRequests).toBe(1);
});

test("a corrupt image shows a recoverable decode error", async ({ page }) => {
  const path = "/mnt/oss/data/broken.png";
  await page.route("**/api/files?**", (route) => route.fulfill({ json: { path, ...describeFile(path), size: 8, previewable: true } }));
  await page.route("**/api/files/content?**", (route) => route.fulfill({ contentType: "image/png", body: "not-a-png" }));
  await assistant(page, `![图片](${path})`);
  await expect(page.locator(".image-artifact").getByRole("alert")).toContainText("图片格式无法识别");
  await expect(page.locator(".image-artifact").getByRole("button", { name: "重试" })).toBeVisible();
});
