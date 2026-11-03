import { createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SignJWT, type JWK } from "jose";
import type { AppSession } from "./auth.server";

export class AppIdentityError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const configError = () => new AppIdentityError(503, "APP_IDENTITY_NOT_CONFIGURED", "本站身份签发服务尚未配置，请检查服务端身份配置。");

export function agentIdentityAuthMode(): "user_id" | "app_jwt" | "login_provider" {
  const mode = process.env.AGENT_IDENTITY_AUTH_MODE || "user_id";
  if (mode !== "user_id" && mode !== "app_jwt" && mode !== "login_provider") throw configError();
  return mode;
}

function issuerConfig() {
  try {
    const configured = process.env.APP_IDENTITY_ISSUER || "";
    const url = new URL(configured);
    // An explicit canonical HTTPS origin; never derive identity URLs from Host.
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw configError();
    const audience = process.env.APP_IDENTITY_AUDIENCE || "";
    if (!audience || audience.length > 200 || /\s|[\u0000-\u001f\u007f]/.test(audience)) throw configError();
    const ttl = Number(process.env.APP_IDENTITY_TOKEN_TTL_SECONDS || "900");
    if (!Number.isInteger(ttl) || ttl < 600 || ttl > 3600) throw configError();
    const keyFile = path.resolve(/* turbopackIgnore: true */ process.env.APP_IDENTITY_KEY_FILE || "data/identity/keyring.private.json");
    return { issuer: url.origin, audience, ttl, keyFile };
  } catch { throw configError(); }
}

type PublicKey = { kty: "RSA"; kid: string; n: string; e: string; alg: "RS256"; use: "sig" };
function publicKey(jwk: JWK): PublicKey {
  if (!jwk || jwk.kty !== "RSA" || typeof jwk.kid !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(jwk.kid)
    || typeof jwk.n !== "string" || !/^[A-Za-z0-9_-]+$/.test(jwk.n) || Buffer.from(jwk.n, "base64url").length < 256
    || typeof jwk.e !== "string" || !/^[A-Za-z0-9_-]+$/.test(jwk.e)) throw configError();
  // Explicit allowlist: d, p, q, dp, dq, qi and any future private fields never leave the server.
  return { kty: "RSA", kid: jwk.kid, n: jwk.n, e: jwk.e, alg: "RS256", use: "sig" };
}

type SigningMaterial = {
  fingerprint: string; activeKid: string; privateKey: ReturnType<typeof createPrivateKey>; keys: PublicKey[];
};
let signingMaterial: SigningMaterial | undefined;
async function loadSigningMaterial(keyFile: string): Promise<SigningMaterial> {
  try {
    const data = await readFile(keyFile, "utf8");
    if (Buffer.byteLength(data) > 65_536) throw configError();
    const fingerprint = createHash("sha256").update(data).digest("hex");
    if (signingMaterial?.fingerprint === fingerprint) return signingMaterial;
    const ring = JSON.parse(data) as { version: number; activeKid: string; keys: JWK[] };
    if (ring.version !== 1 || !Array.isArray(ring.keys) || !ring.keys.length || ring.keys.length > 10) throw configError();
    const keys = ring.keys.map(publicKey);
    if (new Set(keys.map(key => key.kid)).size !== keys.length) throw configError();
    const active = ring.keys.find(key => key.kid === ring.activeKid);
    const privateFields = ["d", "p", "q", "dp", "dq", "qi"] as const;
    if (!active || !privateFields.every(field => typeof active[field] === "string" && /^[A-Za-z0-9_-]+$/.test(active[field] as string))) throw configError();
    const privateKey = createPrivateKey({ format: "jwk", key: {
      kty: active.kty, n: active.n, e: active.e, d: active.d,
      p: active.p, q: active.q, dp: active.dp, dq: active.dq, qi: active.qi,
    } });
    if (privateKey.asymmetricKeyType !== "rsa" || (privateKey.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw configError();
    const derived = createPublicKey(privateKey).export({ format: "jwk" });
    if (derived.n !== active.n || derived.e !== active.e) throw configError();
    signingMaterial = { fingerprint, activeKid: ring.activeKid, privateKey, keys };
    return signingMaterial;
  } catch { throw configError(); }
}

/** Public verification metadata, not a general OAuth authorization/token server. */
export async function appIdentityPublicDocument(kind: "discovery" | "jwks") {
  try {
    const config = issuerConfig();
    const material = await loadSigningMaterial(config.keyFile);
    const body = kind === "jwks" ? { keys: material.keys } : {
      issuer: config.issuer,
      jwks_uri: `${config.issuer}/.well-known/jwks.json`,
      id_token_signing_alg_values_supported: ["RS256"],
      subject_types_supported: ["public"],
      claims_supported: ["iss", "sub", "aud", "iat", "exp", "jti"],
    };
    return Response.json(body, { headers: { "Cache-Control": "public, max-age=60", "X-Content-Type-Options": "nosniff" } });
  } catch {
    const error = configError();
    return Response.json({ code: error.code, error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
}

const tokens = new Map<string, { token: string; expiresAt: number }>();
const pending = new Map<string, Promise<string>>();

/** Called only after getSession has verified the current request, never exposed as an HTTP token API. */
export async function issueAppIdentityJwt(session: AppSession): Promise<string> {
  const config = issuerConfig();
  const material = await loadSigningMaterial(config.keyFile);
  const now = Math.floor(Date.now() / 1000);
  const sessionExpiresAt = Math.floor(new Date(session.session.expiresAt).getTime() / 1000);
  if (!session.user.id || !session.session.id || session.session.userId !== session.user.id
    || !Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= now + 90) {
    throw new AppIdentityError(401, "SESSION_REAUTH_REQUIRED", "登录已过期或即将过期，请重新登录后继续。");
  }
  const expiresAt = Math.min(now + config.ttl, sessionExpiresAt);
  const cacheKey = createHash("sha256").update(JSON.stringify([material.fingerprint, config.issuer, config.audience,
    config.ttl, session.user.id, session.session.id, sessionExpiresAt])).digest("hex");
  const cached = tokens.get(cacheKey);
  if (cached && cached.expiresAt > now + 300) return cached.token;
  if (!pending.has(cacheKey)) {
    if (pending.size >= 100) throw new AppIdentityError(503, "IDENTITY_BUSY", "身份服务繁忙，请稍后重试。");
    const signing = new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: material.activeKid })
      .setIssuer(config.issuer).setSubject(`app:${session.user.id}`).setAudience(config.audience)
      .setIssuedAt(now).setExpirationTime(expiresAt).setJti(randomUUID()).sign(material.privateKey)
      .then(token => {
        if (tokens.size >= 1000) tokens.delete(tokens.keys().next().value!);
        tokens.set(cacheKey, { token, expiresAt });
        return token;
      }).catch(() => { throw configError(); }).finally(() => { pending.delete(cacheKey); });
    pending.set(cacheKey, signing);
  }
  return pending.get(cacheKey)!;
}
