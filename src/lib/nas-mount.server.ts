import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { promisify } from "node:util";
import { FileAccessError } from "./files";
import { getNasReadCredentials, nasAccessConfig } from "./nas-access.server";
import type { UserIdentity } from "./sts-credentials.server";

export interface NasMount { root: string; close(): Promise<void>; }
const exec = promisify(execFile);
let activeMounts = 0;
const MAX_MOUNTS = 16;

export function nasMountConfig(env: Readonly<Record<string, string | undefined>> = process.env) {
  const access = nasAccessConfig(env);
  const domain = env.NAS_ACCESS_POINT_DOMAIN?.trim() || "";
  // Never derive a DNS name from IDs, or let a request select a mount server.
  const suffix = `.${access.region}.nas.aliyuncs.com`;
  const agenticSuffix = `.${access.region}.agenticfs.aliyuncs.com`;
  if (!/^[a-z0-9.-]+$/.test(domain) || !domain.startsWith(`${access.accessPointId}.${access.fileSystemId}-`)
    || !(domain.endsWith(suffix) || domain.endsWith(agenticSuffix))) {
    throw new FileAccessError(503, "NAS_NOT_CONFIGURED", "请配置与 NAS 资源一致的 NAS_ACCESS_POINT_DOMAIN。");
  }
  const remotePath = env.NAS_ACCESS_POINT_PATH?.trim() || "/";
  const mountBase = env.NAS_MOUNT_BASE?.trim() || "/tmp/agentcore-nas";
  for (const value of [remotePath, mountBase]) {
    if (!/^\/[a-zA-Z0-9/_-]*$/.test(value) || posix.normalize(value) !== value || value.includes("//")) {
      throw new FileAccessError(503, "NAS_NOT_CONFIGURED", "NAS 挂载路径配置无效。");
    }
  }
  if (mountBase === "/") throw new FileAccessError(503, "NAS_NOT_CONFIGURED", "NAS_MOUNT_BASE 不能是根目录。");
  return { domain, remotePath, mountBase };
}

async function run(command: string, args: string[]) {
  await exec(command, args, { timeout: 30_000, maxBuffer: 64 * 1024,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", NODE_ENV: process.env.NODE_ENV || "production" } });
}

/** Per-request read-only mount: the original user's scoped STS reaches NAS itself. */
export async function mountNasForUser(identity: UserIdentity, dependencies: {
  platform?: string;
  getCredentials?: typeof getNasReadCredentials;
  run?: typeof run;
} = {}): Promise<NasMount> {
  if ((dependencies.platform || process.platform) !== "linux") throw new FileAccessError(503, "NAS_REQUIRES_LINUX", "NAS 文件读取需要部署到同 VPC 的 Linux 服务。");
  const execute = dependencies.run || run;
  const config = nasMountConfig();
  if (activeMounts >= MAX_MOUNTS) throw new FileAccessError(503, "NAS_BUSY", "文件服务繁忙，请稍后重试。");
  activeMounts++;
  let directory: string | undefined;
  let mountAttempted = false;
  let closing: Promise<void> | undefined;
  const close = () => closing ||= (async () => {
    try {
      if (directory) {
        if (mountAttempted) {
          try { await execute("/bin/umount", ["--", `${directory}/data`]); }
          catch { console.warn("NAS temporary mount cleanup failed; inspect NAS_MOUNT_BASE on the server."); }
        }
        // Never recursively delete a mount: failed unmounts must not remove NAS data.
        await rm(`${directory}/credentials`, { force: true });
        await rmdir(`${directory}/data`).catch(() => {});
        await rmdir(directory).catch(() => {});
      }
    } finally { activeMounts--; }
  })();
  try {
    const credentials = await (dependencies.getCredentials || getNasReadCredentials)(identity);
    if ([credentials.accessKeyId, credentials.accessKeySecret, credentials.securityToken].some((value) => /[\r\n\u0000]/.test(value))) {
      throw new FileAccessError(502, "NAS_CREDENTIALS_UNAVAILABLE", "NAS 临时凭证格式无效。");
    }
    await mkdir(config.mountBase, { recursive: true, mode: 0o700 });
    const base = await lstat(config.mountBase);
    if (!base.isDirectory() || base.isSymbolicLink() || base.uid !== process.getuid!() || (base.mode & 0o077)) {
      throw new FileAccessError(503, "NAS_NOT_CONFIGURED", "NAS_MOUNT_BASE 必须是文件服务独占、权限为 0700 的目录。");
    }
    directory = await mkdtemp(`${config.mountBase}/read-`);
    await mkdir(`${directory}/data`, { mode: 0o700 });
    await writeFile(`${directory}/credentials`, `[NASCredentials]\naccessKeyID = ${credentials.accessKeyId}\naccessKeySecret = ${credentials.accessKeySecret}\nsecurityToken = ${credentials.securityToken}\n`, { mode: 0o600, flag: "wx" });
    mountAttempted = true;
    try {
      await execute("/bin/mount", ["-t", "alinas", "-o",
        `tls,vers=3,ram,ro,nosuid,nodev,noexec,nosharecache,ram_config_file=${directory}/credentials`,
        `${config.domain}:${config.remotePath}`, `${directory}/data`]);
    } catch {
      throw new FileAccessError(503, "NAS_MOUNT_FAILED", "NAS 只读挂载失败，请检查客户端、挂载权限、接入点 RAM 授权及 VPC 网络。");
    }
    return { root: `${directory}/data`, close };
  } catch (error) { await close(); throw error; }
}
