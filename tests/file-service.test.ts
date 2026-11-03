import assert from "node:assert/strict";
import { test } from "node:test";
import { getFileContent, getFileMetadata } from "../src/lib/file-service.server";
import type { FileStore } from "../src/lib/oss-store.server";
import { MAX_PREVIEW_BYTES } from "../src/lib/files";
import { wordFixture } from "./e2e/word-fixture";

const request = (path = "/mnt/oss/data/demo.pdf", download = false, init?: RequestInit) => new Request(`http://localhost/api/files/content?${new URLSearchParams({ path, ...(download ? { download: "1" } : {}) })}`, init);

function store(overrides: Partial<FileStore> = {}): FileStore {
  return { stat: async () => ({ size: 4, etag: '"v1"' }), read: async () => ({ body: new Response("test").body!, length: 4, status: 200 }), ...overrides };
}

test("metadata maps the key, exposes only preview information and never OSS credentials/URLs", async () => {
  const response = await getFileMetadata(request(), () => store({ stat: async (key) => { assert.equal(key, "agentcore/ppts/demo.pdf"); return { size: 4 }; } }));
  const data = await response.json();
  assert.equal(data.previewable, true);
  assert.equal(data.kind, "pdf");
  assert.equal(data.path, "/mnt/oss/data/demo.pdf");
  assert.equal(data.key, undefined);
  assert.equal(data.bucket, undefined);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("out-of-root and cross-site reads are rejected before creating an OSS client", async () => {
  let calls = 0;
  const factory = () => { calls++; return store(); };
  assert.equal((await getFileMetadata(request("/etc/passwd"), factory)).status, 400);
  assert.equal((await getFileContent(request("/mnt/oss/data/x.pdf", false, { headers: { "sec-fetch-site": "cross-site" } }), factory)).status, 403);
  assert.equal(calls, 0);
});

test("file proxy forwards valid ranges and streams the response with safe disposition", async () => {
  const response = await getFileContent(request("/mnt/oss/data/报告.pdf", false, { headers: { Range: "bytes=1-2" } }), () => store({ read: async (key, options) => {
    assert.equal(key, "agentcore/ppts/报告.pdf"); assert.equal(options.range, "bytes=1-2"); assert.equal(options.etag, '"v1"');
    return { body: new Response("es").body!, length: 2, contentRange: "bytes 1-2/4", status: 206 };
  } }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Content-Range"), "bytes 1-2/4");
  assert.match(response.headers.get("Content-Disposition")!, /filename\*=UTF-8''%E6/);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(await response.text(), "es");
});

test("large or unsupported files remain downloadable without loading their contents for preview", async () => {
  let reads = 0;
  const factory = () => store({ stat: async () => ({ size: MAX_PREVIEW_BYTES + 1 }), read: async () => { reads++; return { body: new Response("download").body!, status: 200 }; } });
  assert.equal((await (await getFileMetadata(request(), factory)).json()).previewable, false);
  assert.equal((await getFileContent(request(), factory)).status, 413);
  assert.equal(reads, 0);
  const download = await getFileContent(request("/mnt/oss/data/deck.ppt", true), factory);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("Content-Disposition")!, /^attachment/);
  await download.text();
  assert.equal(reads, 1);
});

test("MP4 files remain streamable above the buffered preview limit and forward byte ranges", async () => {
  const size = MAX_PREVIEW_BYTES + 1024;
  const factory = () => store({
    stat: async () => ({ size, etag: '"video-v1"' }),
    read: async (key, options) => {
      assert.equal(key, "agentcore/ppts/demo.mp4");
      assert.equal(options.range, "bytes=0-1023");
      return { body: new Response(new Uint8Array(1024)).body!, length: 1024, contentRange: `bytes 0-1023/${size}`, status: 206 };
    },
  });
  const metadata = await (await getFileMetadata(request("/mnt/oss/data/demo.mp4"), factory)).json();
  assert.equal(metadata.kind, "video");
  assert.equal(metadata.contentType, "video/mp4");
  assert.equal(metadata.previewable, true);
  const response = await getFileContent(request("/mnt/oss/data/demo.mp4", false, { headers: { Range: "bytes=0-1023" } }), factory);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Content-Type"), "video/mp4");
  assert.equal(response.headers.get("Accept-Ranges"), "bytes");
  assert.equal(response.headers.get("Content-Range"), `bytes 0-1023/${size}`);
  await response.body!.cancel();
});

test("HEAD returns metadata without opening a stream; malformed ranges are rejected", async () => {
  let reads = 0;
  const factory = () => store({ read: async () => { reads++; throw new Error("must not read"); } });
  assert.equal((await getFileContent(request(undefined, false, { method: "HEAD" }), factory)).status, 200);
  for (const range of ["bytes=10-20", "bytes=3-1", "bytes=-0", "bytes=0-1,2-3", "garbage"]) assert.equal((await getFileContent(request(undefined, false, { headers: { Range: range } }), factory)).status, 416);
  assert.equal(reads, 0);
});

test("upstream errors are mapped without leaking internal details", async () => {
  const factory = (status: number) => () => store({ stat: async () => { throw { status, message: "SECRET_ACCESS_KEY" }; } });
  assert.equal((await getFileMetadata(request(), factory(404))).status, 404);
  const denied = await getFileMetadata(request(), factory(403));
  assert.equal(denied.status, 403);
  assert.doesNotMatch(await denied.text(), /SECRET_ACCESS_KEY/);
  assert.equal((await getFileContent(request(), factory(412))).status, 409);
});

test("cancelling the downstream body cancels the upstream stream", async () => {
  let cancelled = false;
  const response = await getFileContent(request(), () => store({ read: async () => ({ body: new ReadableStream({ cancel() { cancelled = true; } }), status: 200 }) }));
  await response.body!.cancel();
  assert.equal(cancelled, true);
});

test("Word preview and download preserve original DOCX bytes and use the Word MIME type", async () => {
  const file = await wordFixture();
  const factory = () => store({ stat: async () => ({ size: file.length }), read: async () => ({ body: new Response(new Uint8Array(file)).body!, length: file.length, status: 200 }) });
  const path = "/mnt/oss/data/交付报告.docx";
  const metadata = await (await getFileMetadata(request(path), factory)).json();
  assert.equal(metadata.kind, "docx");
  assert.equal(metadata.previewable, true);
  for (const download of [false, true]) {
    const response = await getFileContent(request(path, download), factory);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.match(response.headers.get("Content-Disposition")!, download ? /^attachment/ : /^inline/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), file);
  }
});
