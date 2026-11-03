import { test, expect } from "@playwright/test";

test("local login alias shows email login without the disabled Aliyun entry", async ({ page, baseURL }) => {
  const base = new URL(baseURL || "http://127.0.0.1:3000");
  test.skip(!["127.0.0.1", "localhost"].includes(base.hostname), "Local alias behavior only applies to loopback development.");
  const alias = new URL("/login", base);
  alias.hostname = base.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
  await page.goto(alias.href);
  await expect(page).toHaveURL(new URL("/login", base).href);
  const login = page.getByRole("button", { name: "使用阿里云账号继续" });
  await expect(login).toHaveCount(0);
  await expect(page.getByText("阿里云登录即将开放，可先使用邮箱。")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "邮箱" })).toBeVisible();
});
