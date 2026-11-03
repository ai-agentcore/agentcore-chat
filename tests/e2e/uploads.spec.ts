import { expect, test } from "./fixtures";

const frame = (value: object) => `data: ${JSON.stringify(value)}\n\n`;

test("uploads a file directly to OSS, shows it in the composer, and sends its immutable reference", async ({ page }) => {
  let uploadedBytes = "";
  let chatBody: Record<string, unknown> | undefined;
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { configured: true } });
    chatBody = route.request().postDataJSON();
    return route.fulfill({ contentType: "text/event-stream", body: frame({ type: "TEXT_MESSAGE_CONTENT", delta: "我已经看到附件。" }) + frame({ type: "RUN_FINISHED" }) });
  });
  await page.route("**/api/uploads", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "create") return route.fulfill({ json: {
      uploadId: "up_e2e", objectName: "file.txt", uploadUrl: "https://oss-upload.example.test/signed",
      headers: { "Content-Type": "text/plain" },
    } });
    return route.fulfill({ json: {
      id: "up_e2e", name: "notes.txt", mimeType: "text/plain", size: 12,
      uri: "oss://chat-bucket/agentcore/files/users/u/thread/uploads/up_e2e/file.txt",
      etag: '"etag-e2e"', region: "oss-cn-hangzhou",
    } });
  });
  await page.route("https://oss-upload.example.test/signed", async (route) => {
    uploadedBytes = route.request().postData() || "";
    return route.fulfill({ status: 200 });
  });

  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "添加文件" }).click();
  await (await chooser).setFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello upload") });
  await expect(page.getByText("notes.txt", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/KB/, { exact: false }).first()).toBeVisible();
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("总结这个文件");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByTestId("ai-content")).toContainText("看到附件");
  expect(uploadedBytes).toBe("hello upload");
  const messages = chatBody?.messages as Array<{ attachments?: Array<{ etag: string; uri: string }> }>;
  expect(messages.at(-1)?.attachments?.[0]).toMatchObject({ etag: '"etag-e2e"', uri: expect.stringMatching(/^oss:\/\//) });
});
