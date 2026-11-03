import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { symmetricDecrypt } from "better-auth/crypto";
import { createAppAuth } from "../src/lib/auth.server";
import { artifactDirectory, assertUserFile, upstreamThreadId, userOssPolicy } from "../src/lib/user-scope.server";
const secret = "test-auth-secret-with-at-least-32-characters-only";
const base = "http://localhost:3000";
const cookieOf = (response: Response) => response.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");

test("SQLite persists hashed passwords, authenticated sessions, logout and CSRF rejection", async () => {
  const db = new Database(":memory:");
  try {
    const auth = await createAppAuth(db, base, secret);
    const call = (endpoint: string, body?: unknown, cookie = "", origin = base) => auth.handler(new Request(`${base}/api/auth/${endpoint}`, {
      method: body ? "POST" : "GET", headers: { "content-type": "application/json", origin, cookie }, ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const credentials = { name: "测试用户", email: "alice@example.test", password: "correct-test-password" };
    assert.equal((await call("sign-up/email", { ...credentials, password: "short" })).status, 400);
    const created = await call("sign-up/email", credentials);
    assert.equal(created.status, 200);
    const cookie = cookieOf(created);
    assert.match(created.headers.get("set-cookie")!, /HttpOnly/i);
    assert.match(created.headers.get("set-cookie")!, /SameSite=Lax/i);
    const user = (await created.json()).user;
    const row = db.prepare('SELECT password FROM account WHERE "userId" = ?').get(user.id) as { password: string };
    assert.ok(row.password && row.password !== credentials.password);
    const session = await (await call("get-session", undefined, cookie)).json();
    assert.equal(session.user.id, user.id);
    assert.equal((await call("sign-in/email", { ...credentials, password: "wrong-test-password" })).status, 401);
    assert.equal((await call("sign-in/email", credentials, "", "https://attacker.example")).status, 403);
    const login = await call("sign-in/email", credentials);
    assert.equal(login.status, 200);
    const secondCookie = cookieOf(login);
    const changed = await call("change-password", { currentPassword: credentials.password, newPassword: "new-correct-test-password", revokeOtherSessions: true }, cookie);
    assert.equal(changed.status, 200);
    assert.equal(await (await call("get-session", undefined, secondCookie)).json(), null);
    assert.equal((await call("sign-out", {}, cookie)).status, 200);
    assert.equal(await (await call("get-session", undefined, cookie)).json(), null);
  } finally { db.close(); }
});

test("cloud ID tokens are encrypted in SQLite and hidden from account data", async () => {
  const db = new Database(":memory:");
  try {
    const auth = await createAppAuth(db, base, secret);
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ name: "Cloud", email: "cloud@aliyun.invalid", emailVerified: false }, { method: "oauth" });
    await ctx.internalAdapter.createAccount({ userId: user.id, providerId: "aliyun", accountId: "opaque-cloud-subject", idToken: "private.test.id-token" });
    const row = db.prepare('SELECT "identityToken", "idToken" FROM account WHERE "userId" = ?').get(user.id) as { identityToken: string; idToken: string | null };
    assert.equal(row.idToken, null);
    assert.ok(row.identityToken && !row.identityToken.includes("private.test"));
    assert.equal(await symmetricDecrypt({ key: secret, data: row.identityToken }), "private.test.id-token");
  } finally { db.close(); }
});

test("user scopes isolate identical thread IDs and reject cross-user / legacy file paths", () => {
  assert.notEqual(upstreamThreadId("alice", "thread-1"), upstreamThreadId("bob", "thread-1"));
  assert.equal(assertUserFile("alice", artifactDirectory("alice") + "/report.pdf"), artifactDirectory("alice") + "/report.pdf");
  for (const path of [artifactDirectory("bob") + "/report.pdf", "/mnt/oss/data/report.pdf", artifactDirectory("alice") + "/../bob.pdf"]) assert.throws(() => assertUserFile("alice", path));
  const previous = process.env.OSS_BUCKET;
  process.env.OSS_BUCKET = "test-private-bucket";
  const policy = JSON.parse(userOssPolicy("alice"));
  assert.deepEqual(policy.Statement[0].Action, ["oss:GetObject"]);
  assert.ok(policy.Statement[0].Resource[0].endsWith(artifactDirectory("alice").slice("/mnt/oss/data".length) + "/*"));
  if (previous === undefined) delete process.env.OSS_BUCKET; else process.env.OSS_BUCKET = previous;
});
