# 本站 JWT → Agent Identity

已实现本站会话到签名 JWT 的服务端转换、公开验证元数据和 JWKS，以及按身份方式选择 WAT 接口。本地默认继续使用 `ForUserId`，不要求公网域名。身份方式与文件共享范围已经拆开。

## 两个独立开关

| 配置 | 值 | 行为 |
| --- | --- | --- |
| `AGENT_IDENTITY_AUTH_MODE` | `user_id`（默认） | 所有登录方式均使用 `app:<本站用户ID>`，FC 调用 `GetWorkloadAccessTokenForUserId` |
| 同上 | `app_jwt` | 本站为所有登录方式签发 JWT，FC 调用 `GetWorkloadAccessTokenForJWT` |
| 同上 | `login_provider` | 兼容原链路：阿里云登录使用其 ID Token，邮箱登录使用 `ForUserId` |
| `FILE_ACCESS_MODE` | `shared` / `user` | 只决定共享前缀或当前用户目录的路径检查和只读 STS Policy，不决定 JWT 来源 |

JWT 配置缺失、签发失败或云端拒绝时返回错误，不自动降级为 `ForUserId`。需要切回本地模式时，由管理员显式设置 `AGENT_IDENTITY_AUTH_MODE=user_id`。

## 已有端点与签发方式

| 端点 | 返回内容 |
| --- | --- |
| `GET /.well-known/openid-configuration` | 固定配置的 issuer、jwks_uri、RS256 算法及支持的身份字段 |
| `GET /.well-known/jwks.json` | 当前及轮换期间保留的 RSA 公钥，包含 kid，不包含私钥字段 |

这两个端点不需要登录，成功响应可缓存 60 秒；未配置签发方或密钥时返回 503 且不缓存错误。URL 使用固定的 `APP_IDENTITY_ISSUER`，不从请求的 Host 或 forwarded headers 推断。

这里提供的是 **服务端 JWT 验证所需的发现元数据**，不包含通用 OAuth 授权码流程、第三方客户端注册、授权端点或公开 Token 端点，也不会虚构这些端点。Agent Identity 云端是否接受这份验证元数据、以及真实 WAT 交换，需要发布 HTTPS 地址并完成云端注册后联调；本地验签测试不能替代该验证。

浏览器继续使用 Cookie 登录；每次读取文件先查询 SQLite 会话，验证成功后才在服务端调用签发函数。JWT 不发送给浏览器或黑盒 Agent，不放进提示词、聊天记录或 SQLite。

JWT 使用 RS256，私钥由 Node.js 生成并持久保存在服务端；header 带 `kid`。载荷只含 `iss`、`sub`、`aud`、`iat`、`exp`、`jti`，不包含昵称、邮箱、原始阿里云 ID Token 或登录 Cookie。`sub=app:<本站用户ID>`，与当前 ForUserId 的用户标识一致。

默认有效期 900 秒，并受本站会话到期时间限制；允许配置 600–3600 秒。JWT 按会话、用户、签发配置及密钥版本缓存，剩余不足 5 分钟时重新签发。退出后，新文件请求无法通过会话检查，不能继续申请凭证；已经签发的 JWT/STS 仍有自身有效期，不宣称能立即远程吊销。

## 上线配置顺序

1. 为应用准备 HTTPS 域名，以及持久存储认证数据库和密钥的目录。在服务端先保持 `user_id`，配置：

   ```dotenv
   AGENT_IDENTITY_AUTH_MODE=user_id
   APP_IDENTITY_ISSUER=https://chat.example.com
   APP_IDENTITY_AUDIENCE=agentcore-chat
   APP_IDENTITY_KEY_FILE=./data/identity/keyring.private.json
   APP_IDENTITY_TOKEN_TTL_SECONDS=900
   ```

   `APP_IDENTITY_ISSUER` 是不带路径的 HTTPS 源地址，必须与对外发布的签发方一致。若浏览器也通过该域名访问，另将 `BETTER_AUTH_URL` 改为这个源地址，并更新阿里云登录回调白名单。仅发布身份验证端点并不要求对外开放所有聊天 API。

2. 在服务端生成一次密钥，然后启动或重新加载应用：

   ```bash
   npm run identity:init
   ```

   脚本读取 `.env.local`，进程环境变量优先。默认私钥文件位于被 Git 忽略、被构建排除的 `data/identity/`，权限为 0600；终端只显示路径和 kid。已有文件不会覆盖。持久目录需保留，所有实例必须使用同一密钥集；不要每次启动重新生成，也不要把文件放进 `public/` 或前端构建。

3. 从公网检查：

   ```text
   https://chat.example.com/.well-known/openid-configuration
   https://chat.example.com/.well-known/jwks.json
   ```

   两者需返回 JSON，而非登录重定向、HTML 或 503。反向代理应允许访问它们。不要将示例域名原样当作真实配置。

4. 在 Agent Identity 注册本站 OIDC 身份提供商，Discovery 地址填上面的第一条，Audience 白名单填 `agentcore-chat`（或你实际配置的值）；再将该提供商关联到目标 Workload Identity，例如当前 `agentcore-sts-get`。不能把“发布站点”当作已完成云端信任注册。[官方身份提供商配置](https://help.aliyun.com/zh/agentidentity/identity-provider-management)

5. 确认 Runloop 的 `/v1/sts` 已启用。Chat 始终发送 `version: 1`、用户身份和目录级 Policy；Runloop 通过 Controller 获取当前 Workload Access Token，再交换受 Policy 限制的 STS。

6. 改为 `AGENT_IDENTITY_AUTH_MODE=app_jwt`，重新加载应用。用邮箱账号和阿里云账号分别登录、预览有权访问的实际文件，检查 WAT → STS → OSS 链路。是否共享文件仍由 `FILE_ACCESS_MODE` 决定，切换 JWT 不会自动隔离文件。

## 密钥轮换

```bash
npm run identity:init -- --rotate
```

脚本原子替换密钥集，启用新 kid，保留旧公钥并丢弃旧私钥；初始化和轮换使用文件锁，避免同时写入。新请求读取新的密钥版本，不再复用旧签名的 JWT 缓存。不要把每个实例各自生成的密钥混在一起。

保留旧公钥至少覆盖既有 JWT 的最大有效期及云端 JWKS 缓存窗口，确认不再需要后再移除。旧公钥最多保留到密钥集共 10 个，达到上限时脚本拒绝继续堆积，避免无界增长。删除旧公钥并不会撤销已换取的 STS。

## 当前验证范围

本地测试覆盖真实 SQLite 登录、RS256 公钥验签、issuer/audience/过期校验、篡改拒绝、会话期限约束、公钥字段过滤、密钥轮换、匿名/退出后拒绝签发、JWT 模式下两种文件 Policy，以及配置错误不降级。公开端点不提供任何 Token 获取接口。

尚未发布真实 HTTPS issuer，也未在云端注册本站身份提供商；这两项是启用 `app_jwt` 前的部署工作。本地 `.env.local` 仍保持 `AGENT_IDENTITY_AUTH_MODE=user_id`。
