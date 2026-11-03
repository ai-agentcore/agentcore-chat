import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FileAccessError } from "../src/lib/files";
import { getNasReadCredentials, nasAccessConfig, nasReadPolicy } from "../src/lib/nas-access.server";
import { StsCredentialError, type StsGrant, type UserIdentity } from "../src/lib/sts-credentials.server";

const env = {
  NAS_REGION: "cn-hangzhou", NAS_ACCOUNT_ID: "1234567890123456",
  NAS_FILE_SYSTEM_ID: "examplefs123", NAS_ACCESS_POINT_ID: "ap-example123",
  NAS_AGENTIC_SPACE_ID: "agentic-example123",
};

test("NAS read policy restricts the exact filesystem and access point without write/root permissions", () => {
  const policy = JSON.parse(nasReadPolicy(env));
  assert.deepEqual(policy, { Version: "1", Statement: [{
    Effect: "Allow", Action: ["nas:ClientMount"],
    Resource: ["acs:nas:cn-hangzhou:1234567890123456:filesystem/examplefs123"],
    Condition: { StringEquals: { "nas:AccessPointArn": "acs:nas:cn-hangzhou:1234567890123456:accesspoint/ap-example123" } },
  }] });
  const template = readFileSync(new URL("../deploy/nas/workload-nas-read.json", import.meta.url), "utf8")
    .replaceAll("YOUR_REGION", env.NAS_REGION).replaceAll("YOUR_ACCOUNT_ID", env.NAS_ACCOUNT_ID);
  assert.deepEqual(JSON.parse(template), policy);
});

test("NAS does not infer region/account from OSS, allow wildcard grants or treat space IDs as access points", () => {
  for (const key of ["NAS_REGION", "NAS_ACCOUNT_ID", "NAS_FILE_SYSTEM_ID", "NAS_ACCESS_POINT_ID"] as const) {
    for (const value of ["", "*", "?", "../other", "value\nother", "value:other"]) {
      assert.throws(() => nasAccessConfig({ ...env, [key]: value, OSS_REGION: "oss-cn-hangzhou" }),
        (error: unknown) => error instanceof FileAccessError && error.status === 503 && error.code === "NAS_NOT_CONFIGURED");
    }
  }
  assert.throws(() => nasAccessConfig({ ...env, NAS_ACCESS_POINT_ID: env.NAS_AGENTIC_SPACE_ID }));
  // Space ID and mount paths are not IAM resource selectors and do not broaden grants.
  assert.equal(nasReadPolicy({ ...env, NAS_AGENTIC_SPACE_ID: "", NAS_MOUNT_ROOT: "/different" }), nasReadPolicy(env));
});

test("NAS credentials preserve each existing identity and return broker STS only to the server caller", async () => {
  const credentials = { accessKeyId: "test-id", accessKeySecret: "test-secret", securityToken: "test-token", expiration: "2030-01-01T00:00:00Z" };
  const grants: StsGrant[] = [];
  for (const identity of [{ type: "userId", userId: "app:alice" }, { type: "jwt", userToken: "signed-user-token" }] satisfies UserIdentity[]) {
    const result = await getNasReadCredentials(identity, async (grant) => { grants.push(grant); return credentials; }, env);
    assert.equal(result, credentials);
    assert.deepEqual(grants.at(-1), { identity, policy: nasReadPolicy(env) });
  }
  assert.notDeepEqual(grants[0], grants[1]);
});

test("NAS fails closed on missing user/configuration or broker denial without machine or OSS fallback", async () => {
  let calls = 0;
  const failure = new StsCredentialError(502, "STS_UNAVAILABLE", "unavailable");
  const getSts = async () => { calls++; throw failure; };
  const identity: UserIdentity = { type: "userId", userId: "app:alice" };
  assert.throws(() => getNasReadCredentials({ type: "userId", userId: "" }, getSts, env), /用户身份/);
  assert.throws(() => getNasReadCredentials({ type: "jwt", userToken: "" }, getSts, env), /用户身份/);
  assert.throws(() => getNasReadCredentials(identity, getSts, { ...env, NAS_REGION: "" }), /NAS_REGION/);
  assert.equal(calls, 0);
  await assert.rejects(getNasReadCredentials(identity, getSts, env), (error) => error === failure);
  assert.equal(calls, 1);
});
