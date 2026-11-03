import { symmetricDecrypt } from "better-auth/crypto";
import { decodeJwt } from "jose";
import { aliyunProfileFromClaims } from "./user-profile";

export async function readStoredAliyunProfile(account: { accountId: string; identityToken?: string | null }, secret: string) {
  if (!account.identityToken) return null;
  try {
    // Only read the server's encrypted token, verified on the OAuth callback.
    // This is saved display metadata, even after expiry; it grants no authority.
    // getUserIdentity independently enforces token expiry for cloud operations.
    const claims = decodeJwt(await symmetricDecrypt({ key: secret, data: account.identityToken }));
    if (claims.iss !== "https://oauth.aliyun.com" || claims.sub !== account.accountId) return null;
    return aliyunProfileFromClaims(claims);
  } catch {
    // Missing/old profile data should not prevent an otherwise valid app session.
    return null;
  }
}
