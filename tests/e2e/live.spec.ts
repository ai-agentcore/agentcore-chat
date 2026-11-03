import { test, expect } from "./fixtures";

test("real AgentCore response reaches the browser renderer", async ({ page }) => {
  test.skip(process.env.LIVE_AGENT !== "1", "Set LIVE_AGENT=1 to call the configured upstream service.");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("textbox", { name: "向 AgentCore 提问" }).fill("请用中文简短介绍一下你自己，再列出三件你可以帮我做的事。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新生成", exact: true })).toBeVisible({ timeout: 100_000 });
  await expect(page.locator(".message-error")).toHaveCount(0);
  await expect(page.getByTestId("ai-content")).not.toBeEmpty();
  await page.screenshot({ path: "artifacts/live-conversation.png", fullPage: true });
  expect(errors).toEqual([]);
});
