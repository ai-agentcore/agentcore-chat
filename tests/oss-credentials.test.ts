import assert from "node:assert/strict";
import { test } from "node:test";
import { credentialProvider } from "../src/lib/oss-credentials.server";
import { StsCredentialError } from "../src/lib/sts-credentials.server";
import { FileAccessError } from "../src/lib/files";
const credentials = () => ({
  accessKeyId: "STS.test-only",
  accessKeySecret: "test-only-secret",
  securityToken: "test-only-token",
  expiration: new Date(Date.now() + 900_000).toISOString(),
});

test("the main application's OSS adapter maps generic STS into ali-oss credentials", async () => {
  const get = credentialProvider(async () => credentials());
  assert.deepEqual(await get(), { accessKeyId: "STS.test-only", accessKeySecret: "test-only-secret", stsToken: "test-only-token" });
});

test("OSS preserves file API errors when the broker fails", async () => {
  for (const [failure, status, code] of [
    [new StsCredentialError(503, "STS_NOT_CONFIGURED", "private configuration"), 503, "OSS_NOT_CONFIGURED"],
    [new StsCredentialError(502, "STS_UNAVAILABLE", "private exchange error"), 502, "OSS_CREDENTIALS_UNAVAILABLE"],
    [new Error("private upstream secret"), 502, "OSS_CREDENTIALS_UNAVAILABLE"],
  ] as const) {
    const get = credentialProvider(async () => { throw failure; });
    await assert.rejects(get(), (error: unknown) => {
      assert.ok(error instanceof FileAccessError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
  }
});
