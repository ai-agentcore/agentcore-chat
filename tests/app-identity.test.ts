import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { getAuth, getSession, getUserIdentity, type AppSession } from "../src/lib/auth.server";
import { agentIdentityAuthMode, issueAppIdentityJwt } from "../src/lib/app-identity.server";
import { artifactDirectory } from "../src/lib/user-scope.server";
import { GET as discovery } from "../src/app/.well-known/openid-configuration/route";
import { GET as jwks } from "../src/app/.well-known/jwks.json/route";
import { GET as fileGet } from "../src/app/api/files/route";
import { GET as authGet } from "../src/app/api/auth/[...all]/route";

const directory = mkdtempSync(join(tmpdir(), "agentcore-issuer-test-"));
const keyFile = join(directory, "identity", "keyring.private.json");
const issuer = "https://identity.example.test";
const audience = "agentcore-chat-test";
const options = { issuer, audience, algorithms: ["RS256"] };
let alice: AppSession;
let bob: AppSession;
let cookie: string;
const setupKey = (...args: string[]) => execFileSync(process.execPath, ["scripts/setup-identity.mjs", ...args], {
  env: { ...process.env, APP_IDENTITY_KEY_FILE: keyFile }, encoding: "utf8",
});
const fileRequest = (path: string, authenticated = true) => new Request("http://localhost:3000/api/files?path=" + encodeURIComponent(path), { headers: authenticated ? { cookie } : {} });

before(async () => {
  Object.assign(process.env, {
    BETTER_AUTH_SECRET: "test-only-issuer-secret-with-more-than-32-characters", BETTER_AUTH_URL: "http://localhost:3000",
    AUTH_DATABASE_PATH: join(directory, "auth.sqlite"), APP_IDENTITY_KEY_FILE: keyFile,
  });
  delete process.env.ALIYUN_OAUTH_CLIENT_ID;
  setupKey();
  const auth = await getAuth();
  for (const name of ["alice", "bob"]) {
    const created = await auth.api.signUpEmail({ body: { name, email: `${name}@example.test`, password: "test-identity-password" }, asResponse: true });
    assert.equal(created.status, 200);
    const currentCookie = created.headers.getSetCookie().map(item => item.split(";", 1)[0]).join("; ");
    const session = await getSession(new Headers({ cookie: currentCookie }));
    assert.ok(session);
    if (name === "alice") { alice = session; cookie = currentCookie; } else bob = session;
  }
});
beforeEach(() => Object.assign(process.env, {
  AGENT_IDENTITY_AUTH_MODE: "app_jwt", APP_IDENTITY_ISSUER: issuer, APP_IDENTITY_AUDIENCE: audience,
  APP_IDENTITY_KEY_FILE: keyFile, APP_IDENTITY_TOKEN_TTL_SECONDS: "900", FILE_ACCESS_MODE: "shared",
}));
after(() => rmSync(directory, { recursive: true, force: true }));

test("public discovery and JWKS verify a session-bound JWT without exposing private keys or user data", async () => {
  const document = await discovery();
  assert.equal(document.status, 200);
  const metadata = await document.json();
  assert.equal(metadata.issuer, issuer);
  assert.equal(metadata.jwks_uri, issuer + "/.well-known/jwks.json");
  const publicResponse = await jwks();
  assert.equal(publicResponse.status, 200);
  const publicKeys = await publicResponse.json();
  for (const key of publicKeys.keys) assert.deepEqual(Object.keys(key).sort(), ["alg", "e", "kid", "kty", "n", "use"]);
  const [a, aConcurrent] = await Promise.all([issueAppIdentityJwt(alice), issueAppIdentityJwt(alice)]);
  assert.equal(a, aConcurrent);
  assert.equal(a, await issueAppIdentityJwt(alice));
  const verified = await jwtVerify(a, createLocalJWKSet(publicKeys), options);
  assert.equal(verified.payload.sub, `app:${alice.user.id}`);
  assert.deepEqual(Object.keys(verified.payload).sort(), ["aud", "exp", "iat", "iss", "jti", "sub"]);
  assert.equal(verified.payload.exp! - verified.payload.iat!, 900);
  assert.equal(verified.protectedHeader.alg, "RS256");
  const b = await issueAppIdentityJwt(bob);
  assert.notEqual(a, b);
  assert.equal((await jwtVerify(b, createLocalJWKSet(publicKeys), options)).payload.sub, `app:${bob.user.id}`);
  assert.equal((await authGet(new Request("http://localhost:3000/api/auth/token", { headers: { cookie } }))).status, 404);
  assert.equal((statSync(keyFile).mode & 0o777), 0o600);
});

test("JWT signatures, issuer, audience and expiry are validated with the published keys", async () => {
  const token = await issueAppIdentityJwt(alice);
  const keys = createLocalJWKSet(await (await jwks()).json());
  await assert.rejects(jwtVerify(token, keys, { ...options, issuer: "https://wrong.example.test" }));
  await assert.rejects(jwtVerify(token, keys, { ...options, audience: "different-audience" }));
  await assert.rejects(jwtVerify(token, keys, { ...options, currentDate: new Date(Date.now() + 901_000) }));
  const parts = token.split(".");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  parts[1] = Buffer.from(JSON.stringify({ ...claims, sub: `app:${bob.user.id}` })).toString("base64url");
  await assert.rejects(jwtVerify(parts.join("."), keys, options));
  const shortSession = { ...alice, session: { ...alice.session, expiresAt: new Date(Date.now() + 180_000) } };
  const bounded = await jwtVerify(await issueAppIdentityJwt(shortSession), keys, options);
  assert.ok(bounded.payload.exp! <= Math.floor(shortSession.session.expiresAt.getTime() / 1000));
  await assert.rejects(issueAppIdentityJwt({ ...alice, session: { ...alice.session, expiresAt: new Date(0) } }), { code: "SESSION_REAUTH_REQUIRED" });
});

test("default user_id needs no issuer, and JWT or invalid configurations never silently downgrade", async () => {
  delete process.env.AGENT_IDENTITY_AUTH_MODE;
  delete process.env.APP_IDENTITY_ISSUER;
  assert.equal(agentIdentityAuthMode(), "user_id");
  assert.deepEqual(await getUserIdentity(alice), { type: "userId", userId: `app:${alice.user.id}` });
  assert.equal((await discovery()).status, 503);
  process.env.AGENT_IDENTITY_AUTH_MODE = "app_jwt";
  await assert.rejects(getUserIdentity(alice), { code: "APP_IDENTITY_NOT_CONFIGURED" });
  for (const invalid of ["http://site.example.test", "https://localhost", "https://site.example.test/path", "https://site.example.test?issuer=other"]) {
    process.env.APP_IDENTITY_ISSUER = invalid;
    assert.equal((await discovery()).status, 503);
    await assert.rejects(getUserIdentity(alice), { code: "APP_IDENTITY_NOT_CONFIGURED" });
  }
  process.env.APP_IDENTITY_ISSUER = issuer;
  process.env.APP_IDENTITY_KEY_FILE = join(directory, "missing-private-key.json");
  const failure = await jwks();
  assert.equal(failure.status, 503);
  assert.ok(!(await failure.text()).includes(directory));
  process.env.AGENT_IDENTITY_AUTH_MODE = "typo";
  await assert.rejects(getUserIdentity(alice), { code: "APP_IDENTITY_NOT_CONFIGURED" });
});

test("real authenticated file routes use our JWT in both file modes and derive separate read policies", async (t) => {
  Object.assign(process.env, { OSS_BUCKET: "test-bucket", OSS_REGION: "oss-cn-hangzhou", OSS_OBJECT_PREFIX: "agentcore/ppts",
    STS_BROKER_URL: "https://issuer-broker.example.test/v1/sts", STS_BROKER_KEY_ID: "test", STS_BROKER_SECRET: "ab".repeat(32) });
  const grants: { identity: { type: string; userToken: string }; policy: string }[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    grants.push(JSON.parse(String(init?.body)));
    return Response.json({}, { status: 503 }); // inspect grant without using cloud credentials
  });
  assert.equal((await fileGet(fileRequest("/mnt/oss/data/demo.pptx", false))).status, 401);
  assert.equal(grants.length, 0);
  assert.equal((await fileGet(fileRequest("/mnt/oss/data/demo.pptx"))).status, 502);
  process.env.FILE_ACCESS_MODE = "user";
  assert.equal((await fileGet(fileRequest(artifactDirectory(bob.user.id) + "/demo.pptx"))).status, 403);
  assert.equal(grants.length, 1);
  assert.equal((await fileGet(fileRequest(artifactDirectory(alice.user.id) + "/demo.pptx"))).status, 502);
  assert.equal(grants.length, 2);
  const keys = createLocalJWKSet(await (await jwks()).json());
  for (const grant of grants) {
    assert.equal(grant.identity.type, "jwt");
    assert.equal((await jwtVerify(grant.identity.userToken, keys, options)).payload.sub, `app:${alice.user.id}`);
    assert.deepEqual(JSON.parse(grant.policy).Statement[0].Action, ["oss:GetObject"]);
  }
  assert.equal(grants[0].identity.userToken, grants[1].identity.userToken);
  assert.equal(JSON.parse(grants[0].policy).Statement[0].Resource[0], "acs:oss:*:*:test-bucket/agentcore/ppts/*");
  assert.ok(JSON.parse(grants[1].policy).Statement[0].Resource[0].endsWith(artifactDirectory(alice.user.id).slice("/mnt/oss/data".length) + "/*"));
  delete process.env.APP_IDENTITY_ISSUER;
  assert.equal((await fileGet(fileRequest(artifactDirectory(alice.user.id) + "/demo.pptx"))).status, 503);
  assert.equal(grants.length, 2);
});

test("explicit key rotation retains verification of existing JWTs and initialization never overwrites keys", async () => {
  const digest = () => createHash("sha256").update(readFileSync(keyFile)).digest("hex");
  const before = digest();
  setupKey();
  assert.equal(digest(), before);
  const previousToken = await issueAppIdentityJwt(alice);
  setupKey("--rotate");
  const currentToken = await issueAppIdentityJwt(alice);
  assert.notEqual(decodeProtectedHeader(previousToken).kid, decodeProtectedHeader(currentToken).kid);
  const published = await (await jwks()).json();
  assert.equal(published.keys.length, 2);
  for (const key of published.keys) assert.deepEqual(Object.keys(key).sort(), ["alg", "e", "kid", "kty", "n", "use"]);
  const keys = createLocalJWKSet(published);
  await jwtVerify(previousToken, keys, options);
  await jwtVerify(currentToken, keys, options);
  const ring = JSON.parse(readFileSync(keyFile, "utf8"));
  assert.equal(ring.keys.filter((key: { d?: string }) => key.d).length, 1);
});

test("logging out prevents file credential issuance even when a JWT remains in the server cache", async (t) => {
  await issueAppIdentityJwt(alice);
  const auth = await getAuth();
  await auth.api.signOut({ headers: new Headers({ cookie }) });
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not call broker"); });
  assert.equal(await getSession(new Headers({ cookie })), null);
  assert.equal((await fileGet(fileRequest("/mnt/oss/data/demo.pptx"))).status, 401);
  assert.equal(network.mock.callCount(), 0);
});
