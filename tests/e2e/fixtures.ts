import { test as base, expect, request as createRequest, type BrowserContext } from "@playwright/test";
type AccountFixture = { cookies: Awaited<ReturnType<BrowserContext["cookies"]>>; userId: string };
export const test = base.extend<{ accountReady: void }, { testAccount: AccountFixture }>({
  testAccount: [async ({}, use) => {
    const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:3000";
    const request = await createRequest.newContext({ baseURL });
    const response = await request.post("/api/auth/sign-up/email", { headers: { origin: baseURL }, data: {
      name: "E2E 测试用户", email: `e2e-${crypto.randomUUID()}@example.test`, password: "e2e-only-test-password",
    } });
    expect(response.ok(), await response.text()).toBe(true);
    const userId = (await response.json()).user.id;
    await use({ userId, cookies: (await request.storageState()).cookies });
    await request.dispose();
  }, { scope: "worker" }],
  accountReady: [async ({ context, testAccount }, use) => {
    await context.addCookies(testAccount.cookies);
    await use();
  }, { auto: true }],
});
export { expect };
export type { Page } from "@playwright/test";
