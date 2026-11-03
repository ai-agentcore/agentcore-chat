import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mountNasForUser, nasMountConfig } from "../src/lib/nas-mount.server";
import { FileAccessError } from "../src/lib/files";

const env = { NAS_REGION: "cn-hangzhou", NAS_ACCOUNT_ID: "1234567890123456", NAS_FILE_SYSTEM_ID: "examplefs123",
  NAS_ACCESS_POINT_ID: "ap-example123", NAS_ACCESS_POINT_DOMAIN: "ap-example123.examplefs123-example.cn-hangzhou.nas.aliyuncs.com", NAS_ACCESS_POINT_PATH: "/" };
async function configure(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "nas-mount-test-"));
  const values = { ...env, NAS_MOUNT_BASE: base };
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(async () => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(base, { recursive: true, force: true }); });
  return base;
}
const identity = { type: "userId", userId: "app:alice" } as const;
const credentials = { accessKeyId: "test-id", accessKeySecret: "test-secret", securityToken: "test-token", expiration: "2030-01-01T00:00:00Z" };

test("NAS sends the original user's STS to a private credential file used by a read-only mount and cleans up", async (t) => {
  const base = await configure(t);
  const calls: { command: string; args: string[] }[] = [];
  const mount = await mountNasForUser(identity, { platform: "linux", getCredentials: async (user) => {
    assert.deepEqual(user, identity); return credentials;
  }, run: async (command, args) => {
    calls.push({ command, args });
    assert.doesNotMatch(args.join(" "), /test-secret|test-token/);
    if (command === "/bin/mount") {
      assert.equal(args[1], "alinas");
      const options = args[3];
      assert.match(options, /tls,vers=3,ram,ro,nosuid,nodev,noexec,nosharecache,/);
      const file = options.split("ram_config_file=")[1];
      assert.equal((await lstat(file)).mode & 0o777, 0o600);
      assert.equal((await lstat(join(file, ".."))).mode & 0o777, 0o700);
      assert.equal(await readFile(file, "utf8"), "[NASCredentials]\naccessKeyID = test-id\naccessKeySecret = test-secret\nsecurityToken = test-token\n");
      assert.equal(args[4], `${env.NAS_ACCESS_POINT_DOMAIN}:/`);
    }
  } });
  assert.ok(mount.root.startsWith(base));
  await mount.close(); await mount.close();
  assert.deepEqual(calls.map((call) => call.command), ["/bin/mount", "/bin/umount"]);
  assert.deepEqual(await readdir(base), []);
});

test("mount failures are sanitized, remove STS files and never fall back to an existing mount", async (t) => {
  const base = await configure(t);
  await assert.rejects(mountNasForUser(identity, { platform: "linux", getCredentials: async () => credentials,
    run: async (command) => { if (command === "/bin/mount") throw new Error("SECRET_DETAILS"); } }),
  (error) => error instanceof FileAccessError && error.code === "NAS_MOUNT_FAILED" && !error.message.includes("SECRET_DETAILS"));
  assert.deepEqual(await readdir(base), []);
});

test("missing credentials and unsupported hosts fail before any mount; domains and paths are fixed server configuration", async (t) => {
  const base = await configure(t);
  let calls = 0;
  const run = async () => { calls++; };
  await assert.rejects(mountNasForUser(identity, { platform: "darwin", run }), /Linux/);
  await assert.rejects(mountNasForUser(identity, { platform: "linux", run, getCredentials: async () => { throw new Error("denied"); } }), /denied/);
  await assert.rejects(mountNasForUser(identity, { platform: "linux", run, getCredentials: async () => ({ ...credentials, securityToken: "token\naccessKeyID=evil" }) }), /凭证格式/);
  assert.equal(calls, 0); assert.deepEqual(await readdir(base), []);
  for (const domain of ["evil.example", `${env.NAS_ACCESS_POINT_DOMAIN}.evil.example`, `https://${env.NAS_ACCESS_POINT_DOMAIN}`, "ap-other.examplefs123-example.cn-hangzhou.nas.aliyuncs.com"]) {
    assert.throws(() => nasMountConfig({ ...env, NAS_ACCESS_POINT_DOMAIN: domain }));
  }
  for (const path of ["/../secret", "/shared,write", "relative", "/shared//nested"]) assert.throws(() => nasMountConfig({ ...env, NAS_ACCESS_POINT_PATH: path }));
  assert.equal(nasMountConfig({ ...env, NAS_ACCESS_POINT_PATH: "/shared" }).remotePath, "/shared");
});
