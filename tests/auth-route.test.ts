import assert from "node:assert/strict";
import { test } from "node:test";
import { GET, POST } from "../src/app/api/auth/[...all]/route";
const request = (path: string, body: unknown) => new Request(`http://localhost:3000/api/auth/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("auth HTTP boundary rejects reserved identities, malformed bodies and direct ID-token login", async () => {
  for (const body of [null, [], true, { name: " ", email: "a@test.example" }, { name: "Cloud", email: "test@aliyun.invalid " }]) {
    assert.equal((await POST(request("sign-up/email", body))).status, 400);
  }
  assert.equal((await POST(request("sign-in/social", { provider: "aliyun", idToken: { token: "untrusted" } }))).status, 400);
  assert.equal((await POST(request("sign-in/social", { provider: "unknown" }))).status, 400);
  assert.equal((await POST(request("sign-up/email", { name: "x".repeat(17000) }))).status, 413);
});

test("OAuth tokens and account linking are not exposed by the auth router", async () => {
  for (const path of ["get-access-token", "refresh-token", "link-social", "list-accounts", "update-user"]) {
    assert.equal((await GET(new Request(`http://localhost:3000/api/auth/${path}`))).status, 404);
    assert.equal((await POST(request(path, {}))).status, 404);
  }
});
