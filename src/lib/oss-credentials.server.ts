import { FileAccessError } from "./files";
import { getStsCredentials, StsCredentialError } from "./sts-credentials.server";

export interface OssCredentials { accessKeyId: string; accessKeySecret: string; stsToken?: string; }

/** OSS-specific SDK field mapping and file API errors stay in the main app. */
export function credentialProvider(getSts: () => ReturnType<typeof getStsCredentials>): () => Promise<OssCredentials> {
  return async () => {
    try {
      const value = await getSts();
      return { accessKeyId: value.accessKeyId, accessKeySecret: value.accessKeySecret, stsToken: value.securityToken };
    } catch (error) {
      if (error instanceof StsCredentialError && error.status === 503) {
        throw new FileAccessError(503, "OSS_NOT_CONFIGURED", "文件凭证服务尚未配置，请检查服务端 STS Broker 环境变量。");
      }
      throw new FileAccessError(502, "OSS_CREDENTIALS_UNAVAILABLE", "暂时无法获取文件访问凭证，请稍后重试。");
    }
  };
}
