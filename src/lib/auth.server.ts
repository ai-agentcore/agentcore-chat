import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { genericOAuth } from "better-auth/plugins";
import { symmetricEncrypt, symmetricDecrypt } from "better-auth/crypto";
import { decodeJwt } from "jose";
import { aliyunProfileFromClaims, type CurrentUser } from "./user-profile";
import { readStoredAliyunProfile } from "./user-profile.server";
import { agentIdentityAuthMode, issueAppIdentityJwt } from "./app-identity.server";
import { frontendConfig } from "@/config/frontend";

// Aliyun OAuth is temporarily disabled for this distribution. Keep the provider
// implementation below for restoration and isolated protocol tests. Environment
// variables must not silently re-enable the application login route.
// Restore this reader when re-enabling OAuth:
// const aliyunSettings = () => ({ clientId: process.env.ALIYUN_OAUTH_CLIENT_ID?.trim() || "", clientSecret: process.env.ALIYUN_OAUTH_CLIENT_SECRET || undefined });
const aliyunSettings = (): { clientId: string; clientSecret?: string } => ({ clientId: "" });
export const aliyunEnabled = () => Boolean(aliyunSettings().clientId);
export function authSecret() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("Configure BETTER_AUTH_SECRET (at least 32 random characters).");
  return secret;
}

export async function createAppAuth(database: Database.Database, baseURL: string, secret: string, aliyun = aliyunSettings()) {
  // ID tokens are retained encrypted for the server-to-server Agent Identity
  // exchange. They are never returned as user/session fields or sent to the LLM.
  const protectToken = async (data: { idToken?: string | null }) => typeof data.idToken === "string"
    ? { data: { ...data, identityToken: await symmetricEncrypt({ key: secret, data: data.idToken }), idToken: null } }
    : { data };
  const auth = betterAuth({
    appName: frontendConfig.brand.name, database, baseURL, secret,
    onAPIError: { errorURL: `${baseURL}/login` },
    trustedOrigins: [new URL(baseURL).origin],
    emailAndPassword: { enabled: true, minPasswordLength: 10, maxPasswordLength: 128, autoSignIn: true },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    account: { accountLinking: { enabled: false }, encryptOAuthTokens: true,
      additionalFields: { identityToken: { type: "string", required: false, input: false, returned: false } } },
    databaseHooks: { account: { create: { before: protectToken }, update: { before: protectToken } } },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 100,
      customRules: { "/sign-in/email": { window: 60, max: 10 }, "/sign-up/email": { window: 60, max: 5 } } },
    advanced: { defaultCookieAttributes: { httpOnly: true, sameSite: "lax" } },
    plugins: aliyun.clientId ? [genericOAuth({ config: [{
      providerId: "aliyun", name: "阿里云", clientId: aliyun.clientId,
      clientSecret: aliyun.clientSecret,
      tokenEndpointAuth: { method: aliyun.clientSecret ? "client_secret_post" : "none" },
      discoveryUrl: "https://oauth.aliyun.com/.well-known/openid-configuration",
      requireIdTokenVerification: true, pkce: true, scopes: ["openid", "profile"],
      disableProviderLogout: true,
      async getUserInfo(tokens) {
        // genericOAuth has already verified signature, issuer, audience and nonce.
        if (!tokens.idToken) return null;
        const claims = decodeJwt(tokens.idToken);
        if (claims.iss !== "https://oauth.aliyun.com" || !claims.sub) return null;
        const subject = createHash("sha256").update(`${claims.iss}\0${claims.sub}`).digest("hex");
        return { sub: claims.sub, name: aliyunProfileFromClaims(claims).displayName,
          // RAM does not guarantee an email claim. This internal identifier is
          // deliberately distinct from email/password accounts; no auto-linking.
          email: `${subject}@aliyun.invalid`, emailVerified: false };
      },
    }] })] : [],
  });
  await (await getMigrations(auth.options)).runMigrations();
  return auth;
}

type AppAuth = Awaited<ReturnType<typeof createAppAuth>>;
const runtime = globalThis as typeof globalThis & { agentcoreAuth?: Promise<AppAuth>; agentcoreAuthConfig?: string; agentcoreDb?: Database.Database };
export function getAppDatabase(configuredPath = process.env.AUTH_DATABASE_PATH || "data/auth.sqlite"): Database.Database {
  const file = path.resolve(/* turbopackIgnore: true */ configuredPath);
  const db = runtime.agentcoreDb?.name === file ? runtime.agentcoreDb : (runtime.agentcoreDb = new Database(file));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

export function getAuth(): Promise<AppAuth> {
  const secret = process.env.BETTER_AUTH_SECRET || "";
  const baseURL = process.env.BETTER_AUTH_URL || "http://127.0.0.1:3000";
  const aliyun = aliyunSettings();
  // Runtime state lives on the deployment's persistent volume, never in its bundle.
  const file = path.resolve(/* turbopackIgnore: true */ process.env.AUTH_DATABASE_PATH || "data/auth.sqlite");
  const fingerprint = createHash("sha256").update(JSON.stringify({ secret, baseURL, file, aliyun, profileVersion: 1 })).digest("hex");
  if (runtime.agentcoreAuth && runtime.agentcoreAuthConfig === fingerprint) return runtime.agentcoreAuth;
  // Next.js reloads .env.local while globalThis survives HMR. Rebuild provider
  // configuration when it changes, preserving the existing SQLite connection.
  runtime.agentcoreAuthConfig = fingerprint;
  const pending = (async () => {
    if (secret.length < 32) throw new Error("Configure BETTER_AUTH_SECRET (at least 32 random characters).");
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const db = getAppDatabase(file);
    return createAppAuth(db, baseURL, secret, aliyun);
  })().catch((error) => {
    if (runtime.agentcoreAuth === pending) delete runtime.agentcoreAuth;
    throw error;
  });
  return runtime.agentcoreAuth = pending;
}

export async function getSession(headers: Headers) {
  return (await getAuth()).api.getSession({ headers });
}
export type AppSession = NonNullable<Awaited<ReturnType<typeof getSession>>>;
export const unauthorized = () => Response.json({ error: "请先登录后继续。", code: "UNAUTHORIZED" },
  { status: 401, headers: { "Cache-Control": "private, no-store" } });

export async function getCurrentUser(session: AppSession): Promise<CurrentUser> {
  const accounts = await (await (await getAuth()).$context).internalAdapter.findAccounts(session.user.id);
  const account = accounts.find((item) => item.providerId === "aliyun");
  if (!account) return { id: session.user.id, name: session.user.name, email: session.user.email, provider: "email" };
  const profile = await readStoredAliyunProfile(account as typeof account & { identityToken?: string }, authSecret());
  return { id: session.user.id, name: profile?.displayName || session.user.name, email: null, provider: "aliyun", aliyun: profile };
}

export async function getUserIdentity(session: AppSession) {
  const mode = agentIdentityAuthMode();
  if (mode === "user_id") return { type: "userId" as const, userId: `app:${session.user.id}` };
  if (mode === "app_jwt") return { type: "jwt" as const, userToken: await issueAppIdentityJwt(session) };
  // Optional legacy provider mode: Aliyun users use their original ID Token;
  // email users use the application's asserted identity. Never fall back on failure.
  const auth = await getAuth();
  const accounts = await (await auth.$context).internalAdapter.findAccounts(session.user.id);
  const aliyun = accounts.find((account) => account.providerId === "aliyun");
  if (!aliyun) return { type: "userId" as const, userId: `app:${session.user.id}` };
  const encrypted = (aliyun as typeof aliyun & { identityToken?: string }).identityToken;
  if (!encrypted) throw new Error("IDENTITY_REAUTH_REQUIRED");
  const userToken = await symmetricDecrypt({ key: authSecret(), data: encrypted });
  const claims = decodeJwt(userToken);
  // No silent downgrade from an expired cloud identity to an asserted user ID.
  if (!claims.exp || claims.exp * 1000 <= Date.now() + 60_000 || claims.sub !== aliyun.accountId) throw new Error("IDENTITY_REAUTH_REQUIRED");
  return { type: "jwt" as const, userToken };
}
