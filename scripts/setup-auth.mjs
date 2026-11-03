import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
const file = ".env.local";
let data = existsSync(file) ? readFileSync(file, "utf8") : readFileSync(".env.example", "utf8");
for (const [key, value] of Object.entries({ BETTER_AUTH_SECRET: randomBytes(32).toString("hex"), BETTER_AUTH_URL: "http://127.0.0.1:3000", AUTH_DATABASE_PATH: "./data/auth.sqlite" })) {
  const pattern = new RegExp(`^${key}=(.*)$`, "m");
  const existing = data.match(pattern);
  if (existing?.[1]?.trim()) continue;
  data = existing ? data.replace(pattern, `${key}=${value}`) : `${data}\n${key}=${value}\n`;
}
writeFileSync(file, data, { mode: 0o600 });
chmodSync(file, 0o600);
console.log("SQLite authentication configured in .env.local. Existing values preserved; secrets not displayed.");
