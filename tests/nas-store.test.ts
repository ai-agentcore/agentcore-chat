import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNasFileStore } from "../src/lib/nas-store.server";
import { getFileContent, getFileMetadata } from "../src/lib/file-service.server";
import { FileAccessError } from "../src/lib/files";
import { artifactDirectory, assertUserFile, sessionArtifactDirectory, upstreamThreadId, userNamespace } from "../src/lib/user-scope.server";
import { prepareArtifactContent } from "../src/lib/artifact-content";

async function fixture(t: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), "nas-store-test-"));
  const root = join(parent, "space");
  await mkdir(root);
  await writeFile(join(root, "报告.pdf"), "0123456789");
  await writeFile(join(root, "empty.txt"), "");
  t.after(() => rm(parent, { recursive: true, force: true }));
  let acquired = 0;
  let closed = 0;
  const store = () => createNasFileStore({ type: "userId", userId: "app:alice" }, async () => {
    acquired++; return { root, async close() { closed++; } };
  });
  const previous = { FILE_STORAGE_BACKEND: process.env.FILE_STORAGE_BACKEND, FILE_ACCESS_MODE: process.env.FILE_ACCESS_MODE };
  process.env.FILE_STORAGE_BACKEND = "nas"; process.env.FILE_ACCESS_MODE = "shared";
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  return { root, parent, store, counts: () => ({ acquired, closed }) };
}
const request = (file = "报告.pdf", init?: RequestInit) => new Request(`http://localhost/api/files/content?${new URLSearchParams({ path: `/mnt/agenticfs/shared/${file}` })}`, init);

test("NAS metadata, HEAD and ranged/full downloads use a relative key and release each mount", async (t) => {
  const f = await fixture(t);
  const data = await (await getFileMetadata(request(), f.store)).json();
  assert.equal(data.path, "/mnt/agenticfs/shared/报告.pdf"); assert.equal(data.size, 10);
  assert.equal(data.kind, "pdf"); assert.equal(data.previewable, true);
  assert.equal((await getFileContent(request(undefined, { method: "HEAD" }), f.store)).headers.get("Content-Length"), "10");
  for (const [range, text, contentRange] of [["bytes=2-4", "234", "bytes 2-4/10"], ["bytes=8-99", "89", "bytes 8-9/10"], ["bytes=-3", "789", "bytes 7-9/10"], ["bytes=7-", "789", "bytes 7-9/10"], ["", "0123456789", null]] as const) {
    const response = await getFileContent(request(undefined, { headers: { range } }), f.store);
    assert.equal(response.status, range ? 206 : 200);
    assert.equal(response.headers.get("Content-Range"), contentRange);
    assert.equal(response.headers.get("Content-Length"), String(text.length));
    assert.equal(await response.text(), text);
    assert.deepEqual(f.counts(), { acquired: f.counts().acquired, closed: f.counts().acquired });
  }
  const empty = await getFileContent(request("empty.txt"), f.store);
  assert.equal(empty.status, 200); assert.equal(await empty.text(), "");
  assert.equal(f.counts().closed, 8);
});

test("NAS closes mounts after range/missing-file errors and response cancellation", async (t) => {
  const f = await fixture(t);
  assert.equal((await getFileContent(request(undefined, { headers: { range: "bytes=10-" } }), f.store)).status, 416);
  assert.equal((await getFileMetadata(request("missing.pdf"), f.store)).status, 404);
  await writeFile(join(f.root, "large.pdf"), Buffer.alloc(3 * 1024 * 1024, 65));
  const response = await getFileContent(request("large.pdf"), f.store);
  await response.body!.cancel();
  assert.deepEqual(f.counts(), { acquired: 3, closed: 3 });
});

test("NAS denies symlinks, directories and traversal without exposing files outside the shared mount", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.parent, "secret.txt"), "SECRET_OUTSIDE_SPACE");
  await symlink(join(f.parent, "secret.txt"), join(f.root, "linked.txt"));
  await symlink(f.parent, join(f.root, "linked-directory"));
  await mkdir(join(f.root, "directory"));
  for (const file of ["linked.txt", "linked-directory/secret.txt"]) {
    const response = await getFileContent(request(file), f.store);
    assert.equal(response.status, 403); assert.doesNotMatch(await response.text(), /SECRET_OUTSIDE_SPACE/);
  }
  assert.equal((await getFileMetadata(request("directory"), f.store)).status, 400);
  const count = f.counts().acquired;
  for (const file of ["../secret.txt", "%2e%2e/secret.txt", "a%2fb", "a//b", "a\\b"]) {
    assert.equal((await getFileMetadata(request(file), f.store)).status, 400);
  }
  assert.equal(f.counts().acquired, count);
});

test("NAS detects updates between metadata and read; abort does not acquire a mount", async (t) => {
  const f = await fixture(t);
  const store = f.store();
  t.after(() => store.close!());
  const old = await store.stat("报告.pdf");
  await writeFile(join(f.root, "报告.pdf"), "changed-and-longer");
  await assert.rejects(store.read("报告.pdf", { etag: old.etag, signal: new AbortController().signal }),
    (error) => error instanceof FileAccessError && error.code === "FILE_CHANGED");
  const untouched = f.store();
  await assert.rejects(untouched.read("报告.pdf", { signal: AbortSignal.abort() }));
  await untouched.close!();
  assert.equal(f.counts().acquired, 1);
});

test("NAS shared access keeps the exact new root and never reinterprets old OSS references", async (t) => {
  const f = await fixture(t);
  assert.equal(artifactDirectory("alice"), "/mnt/agenticfs/shared");
  assert.equal(
    sessionArtifactDirectory("alice", upstreamThreadId("alice", "thread-1")),
    `/mnt/agenticfs/shared/${userNamespace("alice")}/${upstreamThreadId("alice", "thread-1")}`,
  );
  for (const user of ["alice", "bob"]) assert.equal(assertUserFile(user, "/mnt/agenticfs/shared/报告.pdf"), "/mnt/agenticfs/shared/报告.pdf");
  assert.throws(() => assertUserFile("alice", "/mnt/agenticfs/shared/报告.pdf", "user"));
  assert.throws(() => assertUserFile("alice", "/mnt/agenticfs/shared-other/报告.pdf"));
  assert.throws(() => assertUserFile("alice", "/mnt/oss/data/报告.pdf"), /旧文件/);
  const old = await getFileMetadata(new Request("http://localhost/api/files?path=/mnt/oss/data/report.pdf"), f.store);
  assert.equal(old.status, 409); assert.equal(f.counts().acquired, 0);
  process.env.FILE_ACCESS_MODE = "user";
  assert.throws(() => assertUserFile("alice", "/mnt/agenticfs/shared/报告.pdf"));
  assert.throws(() => assertUserFile("alice", `${artifactDirectory("bob")}/report.pdf`));
  assert.equal(assertUserFile("alice", `${artifactDirectory("alice")}/report.pdf`), `${artifactDirectory("alice")}/report.pdf`);
});

test("NAS paths render as authenticated artifacts in every supported delivery format", () => {
  const path = "/mnt/agenticfs/shared/图表 (新版).png";
  for (const content of [`![图片](<${path}>)`, `[图片](<sandbox:${path}>)`, `\`${path}\``, path, `\`\`\`text\n${path}\n\`\`\``, `<FileCard path="${path}" />`]) {
    assert.ok(prepareArtifactContent(content).includes(`filePath="${encodeURIComponent(path)}"`), content);
  }
  assert.equal(prepareArtifactContent(`![图片](<${path}`, true), "");
  assert.doesNotMatch(prepareArtifactContent("[bad](/mnt/agenticfs/shared/../private.png)"), /AgentFileArtifact/);
  assert.equal(prepareArtifactContent('```bash\ncat /mnt/agenticfs/shared/a.txt\n```'), '```bash\ncat /mnt/agenticfs/shared/a.txt\n```');
});

test("a failed mount acquisition can be closed without another error or acquisition", async () => {
  let calls = 0;
  const store = createNasFileStore({ type: "userId", userId: "app:alice" }, async () => {
    calls++;
    throw new FileAccessError(503, "NAS_REQUIRES_LINUX", "requires Linux");
  });
  await assert.rejects(store.stat("report.txt"), /requires Linux/);
  await store.close!();
  await store.close!();
  assert.equal(calls, 1);
});
