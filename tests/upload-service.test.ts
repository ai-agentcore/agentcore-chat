import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadOssPolicy, safeUploadObjectName, uploadOssPolicy } from "../src/lib/upload-service.server";

test("upload object names are server-controlled while preserving a short safe extension", () => {
  assert.equal(safeUploadObjectName("季度报告.PDF"), "file.pdf");
  assert.equal(safeUploadObjectName("没有扩展名"), "file.bin");
  assert.equal(safeUploadObjectName("bad.verylongextension"), "file.bin");
});

test("download STS policy grants read access to one confirmed object only", () => {
  const policy = JSON.parse(downloadOssPolicy("chat-bucket", "agentcore/files/users/u/c/uploads/up_1/file.png"));
  assert.deepEqual(policy.Statement, [{
    Effect: "Allow",
    Action: ["oss:GetObject"],
    Resource: ["acs:oss:*:*:chat-bucket/agentcore/files/users/u/c/uploads/up_1/file.png"],
  }]);
});

test("upload STS policy grants one exact object only", () => {
  const policy = JSON.parse(uploadOssPolicy("chat-bucket", "agentcore/files/users/u/c/uploads/up_1/file.png"));
  assert.deepEqual(policy.Statement, [{
    Effect: "Allow",
    Action: ["oss:PutObject", "oss:GetObject"],
    Resource: ["acs:oss:*:*:chat-bucket/agentcore/files/users/u/c/uploads/up_1/file.png"],
  }]);
});
