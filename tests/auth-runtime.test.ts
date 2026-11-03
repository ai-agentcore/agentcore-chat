import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aliyunEnabled, getAuth } from "../src/lib/auth.server";
import { localAuthRedirect } from "../src/lib/auth-origin.server";
import { aliyunLoginError } from "../src/lib/auth-errors";
const directory = mkdtempSync(join(tmpdir(), "agentcore-auth-reload-"));
after(() => rmSync(directory, { recursive: true, force: true }));

test("OAuth environment settings cannot enable login or disrupt email sessions", async (t) => {
  process.env.BETTER_AUTH_SECRET = "test-runtime-secret-at-least-32-characters-long";
  process.env.BETTER_AUTH_URL = "http://127.0.0.1:3000";
  process.env.AUTH_DATABASE_PATH = join(directory, "auth.sqlite");
  delete process.env.ALIYUN_OAUTH_CLIENT_ID;
  delete process.env.ALIYUN_OAUTH_CLIENT_SECRET;
  const first = await getAuth();
  assert.equal(first, await getAuth());
  const created = await first.api.signUpEmail({ body: { name: "Persisted", email: "persisted@example.test", password: "test-persistent-password" }, asResponse: true });
  const userId = (await created.json()).user.id;
  const cookie = created.headers.getSetCookie().map(c => c.split(";", 1)[0]).join("; ");
  let discoveryCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    assert.equal(String(input), "https://oauth.aliyun.com/.well-known/openid-configuration");
    discoveryCalls++;
    return Response.json({ issuer: "https://oauth.aliyun.com", authorization_endpoint: "https://signin.aliyun.com/oauth2/v1/auth", token_endpoint: "https://oauth.aliyun.com/v1/token", jwks_uri: "https://oauth.aliyun.com/v1/keys", id_token_signing_alg_values_supported: ["RS256"] });
  });
  process.env.ALIYUN_OAUTH_CLIENT_ID = "newly-configured-client";
  process.env.ALIYUN_OAUTH_CLIENT_SECRET = "test-only-unused-secret";
  assert.equal(aliyunEnabled(), false);
  const second = await getAuth();
  assert.equal(first, second);
  assert.equal(second, await getAuth());
  const session = await second.api.getSession({ headers: new Headers({ cookie }) });
  assert.equal(session?.user.id, userId);
  const response = await second.handler(new Request("http://127.0.0.1:3000/api/auth/sign-in/social", {
    method: "POST", headers: { origin: "http://127.0.0.1:3000", "content-type": "application/json" },
    body: JSON.stringify({ provider: "aliyun", callbackURL: "/" }),
  }));
  assert.ok(response.status >= 400);
  assert.equal((await response.json()).code, "PROVIDER_NOT_FOUND");
  assert.equal(discoveryCalls, 0);
  delete process.env.ALIYUN_OAUTH_CLIENT_ID;
  delete process.env.ALIYUN_OAUTH_CLIENT_SECRET;
  assert.equal(await getAuth(), second);
});

test("local login aliases use the configured cookie/callback host without trusting arbitrary origins", () => {
  const canonical = "http://127.0.0.1:3000";
  assert.equal(localAuthRedirect("localhost:3000", canonical, false), canonical + "/login");
  assert.equal(localAuthRedirect("127.0.0.1:3000", canonical, false), null);
  assert.equal(localAuthRedirect("evil.example", canonical, false), null);
  assert.equal(localAuthRedirect("localhost:3000", "https://production.example", false), null);
  assert.equal(localAuthRedirect("localhost:3000", canonical, true), null);
  assert.equal(localAuthRedirect("localhost:3000", "invalid", false), null);
});

test("login errors distinguish origin, provider setup and throttling from network failure", () => {
  assert.match(aliyunLoginError({ code: "INVALID_ORIGIN", status: 403 }), /访问地址/);
  assert.match(aliyunLoginError({ code: "PROVIDER_NOT_FOUND", status: 404 }), /应用 ID/);
  assert.match(aliyunLoginError({ status: 429 }), /尝试较多/);
  assert.match(aliyunLoginError(), /暂时无法连接/);
});
