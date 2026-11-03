import { test, expect } from "./fixtures";

// Opt in: only the assistant text is simulated. Login, STS, OSS metadata and
// bytes, and PPTX parsing all use the configured running application.
test("shared OSS PPTX opens from a path card with real credentials and file bytes", async ({ page }) => {
  test.skip(process.env.LIVE_OSS !== "1", "Requires configured shared OSS access and live cloud requests");
  test.setTimeout(120_000);
  const path = "/mnt/oss/data/大语言模型LLM全景解读.pptx";
  const frame = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
  let reads = 0;
  page.on("request", request => {
    if (["/api/files", "/api/files/content"].includes(new URL(request.url()).pathname)) reads++;
  });
  await page.route("**/api/chat", route => route.request().method() === "GET"
    ? route.fulfill({ json: { configured: true } })
    : route.fulfill({ contentType: "text/event-stream", body:
      frame({ type: "TEXT_MESSAGE_CONTENT", delta: `文件已保存，可以点击卡片查看。\n\n\`\`\`\n${path}\n\`\`\`` }) + frame({ type: "RUN_FINISHED" }) }));
  await page.goto("/");
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("查看已生成的演示文稿");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const card = page.getByRole("button", { name: "预览文件：大语言模型LLM全景解读.pptx" });
  await expect(card).toBeVisible();
  expect(reads).toBe(0);
  await page.screenshot({ path: "artifacts/shared-file-card-live.png", fullPage: true });
  const metadataResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/files");
  const contentResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/files/content");
  await card.click();
  const metadata = await metadataResponse;
  expect(metadata.status(), await metadata.text()).toBe(200);
  const info = await metadata.json();
  expect(info.size).toBe(1_119_834);
  const content = await contentResponse;
  expect(content.status()).toBe(200);
  expect((await content.body()).length).toBe(info.size);
  const pagination = page.locator('.pptx-pagination [aria-live="polite"]');
  await expect(pagination).toHaveText(/^1 \/ \d+$/, { timeout: 40_000 });
  const count = Number((await pagination.innerText()).split("/")[1]);
  expect(count).toBe(20);
  const stage = page.frameLocator('iframe[title="PPTX 幻灯片预览"]').locator("#stage");
  await expect(stage).toContainText("大语言模型");
  await page.screenshot({ path: "artifacts/shared-pptx-preview-live.png", fullPage: true });
  // React development Strict Mode may start and abort an initial metadata
  // request. Navigating loaded slides must not read the file again.
  const readsAfterLoad = reads;
  await page.getByRole("button", { name: "下一页幻灯片" }).click();
  await expect(pagination).toHaveText(`2 / ${count}`);
  await page.screenshot({ path: "artifacts/shared-pptx-page2-live.png", fullPage: true });
  expect(reads).toBe(readsAfterLoad);
  console.log(JSON.stringify({ metadataStatus: metadata.status(), contentStatus: content.status(), bytes: info.size, slides: count }));
});
