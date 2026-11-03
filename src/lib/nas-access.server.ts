import { FileAccessError } from "./files";
import { getStsCredentials, type StsGrant, type UserIdentity } from "./sts-credentials.server";

type Environment = Readonly<Record<string, string | undefined>>;

/** These identifiers select a RAM resource, not a local path or an NFS address. */
export function nasAccessConfig(env: Environment = process.env) {
  const required = (name: string, pattern: RegExp) => {
    const value = env[name]?.trim() || "";
    if (!pattern.test(value)) throw new FileAccessError(503, "NAS_NOT_CONFIGURED", `请配置有效的 ${name}。`);
    return value;
  };
  const region = required("NAS_REGION", /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/);
  const accountId = required("NAS_ACCOUNT_ID", /^\d{1,32}$/);
  const fileSystemId = required("NAS_FILE_SYSTEM_ID", /^[a-z0-9][a-z0-9-]{0,127}$/);
  const accessPointId = required("NAS_ACCESS_POINT_ID", /^ap-[a-z0-9]+$/);
  return {
    region, accountId, fileSystemId, accessPointId,
    fileSystemArn: `acs:nas:${region}:${accountId}:filesystem/${fileSystemId}`,
    accessPointArn: `acs:nas:${region}:${accountId}:accesspoint/${accessPointId}`,
  };
}

/** Mount/read only. This grants an access point, not a users/<namespace> prefix. */
export function nasReadPolicy(env: Environment = process.env): string {
  const config = nasAccessConfig(env);
  return JSON.stringify({ Version: "1", Statement: [{
    Effect: "Allow", Action: ["nas:ClientMount"], Resource: [config.fileSystemArn],
    Condition: { StringEquals: { "nas:AccessPointArn": config.accessPointArn } },
  }] });
}

/**
 * Reuse the existing user identity, signed broker protocol and grant-scoped cache.
 * A trusted NAS mount client must consume these credentials. Obtaining STS alone
 * does not authorize reads through an unrelated, already-mounted filesystem.
 * /api/files supplies the identity; nas-mount.server passes STS to mount.alinas.
 */
export function getNasReadCredentials(
  identity: UserIdentity,
  getSts: (grant: StsGrant) => ReturnType<typeof getStsCredentials> = getStsCredentials,
  env: Environment = process.env,
) {
  if (!identity || (identity.type !== "userId" && identity.type !== "jwt")
    || (identity.type === "userId" ? !identity.userId?.trim() : !identity.userToken?.trim())) {
    throw new FileAccessError(401, "IDENTITY_REQUIRED", "NAS 文件访问需要有效的用户身份。");
  }
  return getSts({ identity, policy: nasReadPolicy(env) });
}
