import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { uploadAttachment } from "../src/lib/upload-client";

afterEach(() => mock.restoreAll());

test("browser uploads bytes directly to the signed OSS URL and confirms the immutable reference", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "/api/uploads" && JSON.parse(String(init?.body)).action === "create") {
      return Response.json({
        uploadId: "up_abc", objectName: "file.png", uploadUrl: "https://chat-bucket.oss-cn-hangzhou.aliyuncs.com/signed",
        headers: { "Content-Type": "image/png" },
      });
    }
    if (url.startsWith("https://chat-bucket.")) return new Response(null, { status: 200 });
    return Response.json({
      id: "up_abc", name: "photo.png", mimeType: "image/png", size: 3,
      uri: "oss://chat-bucket/agentcore/files/users/u/c/uploads/up_abc/file.png",
      etag: '"etag-1"', region: "oss-cn-hangzhou",
    });
  });

  const result = await uploadAttachment("thread-1", new File(["png"], "photo.png", { type: "image/png" }), "user-1");
  assert.equal(result.etag, '"etag-1"');
  assert.equal(calls.length, 3);
  assert.equal(calls[1].init?.method, "PUT");
  assert.equal(calls[1].init?.body instanceof File, true);
  assert.deepEqual(calls[1].init?.headers, { "Content-Type": "image/png" });
  assert.equal(JSON.parse(String(calls[2].init?.body)).action, "confirm");
  assert.equal(new Headers(calls[0].init?.headers).get("X-Account-ID"), "user-1");
});
