import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

class SetupError extends Error {}
try { process.loadEnvFile(".env.local"); } catch (error) { if (error.code !== "ENOENT") throw new SetupError("无法加载 .env.local。"); }

async function main() {
  if (process.argv.slice(2).some(arg => arg !== "--rotate")) throw new SetupError("用法：npm run identity:init [-- --rotate]");
  const rotate = process.argv.includes("--rotate");
  const file = path.resolve(process.env.APP_IDENTITY_KEY_FILE || "data/identity/keyring.private.json");
  for (const folder of ["public", "src", ".next"]) {
    const root = path.resolve(folder);
    if (file === root || file.startsWith(root + path.sep)) throw new SetupError("私钥必须放在服务端持久目录，不能放入 public、src 或构建目录。");
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockPath = `${file}.lock`;
  const lock = await open(lockPath, "wx", 0o600).catch(() => { throw new SetupError("密钥操作锁已存在，请确认没有其他初始化或轮换进程。"); });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    let previous;
    try { previous = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw new SetupError("现有密钥文件无法读取或格式无效；未覆盖。"); }
    if (previous && !rotate) {
      console.log("签名密钥已存在，未覆盖。轮换使用 npm run identity:init -- --rotate。");
      return;
    }
    if (rotate && !previous) throw new SetupError("没有现有密钥，请先执行 npm run identity:init。");
    const publicKeys = [];
    if (previous) {
      if (previous.version !== 1 || !Array.isArray(previous.keys) || !previous.keys.some(key => key.kid === previous.activeKid)) throw new SetupError("现有密钥格式无效；未覆盖。");
      if (previous.keys.length >= 10) throw new SetupError("已保留 10 个密钥；请确认旧 JWT 与公钥缓存过期后移除不用的旧公钥，再轮换。");
      for (const key of previous.keys) {
        if (key.kty !== "RSA" || !key.kid || !key.n || !key.e) throw new SetupError("现有公钥格式无效；未覆盖。");
        // Retain old PUBLIC keys only so already issued JWTs can still verify.
        publicKeys.push({ kty: "RSA", kid: key.kid, n: key.n, e: key.e, alg: "RS256", use: "sig" });
      }
    }
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
    const kid = randomUUID();
    const active = { ...privateKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
    const ring = { version: 1, activeKid: kid, keys: [active, ...publicKeys] };
    await writeFile(temporary, JSON.stringify(ring, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
    console.log(`${rotate ? "已轮换" : "已创建"}签名密钥：${file}\nkid=${kid}\n私钥未输出。请持久保存文件，并让所有应用实例使用相同密钥集。`);
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}
main().catch(error => {
  console.error(error instanceof SetupError ? error.message : "身份密钥操作失败，请检查路径、权限和现有密钥文件。未输出密钥内容。");
  process.exitCode = 1;
});
