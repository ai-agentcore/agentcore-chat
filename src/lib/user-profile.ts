export type AliyunProfile = {
  displayName: string;
  loginName: string | null;
  accountType: "account" | "user" | "role" | null;
};

export type CurrentUser = { id: string; name: string } & (
  | { provider: "email"; email: string }
  | { provider: "aliyun"; email: null; aliyun: AliyunProfile | null }
);

const textClaim = (value: unknown) => typeof value === "string" ? value.trim().slice(0, 256) || null : null;

// Explicit projection: tokens, subject IDs and arbitrary provider claims never
// become page props. A login name resembling an email is still only a login name.
export function aliyunProfileFromClaims(claims: Record<string, unknown>): AliyunProfile {
  const loginName = textClaim(claims.login_name) || textClaim(claims.upn);
  const accountType = textClaim(claims.type)?.toLowerCase();
  return {
    displayName: (textClaim(claims.name) || loginName || "阿里云用户").slice(0, 80),
    loginName,
    accountType: accountType === "account" || accountType === "user" || accountType === "role" ? accountType : null,
  };
}

export function aliyunAccountTypeLabel(type: AliyunProfile["accountType"]) {
  return type === "account" ? "阿里云主账号" : type === "user" ? "RAM 用户" : type === "role" ? "RAM 角色" : "未提供";
}
