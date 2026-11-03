import assert from "node:assert/strict";
import test from "node:test";
import type { FileStore } from "../src/lib/file-store";
import { conversationManifestObjectKey, findFileReference } from "../src/lib/file-references.server";
import { fileApiUrl, normalizeFileReference } from "../src/lib/files";
import { upstreamThreadId, userNamespace } from "../src/lib/user-scope.server";

const id = "f_abcdefghijklmnopqrstuv";

function objectStore(objects: Map<string, string>): FileStore {
  const missing = () => Object.assign(new Error("missing"), { status: 404, code: "NoSuchKey" });
  return {
    async stat(key) {
      const value = objects.get(key);
      if (value === undefined) throw missing();
      return { size: Buffer.byteLength(value), etag: "reference-etag" };
    },
    async read(key) {
      const value = objects.get(key);
      if (value === undefined) throw missing();
      const bytes = new TextEncoder().encode(value);
      return { status: 200, length: bytes.byteLength, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
    },
  };
}

test("opaque file references resolve from the current user's OSS manifest", async (t) => {
  const before = { root: process.env.AGENTCORE_ARTIFACT_ROOT, prefix: process.env.OSS_OBJECT_PREFIX };
  t.after(() => {
    if (before.root === undefined) delete process.env.AGENTCORE_ARTIFACT_ROOT; else process.env.AGENTCORE_ARTIFACT_ROOT = before.root;
    if (before.prefix === undefined) delete process.env.OSS_OBJECT_PREFIX; else process.env.OSS_OBJECT_PREFIX = before.prefix;
  });
  process.env.AGENTCORE_ARTIFACT_ROOT = "/mnt/oss/data/users";
  process.env.OSS_OBJECT_PREFIX = "agentcore/files";
  const conversationId = "conversation-1";
  const upstream = upstreamThreadId("alice", conversationId);
  const key = conversationManifestObjectKey("alice", conversationId)!;
  const manifest = JSON.stringify({
    version: 1,
    conversationId: upstream,
    files: { [id]: { path: "季度总结.pptx", name: "季度总结.pptx", size: 231_000, createdAt: "2026-09-22T12:00:00.000Z" } },
  });
  const store = objectStore(new Map([[key, manifest]]));

  assert.equal(key, `agentcore/files/users/${userNamespace("alice")}/${upstream}/.files.json`);
  const reference = await findFileReference("alice", conversationId, id, store, new AbortController().signal);
  assert.deepEqual(reference, {
    id,
    path: `/mnt/oss/data/users/${userNamespace("alice")}/${upstream}/季度总结.pptx`,
    name: "季度总结.pptx",
  });
  assert.equal(await findFileReference("bob", conversationId, id, store, new AbortController().signal), undefined);
  assert.equal(await findFileReference("alice", "another-conversation", id, store, new AbortController().signal), undefined);
  assert.equal(normalizeFileReference(`/f/${id}`), `/f/${id}`);
  assert.equal(fileApiUrl(`/f/${id}`, "metadata", conversationId), `/api/files/ref/${id}?conversationId=conversation-1`);
  assert.equal(fileApiUrl(`/f/${id}`, "download", conversationId), `/api/files/ref/${id}/content?conversationId=conversation-1&download=1`);
});

test("invalid or unsafe OSS reference manifests are rejected", async (t) => {
  const before = { root: process.env.AGENTCORE_ARTIFACT_ROOT, prefix: process.env.OSS_OBJECT_PREFIX };
  t.after(() => {
    if (before.root === undefined) delete process.env.AGENTCORE_ARTIFACT_ROOT; else process.env.AGENTCORE_ARTIFACT_ROOT = before.root;
    if (before.prefix === undefined) delete process.env.OSS_OBJECT_PREFIX; else process.env.OSS_OBJECT_PREFIX = before.prefix;
  });
  process.env.AGENTCORE_ARTIFACT_ROOT = "/mnt/oss/data/users";
  process.env.OSS_OBJECT_PREFIX = "agentcore/files";
  const conversationId = "conversation-1";
  const upstream = upstreamThreadId("alice", conversationId);
  const key = conversationManifestObjectKey("alice", conversationId)!;
  const unsafe = JSON.stringify({ version: 1, conversationId: upstream, files: { [id]: { path: "../secret.txt", name: "secret.txt", size: 1, createdAt: "2026-09-22T12:00:00.000Z" } } });
  assert.equal(await findFileReference("alice", conversationId, id, objectStore(new Map([[key, unsafe]])), new AbortController().signal), undefined);
  assert.equal(await findFileReference("alice", conversationId, "not-an-id", objectStore(new Map()), new AbortController().signal), undefined);
});
