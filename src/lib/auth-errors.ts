export function aliyunLoginError(error?: { code?: string; status?: number } | null) {
  if (error?.status === 429) return "登录尝试较多，请稍后再试。";
  if (error?.code === "INVALID_ORIGIN" || error?.code === "INVALID_CALLBACK_URL") return "当前访问地址与登录配置不一致，请从配置的站点地址进入，并检查 OAuth 回调地址。";
  if (error?.code === "PROVIDER_NOT_FOUND" || error?.code === "ALIYUN_NOT_CONFIGURED") return "阿里云登录配置尚未就绪，请检查应用 ID，以及服务端能否访问阿里云 OIDC 配置。";
  return "暂时无法连接阿里云登录，请稍后重试。";
}
