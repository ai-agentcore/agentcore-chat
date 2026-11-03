import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { resolveStsBrokerUrl } from "@/lib/agent-api-config.server";
export interface StsCredentials { accessKeyId: string; accessKeySecret: string; securityToken: string; expiration: string; }
export type UserIdentity = { type: "userId"; userId: string } | { type: "jwt"; userToken: string };
export type StsGrant = { identity: UserIdentity; policy: string };
export interface BrokerConfig {
  url: string; keyId?: string; secretHex?: string; apiKey?: string;
}
type BrokerDependencies = { fetch?: typeof fetch; now?: () => number };
const PATH = "/v1/sts";
const REFRESH_BEFORE_MS = 5 * 60_000;
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const sign = (secret: Buffer, body: string) => createHmac("sha256", secret).update(body).digest("hex");
export class StsCredentialError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const configError = () => new StsCredentialError(503, "STS_NOT_CONFIGURED", "STS 服务尚未配置，请检查服务端 Broker 环境变量。");
const exchangeError = () => new StsCredentialError(502, "STS_UNAVAILABLE", "暂时无法获取临时凭证，请稍后重试。");

async function limitedText(response: Response) {
  if (!response.body) throw exchangeError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) { await reader.cancel(); throw exchangeError(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Private per-process cache; only callers with identical grants share an exchange. */
export function createBrokerCredentialProvider(config: BrokerConfig, dependencies: BrokerDependencies = {}) {
  let url: URL;
  try { url = new URL(config.url); } catch { throw configError(); }
  const hmacEnabled = Boolean(config.keyId && config.secretHex);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== PATH
    || Boolean(config.keyId) !== Boolean(config.secretHex)
    || (config.secretHex !== undefined && !/^[a-fA-F0-9]{64}$/.test(config.secretHex))
    || (config.keyId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(config.keyId))
    || (config.apiKey !== undefined && (!config.apiKey || config.apiKey.length > 4096 || /[\r\n]/.test(config.apiKey)))) throw configError();
  const secret = config.secretHex ? Buffer.from(config.secretHex, "hex") : undefined;
  const send = dependencies.fetch || fetch;
  const now = dependencies.now || Date.now;
  const cached = new Map<string, { value: StsCredentials; expiresAt: number }>();
  const pending = new Map<string, Promise<StsCredentials>>();

  const exchange = async (bodyJson: string, cacheKey: string, deadline: number): Promise<StsCredentials> => {
    const timestamp = hmacEnabled ? String(Math.floor(now() / 1000)) : undefined;
    const nonce = hmacEnabled ? randomBytes(16).toString("hex") : undefined;
    const canonical = hmacEnabled ? ["STS-BROKER-V1", "POST", PATH, config.keyId, timestamp, nonce, hash(bodyJson)].join("\n") : undefined;
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(config.apiKey ? { "x-api-key": config.apiKey } : {}),
      };
      if (hmacEnabled) Object.assign(headers, {
        "X-STS-Key-ID": config.keyId!,
        "X-STS-Timestamp": timestamp!,
        "X-STS-Nonce": nonce!,
        "X-STS-Signature": sign(secret!, canonical!),
      });
      const response = await send(url, {
        method: "POST", body: bodyJson, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(25_000),
        headers,
      });
      if (!response.ok) { await response.body?.cancel(); throw exchangeError(); }
      const body = await limitedText(response);
      if (hmacEnabled) {
        const supplied = response.headers.get("x-sts-response-signature") || "";
        const expected = sign(secret!, ["STS-BROKER-RESPONSE-V1", nonce!, hash(body)].join("\n"));
        if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"))) throw exchangeError();
      }
      const data = JSON.parse(body);
      if (data.version !== 1) throw exchangeError();
      const value = data.credentials;
      if (!value || ["accessKeyId", "accessKeySecret", "securityToken", "expiration"].some((key) => typeof value[key] !== "string" || !value[key].trim())) throw exchangeError();
      // Require an explicit timezone and enough lifetime for the next cloud API call.
      if (!/(?:Z|[+-]\d\d:\d\d)$/.test(value.expiration)) throw exchangeError();
      const expiresAt = Date.parse(value.expiration);
      if (!Number.isFinite(expiresAt) || expiresAt <= now() + 60_000) throw exchangeError();
      const credentials = Object.freeze({ accessKeyId: value.accessKeyId, accessKeySecret: value.accessKeySecret,
        securityToken: value.securityToken, expiration: value.expiration });
      if (cached.size >= 1000) cached.delete(cached.keys().next().value!);
      cached.set(cacheKey, { value: credentials, expiresAt: Math.min(expiresAt, deadline) });
      return credentials;
    } catch {
      // No upstream payloads, URLs, HMAC secrets or credentials in user errors.
      throw exchangeError();
    }
  };

  return async function get(grant: StsGrant): Promise<StsCredentials> {
    let deadline = Infinity;
    if (grant.identity.type === "jwt") {
      try {
        const claims = JSON.parse(Buffer.from(grant.identity.userToken.split(".")[1], "base64url").toString());
        if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) throw exchangeError();
        deadline = claims.exp * 1000;
      } catch { throw exchangeError(); }
      if (deadline <= now() + 60_000) throw new StsCredentialError(401, "IDENTITY_REAUTH_REQUIRED", "阿里云授权已过期，请退出并重新登录。");
    }
    const body = JSON.stringify({ version: 1, ...grant });
    const key = hash(body);
    const hit = cached.get(key);
    if (hit && hit.expiresAt > now() + REFRESH_BEFORE_MS) return hit.value;
    if (!pending.has(key)) {
      if (pending.size >= 100) throw exchangeError();
      pending.set(key, exchange(body, key, deadline).finally(() => { pending.delete(key); }));
    }
    return pending.get(key)!;
  };
}

let configured: { config: BrokerConfig; get: (grant: StsGrant) => Promise<StsCredentials> } | null = null;

export async function getStsCredentials(grant: StsGrant): Promise<StsCredentials> {
  const config: BrokerConfig = { url: resolveStsBrokerUrl() || "",
    keyId: process.env.STS_BROKER_KEY_ID || undefined, secretHex: process.env.STS_BROKER_SECRET || undefined,
    apiKey: process.env.STS_BROKER_API_KEY || process.env.AGENT_API_KEY || undefined };
  if (!configured || Object.keys(config).some((key) => config[key as keyof BrokerConfig] !== configured!.config[key as keyof BrokerConfig])) {
    configured = { config, get: createBrokerCredentialProvider(config) };
  }
  return configured.get(grant);
}
