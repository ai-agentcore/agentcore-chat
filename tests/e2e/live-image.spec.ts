import { artifactDirectory } from "../../src/lib/user-scope.server";
import { test, expect } from "./fixtures";

// Opt in: creates one small image in a disposable test user's mounted directory.
// No chat or file requests are mocked: Agent shell -> OSS mount -> file API -> UI.
test("live Agent delivers a PNG through the OSS mount and inline image renderer", async ({ page, testAccount }) => {
  test.skip(process.env.LIVE_AGENT_IMAGE !== "1", "Requires the live Agent, FC broker and OSS mount");
  test.setTimeout(300_000);
  const directory = artifactDirectory(testAccount.userId);
  const fileReads: { path: string; status: number }[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (["/api/files", "/api/files/content"].includes(url.pathname)) fileReads.push({ path: url.searchParams.get("path") || "", status: response.status() });
  });
  await page.goto("/");
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("请用 shell 和 Python 标准库或 Pillow 生成一张 480×300 的 PNG 测试图片，包含浅绿色背景和三个深绿色矩形即可，不需要调用图片生成服务。按应用文件工作区规则保存为 preview-check.png，校验实际文件尺寸后以 Markdown 图片返回。只生成这一张测试图片，不访问其他已有文件。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const image = page.locator(".image-artifact img").first();
  await expect(image).toBeVisible({ timeout: 260_000 });
  await expect(page.getByRole("button", { name: "停止生成", exact: true })).not.toBeVisible({ timeout: 35_000 });
  await expect(page.locator(".message-error")).toHaveCount(0);
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(480);
  expect(await image.evaluate((element) => (element as HTMLImageElement).naturalHeight)).toBe(300);
  expect(fileReads.length).toBeGreaterThanOrEqual(2);
  for (const read of fileReads) {
    expect(read.status).toBe(200);
    expect(read.path.startsWith(directory + "/")).toBe(true);
  }
  await page.screenshot({ path: "artifacts/inline-image-live.png", fullPage: true });
  console.log(JSON.stringify({ fileReads, width: 480, height: 300 }));
});
