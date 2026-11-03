import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAppAuth } from "../src/lib/auth.server";
import { readStoredAliyunProfile } from "../src/lib/user-profile.server";

// Local protocol simulation: real RSA signatures, actual Better Auth callback,
// state cookies, PKCE verifier and SQLite. No Alibaba credentials are required.
test("Aliyun OIDC callback validates signed claims, nonce and state before creating an account", async (t) => {
  const previous = process.env.ALIYUN_OAUTH_CLIENT_ID;
  process.env.ALIYUN_OAUTH_CLIENT_ID = "test-aliyun-client";
  const db = new Database(":memory:");
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256", use: "sig" };
  let nonce = "";
  let invalidNonce = false;
  let invalidAudience = false;
  let tokenCalls = 0;
  const base = "http://localhost:3000";
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: "https://oauth.aliyun.com", authorization_endpoint: "https://signin.aliyun.com/oauth2/v1/auth", token_endpoint: "https://oauth.aliyun.com/v1/token", jwks_uri: "https://oauth.aliyun.com/test-jwks", id_token_signing_alg_values_supported: ["RS256"] });
    if (url.endsWith("/test-jwks")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/v1/token")) {
      tokenCalls++;
      const fields = new URLSearchParams(String(init?.body));
      assert.ok(fields.get("code_verifier"));
      assert.equal(fields.get("client_id"), "test-aliyun-client");
      const idToken = await new SignJWT({ nonce: invalidNonce ? "wrong-nonce" : nonce, name: "云端用户", login_name: "cloud-login@example.test", type: "Account" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer("https://oauth.aliyun.com")
        .setAudience(invalidAudience ? "different-app" : "test-aliyun-client").setSubject("immutable-cloud-subject")
        .setIssuedAt().setExpirationTime("10m").sign(privateKey);
      return Response.json({ id_token: idToken, access_token: "test-access-token", token_type: "Bearer", expires_in: 600 });
    }
    throw new Error("Unexpected OAuth URL: " + url);
  });
  try {
    // Exercise the retained provider explicitly; application settings keep it off.
    const auth = await createAppAuth(db, base, "test-oidc-secret-with-at-least-32-characters", { clientId: "test-aliyun-client" });
    const authorize = async () => {
      // Isolate protocol cases from the independent sign-in rate limiter.
      db.prepare('DELETE FROM "rateLimit"').run();
      const response = await auth.handler(new Request(`${base}/api/auth/sign-in/social`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ provider: "aliyun", callbackURL: "/", errorCallbackURL: "/login?error=aliyun" }) }));
      assert.equal(response.status, 200);
      const url = new URL((await response.json()).url);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.ok(url.searchParams.get("code_challenge"));
      nonce = url.searchParams.get("nonce")!; assert.ok(nonce);
      return { state: url.searchParams.get("state")!, cookie: response.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ") };
    };
    const finish = (state: string, cookie: string) => auth.handler(new Request(`${base}/api/auth/callback/aliyun?code=test-code&state=${encodeURIComponent(state)}`, { headers: { cookie } }));
    const forgedState = await authorize();
    await finish("invalid-state", forgedState.cookie);
    assert.equal(tokenCalls, 0);
    invalidNonce = true;
    const bad = await authorize(); const denied = await finish(bad.state, bad.cookie);
    assert.ok(denied.headers.get("location")?.includes("error="));
    assert.equal((db.prepare('SELECT count(*) as count FROM user').get() as { count: number }).count, 0);
    invalidNonce = false; invalidAudience = true;
    const wrongAud = await authorize(); await finish(wrongAud.state, wrongAud.cookie);
    assert.equal((db.prepare('SELECT count(*) as count FROM user').get() as { count: number }).count, 0);
    invalidAudience = false;
    const good = await authorize(); const accepted = await finish(good.state, good.cookie);
    assert.equal(accepted.status, 302);
    assert.equal(new URL(accepted.headers.get("location")!, base).pathname, "/");
    assert.ok(accepted.headers.get("set-cookie")?.includes("session_token"));
    const account = db.prepare('SELECT "providerId", "accountId", "idToken", "identityToken" FROM account').get() as Record<string, string | null>;
    assert.equal(account.providerId, "aliyun"); assert.equal(account.accountId, "immutable-cloud-subject");
    assert.equal(account.idToken, null); assert.ok(account.identityToken);
    assert.deepEqual(await readStoredAliyunProfile({ accountId: account.accountId!, identityToken: account.identityToken }, "test-oidc-secret-with-at-least-32-characters"), {
      displayName: "云端用户", loginName: "cloud-login@example.test", accountType: "account",
    });
    const count = tokenCalls;
    await finish(good.state, good.cookie);
    assert.equal(tokenCalls, count, "consumed state must not exchange again");
  } finally {
    db.close();
    if (previous === undefined) delete process.env.ALIYUN_OAUTH_CLIENT_ID; else process.env.ALIYUN_OAUTH_CLIENT_ID = previous;
  }
});
