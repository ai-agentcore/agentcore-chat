import { describeFile, fileApiUrl } from "../../src/lib/files";
import { test, expect } from "./fixtures";

test("NAS shared image paths preview, download and restore from history", async ({ page }) => {
  const path = "/mnt/agenticfs/shared/共享图表 (新版).png";
  const name = "共享图表 (新版).png";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7i0AAAAASUVORK5CYII=", "base64");
  let contents = 0;
  await page.route("**/api/files?**", (route) => {
    expect(new URL(route.request().url()).searchParams.get("path")).toBe(path);
    return route.fulfill({ json: { path, ...describeFile(path), size: png.length, previewable: true } });
  });
  await page.route("**/api/files/content?**", (route) => {
    expect(new URL(route.request().url()).searchParams.get("path")).toBe(path);
    contents++;
    return route.fulfill({ contentType: "image/png", body: png });
  });
  await page.route("**/api/chat", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { configured: true } })
    : route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: `![${name}](<${path}>)` })}\n\ndata: {"type":"RUN_FINISHED"}\n\n` }));
  await page.goto("/");
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("查看 NAS 共享图片");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const inline = page.locator(".image-artifact").getByRole("img", { name });
  await expect(inline).toBeVisible();
  expect(await inline.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1);
  await expect(page.getByRole("link", { name: `下载图片：${name}` })).toHaveAttribute("href", fileApiUrl(path, "download"));
  await page.getByRole("button", { name: `预览文件：${name}` }).click();
  await expect(page.getByRole("dialog", { name }).getByRole("img", { name })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(inline).toBeVisible();
  expect(contents).toBeGreaterThanOrEqual(2);
});
