import { test, expect } from "@playwright/test";

test("register, sign out, sign in, change password and protect APIs", async ({ page }) => {
  const email = `auth-${crypto.randomUUID()}@example.test`;
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  await page.screenshot({ path: "artifacts/auth-login-desktop.png", fullPage: true });
  expect((await page.request.post("/api/chat", { data: {} })).status()).toBe(401);
  expect((await page.request.get("/api/files?path=/mnt/oss/data/test.pdf")).status()).toBe(401);
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await page.getByLabel("昵称").fill("青柠");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill("auth-e2e-test-password");
  await page.screenshot({ path: "artifacts/auth-register-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect(page.getByRole("heading", { name: "有什么我可以帮你的吗？" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "账号设置" })).toBeVisible();
  await page.getByRole("button", { name: "账号设置" }).click();
  await expect(page.getByRole("dialog", { name: "账号设置" })).toContainText(email);
  await page.getByLabel("当前密码").fill("auth-e2e-test-password");
  await page.getByLabel("新密码", { exact: true }).fill("auth-e2e-updated-password");
  await page.getByRole("button", { name: "更新密码" }).click();
  await expect(page.getByRole("dialog", { name: "账号设置" }).getByRole("status")).toContainText("密码已更新");
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/chat")).status()).toBe(401);
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill("auth-e2e-test-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".auth-error")).toContainText("邮箱或密码不正确");
  await page.getByLabel("密码", { exact: true }).fill("auth-e2e-updated-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  const cookie = (await page.context().cookies()).find(c => c.name.includes("session_token"));
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
});

test("accounts have separate browser histories and cannot read outside the Agent mount", async ({ page }) => {
  const base = test.info().project.use.baseURL as string;
  const register = async (name: string) => {
    const response = await page.request.post("/api/auth/sign-up/email", { headers: { origin: base }, data: { name, email: `${name}-${crypto.randomUUID()}@example.test`, password: "isolation-test-password" } });
    expect(response.ok()).toBe(true);
    return (await response.json()).user.id as string;
  };
  const a = await register("alice");
  await page.addInitScript(({ userId }) => localStorage.setItem(`agentcore-chat:v1:${userId}`, JSON.stringify({ activeId: "private-thread", conversations: [{ id: "private-thread", title: "Alice 的私人对话", createdAt: Date.now(), updatedAt: Date.now(), messages: [{ id: "msg", role: "user", content: "Alice 的私密内容", status: "complete" }] }] })), { userId: a });
  await page.goto("/");
  await expect(page.locator(".user-message")).toContainText("Alice 的私密内容");
  await page.request.post("/api/auth/sign-out", { headers: { origin: base }, data: {} });
  await register("bob");
  await page.reload();
  await expect(page.getByRole("heading", { name: "有什么我可以帮你的吗？" })).toBeVisible();
  await expect(page.getByText("Alice 的私密内容")).toHaveCount(0);
  // Applies in both shared and user access modes. Cross-user denial in user
  // mode is covered at the route boundary by tests/chat-route.test.ts.
  const response = await page.request.get("/api/files?path=" + encodeURIComponent("/mnt/oss/data/../private/report.pdf"));
  expect(response.status()).toBe(400);
});

test("mobile login remains usable without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/auth-login-mobile.png", fullPage: true });
});
