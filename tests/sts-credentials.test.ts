import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { resolveStsBrokerUrl } from "../src/lib/agent-api-config.server";
import { createBrokerCredentialProvider, type BrokerConfig, type StsGrant } from "../src/lib/sts-credentials.server";

const epoch = 1_800_000_000_000;
const secretHex = "12".repeat(32);
const auth = { keyId: "chat-server", secret: Buffer.from(secretHex, "hex") };
const config: BrokerConfig = { url: "https://broker.example.com/v1/sts", keyId: auth.keyId, secretHex, apiKey: "agent-gateway-key" };
const policy = JSON.stringify({ Version: "1", Statement: [{ Effect: "Allow", Action: ["oss:GetObject"], Resource: ["user-scope"] }] });
const aliceGrant = { identity: { type: "userId" as const, userId: "app:alice" }, policy };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sign = (value: string) => createHmac("sha256", auth.secret).update(value).digest("hex");
const credentials = (now = epoch) => ({
  accessKeyId: "STS.test-only",
  accessKeySecret: "test-only-secret",
  securityToken: "test-only-token",
  expiration: new Date(now + 900_000).toISOString(),
});

type BrokerReply = { statusCode: number; body: string; headers: Record<string, string> };
type Provider = (grant: StsGrant) => Promise<ReturnType<typeof credentials>>;

function bridge(provider: Provider, transform?: (result: BrokerReply, nonce: string) => void): typeof fetch {
  return async (input, options) => {
    assert.equal(options?.redirect, "error");
    assert.equal(options?.cache, "no-store");
    assert.equal(options?.method, "POST");
    const headers = Object.fromEntries(new Headers(options?.headers));
    assert.equal(headers["x-api-key"], config.apiKey);
    assert.equal(new URL(String(input)).pathname, "/v1/sts");
    const body = String(options?.body);
    const request = JSON.parse(body) as { version: number } & StsGrant;
    assert.equal(request.version, 1);
    const nonce = headers["x-sts-nonce"];
    const canonical = ["STS-BROKER-V1", "POST", "/v1/sts", auth.keyId, headers["x-sts-timestamp"], nonce, hash(body)].join("\n");
    assert.equal(headers["x-sts-signature"], sign(canonical));
    const responseBody = JSON.stringify({ version: 1, credentials: await provider(request) });
    const result: BrokerReply = {
      statusCode: 200,
      body: responseBody,
      headers: { "X-STS-Response-Signature": sign(["STS-BROKER-RESPONSE-V1", nonce, hash(responseBody)].join("\n")) },
    };
    transform?.(result, nonce);
    return new Response(result.body, { status: result.statusCode, headers: result.headers });
  };
}

test("Next.js agrees with the Runloop STS contract, signing, caching and refresh", async () => {
  let now = epoch;
  let calls = 0;
  const get = createBrokerCredentialProvider(config, {
    now: () => now,
    fetch: bridge(async () => { calls++; return credentials(now); }),
  });
  const all = await Promise.all(Array.from({ length: 10 }, () => get(aliceGrant)));
  assert.equal(calls, 1);
  assert.deepEqual(all[0], credentials(now));
  now += 100_000; await get(aliceGrant); assert.equal(calls, 1);
  now += 501_000; await get(aliceGrant); assert.equal(calls, 2);
});

test("transport is HTTPS-only and rejects URL credentials, query strings and weak secrets", () => {
  for (const overrides of [
    { url: "http://broker.example.com/v1/sts" }, { url: "https://user:pass@broker.example.com/v1/sts" },
    { url: config.url + "?key=value" }, { url: config.url + "#fragment" }, { secretHex: "short" }, { url: "https://broker.example.com/" },
  ]) assert.throws(() => createBrokerCredentialProvider({ ...config, ...overrides }), /尚未配置/);
});

test("tampered signatures, unsupported versions and expired credentials are never accepted", async () => {
  const transforms = [
    (data: { version: number }) => { data.version = 2; },
    (data: { credentials: Record<string, string> }) => { data.credentials.expiration = new Date(epoch - 1).toISOString(); },
    (data: { credentials: Record<string, string> }) => { delete data.credentials.securityToken; },
  ];
  for (const change of transforms) {
    const get = createBrokerCredentialProvider(config, { now: () => epoch, fetch: bridge(async () => credentials(), (result, nonce) => {
      const data = JSON.parse(result.body); change(data); result.body = JSON.stringify(data);
      result.headers["X-STS-Response-Signature"] = sign(["STS-BROKER-RESPONSE-V1", nonce, hash(result.body)].join("\n"));
    }) });
    await assert.rejects(get(aliceGrant), /暂时无法获取/);
  }
  const unsigned = createBrokerCredentialProvider(config, { now: () => epoch, fetch: bridge(async () => credentials(), (result) => {
    result.headers["X-STS-Response-Signature"] = "00".repeat(32);
  }) });
  await assert.rejects(unsigned(aliceGrant), /暂时无法获取/);
});

test("refresh failures do not leak upstream errors or reuse expired credentials and can recover", async () => {
  let now = epoch;
  let fail = false;
  let calls = 0;
  const good = bridge(async () => credentials(now));
  const get = createBrokerCredentialProvider(config, { now: () => now, fetch: async (...args) => {
    calls++; if (fail) throw new Error("SECRET upstream token"); return good(...args);
  } });
  await get(aliceGrant); now += 901_000; fail = true;
  await assert.rejects(get(aliceGrant), (error: Error) => { assert.doesNotMatch(error.message, /SECRET|token/); return true; });
  fail = false; await get(aliceGrant); assert.equal(calls, 3);
});

test("oversized broker replies are cancelled without parsing their contents", async () => {
  const get = createBrokerCredentialProvider(config, { now: () => epoch, fetch: async () => new Response("x".repeat(65 * 1024)) });
  await assert.rejects(get(aliceGrant), /暂时无法获取/);
});

test("user-aware calls never share STS across users or policies", async () => {
  let calls = 0;
  const get = createBrokerCredentialProvider(config, { now: () => epoch, fetch: bridge(async (grant) => {
    calls++;
    return { ...credentials(), accessKeyId: "STS." + (grant.identity.type === "userId" ? grant.identity.userId : "jwt") };
  }) });
  const bob = { identity: { type: "userId" as const, userId: "app:bob" }, policy };
  const [a, b] = await Promise.all([get(aliceGrant), get(bob), get(aliceGrant)]);
  assert.notEqual(a.accessKeyId, b.accessKeyId); assert.equal(calls, 2);
  await get({ ...aliceGrant, policy: JSON.stringify({ Version: "1", Statement: [{ Effect: "Allow", Action: ["oss:GetObject"], Resource: ["another-scope"] }] }) });
  assert.equal(calls, 3);
});

test("gateway-only mode reuses the explicitly supplied API key without HMAC headers", async () => {
  const get = createBrokerCredentialProvider({ url: config.url, apiKey: "agent-api-key" }, {
    now: () => epoch,
    fetch: async (_input, options) => {
      const headers = new Headers(options?.headers);
      assert.equal(headers.get("x-api-key"), "agent-api-key");
      assert.equal(headers.get("x-sts-signature"), null);
      return Response.json({ version: 1, credentials: credentials() });
    },
  });
  assert.deepEqual(await get(aliceGrant), credentials());
});

test("an omitted broker URL reuses the Agent API base with the fixed STS path", () => {
  assert.equal(resolveStsBrokerUrl({ AGENT_API_BASE_URL: "https://agent.example.test", AGENT_API_PATH: "/ag-ui/agent" }), "https://agent.example.test/v1/sts");
  assert.equal(resolveStsBrokerUrl({ AGENT_API_BASE_URL: "https://agent.example.test", STS_BROKER_URL: "https://broker.example.test/v1/sts" }), "https://broker.example.test/v1/sts");
});
