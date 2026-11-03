import assert from "node:assert/strict";
import test from "node:test";
import {
  sessionUploadDirectory,
  sessionUploadObjectKey,
  sessionUploadObjectPrefix,
  upstreamThreadId,
  userNamespace,
} from "../src/lib/user-scope.server";

test("chat and runloop share one per-session upload layout across OSS and NAS", () => {
  const before = { ...process.env };
  test.after(() => { process.env = before; });
  process.env.OSS_OBJECT_PREFIX = "agentcore/files";
  const conversationId = upstreamThreadId("alice", "thread-1");
  const uid = userNamespace("alice");

  process.env.FILE_STORAGE_BACKEND = "oss";
  process.env.AGENTCORE_ARTIFACT_ROOT = "/mnt/oss/data/users";
  assert.equal(sessionUploadDirectory("alice", conversationId), `/mnt/oss/data/users/${uid}/${conversationId}/uploads`);
  assert.equal(sessionUploadObjectPrefix("alice", conversationId), `agentcore/files/users/${uid}/${conversationId}/uploads/`);

  process.env.FILE_STORAGE_BACKEND = "nas";
  assert.equal(sessionUploadDirectory("alice", conversationId), `/mnt/agenticfs/shared/${uid}/${conversationId}/uploads`);
  assert.equal(
    sessionUploadObjectKey("alice", conversationId, "up_abc123", "photo.png"),
    `agentcore/files/users/${uid}/${conversationId}/uploads/up_abc123/photo.png`,
  );
});

test("upload keys reject caller-controlled traversal and separators", () => {
  for (const [uploadId, name] of [["../bob", "a.png"], ["up_1", "../a.png"], ["up/1", "a.png"], ["up_1", "a b.png"]]) {
    assert.throws(() => sessionUploadObjectKey("alice", "conversation-1", uploadId, name), /上传文件路径/);
  }
});
