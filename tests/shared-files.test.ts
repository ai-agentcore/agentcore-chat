import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactDirectory, assertUserFile, fileAccessMode, userOssPolicy } from "../src/lib/user-scope.server";

test("OSS artifact root is deployment-configured and shared with publishing", (t) => {
  const previous = process.env.AGENTCORE_ARTIFACT_ROOT;
  t.after(() => { if (previous === undefined) delete process.env.AGENTCORE_ARTIFACT_ROOT; else process.env.AGENTCORE_ARTIFACT_ROOT = previous; });
  process.env.AGENTCORE_ARTIFACT_ROOT = "/mnt/oss/data/custom-delivery";
  assert.match(artifactDirectory("alice"), /^\/mnt\/oss\/data\/custom-delivery\/[a-f0-9]{32}$/);
  process.env.AGENTCORE_ARTIFACT_ROOT = "/tmp/outside";
  assert.throws(() => artifactDirectory("alice"), /OSS 文件挂载根/);
  delete process.env.AGENTCORE_ARTIFACT_ROOT;
  assert.throws(() => artifactDirectory("alice"), /AGENTCORE_ARTIFACT_ROOT/);
});

test("shared access is explicit, keeps mount validation and requests only read permissions", (t) => {
  const before = { mode: process.env.FILE_ACCESS_MODE, bucket: process.env.OSS_BUCKET, prefix: process.env.OSS_OBJECT_PREFIX };
  t.after(() => {
    for (const [key, value] of Object.entries({ FILE_ACCESS_MODE: before.mode, OSS_BUCKET: before.bucket, OSS_OBJECT_PREFIX: before.prefix })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  delete process.env.FILE_ACCESS_MODE;
  process.env.OSS_BUCKET = "test-bucket"; process.env.OSS_OBJECT_PREFIX = "agentcore/ppts";
  assert.equal(fileAccessMode(), "user");
  const path = "/mnt/oss/data/大语言模型LLM全景解读.pptx";
  assert.throws(() => assertUserFile("alice", path));
  process.env.FILE_ACCESS_MODE = "shared";
  assert.equal(assertUserFile("alice", path), path);
  assert.equal(assertUserFile("bob", path), path);
  assert.throws(() => assertUserFile("alice", "/mnt/oss/data/../private.txt"));
  assert.throws(() => assertUserFile("alice", "/etc/passwd"));
  const policy = JSON.parse(userOssPolicy("alice"));
  assert.deepEqual(policy.Statement, [{ Effect: "Allow", Action: ["oss:GetObject"], Resource: ["acs:oss:*:*:test-bucket/agentcore/ppts/*"] }]);
  process.env.FILE_ACCESS_MODE = "user";
  assert.throws(() => assertUserFile("alice", path));
  assert.throws(() => assertUserFile("alice", artifactDirectory("bob") + "/private.txt"));
  assert.ok(JSON.parse(userOssPolicy("alice")).Statement[0].Resource[0].includes("/test-artifacts/"));
  process.env.FILE_ACCESS_MODE = "typo";
  assert.throws(fileAccessMode, /配置无效/);
});
