import assert from "node:assert/strict";
import { test } from "node:test";
import { symmetricEncrypt } from "better-auth/crypto";
import { SignJWT } from "jose";
import { aliyunProfileFromClaims } from "../src/lib/user-profile";
import { readStoredAliyunProfile } from "../src/lib/user-profile.server";

test("cloud profile projects only display fields and distinguishes login names from email", () => {
  assert.deepEqual(aliyunProfileFromClaims({ name: " 显示名 ", login_name: "owner@example.test", type: "Account", email: "other@example.test", sub: "private-subject", access_token: "private-token" }), {
    displayName: "显示名", loginName: "owner@example.test", accountType: "account",
  });
  assert.deepEqual(aliyunProfileFromClaims({ upn: "ram-user@tenant.onaliyun.com", type: "user" }), {
    displayName: "ram-user@tenant.onaliyun.com", loginName: "ram-user@tenant.onaliyun.com", accountType: "user",
  });
  assert.deepEqual(aliyunProfileFromClaims({ name: {}, login_name: 123, upn: " ", type: "admin" }), {
    displayName: "阿里云用户", loginName: null, accountType: null,
  });
});

test("saved profile requires matching encrypted cloud identity, but expiry does not erase display metadata", async () => {
  const secret = "profile-test-secret-with-at-least-32-characters";
  // Simulate encrypted storage after callback verification, not a new login.
  const token = await new SignJWT({ name: "角色显示名", type: "role" })
    .setProtectedHeader({ alg: "HS256" }).setIssuer("https://oauth.aliyun.com")
    .setSubject("test-cloud-subject").setExpirationTime(1)
    .sign(new TextEncoder().encode(secret));
  const account = { accountId: "test-cloud-subject", identityToken: await symmetricEncrypt({ key: secret, data: token }) };
  assert.deepEqual(await readStoredAliyunProfile(account, secret), { displayName: "角色显示名", loginName: null, accountType: "role" });
  assert.equal(await readStoredAliyunProfile({ ...account, accountId: "another-user" }, secret), null);
  assert.equal(await readStoredAliyunProfile(account, "incorrect-secret"), null);
  assert.equal(await readStoredAliyunProfile({ accountId: account.accountId }, secret), null);
});
