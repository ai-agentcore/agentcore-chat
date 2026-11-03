# 登录、SQLite 与用户身份接入

> 当前版本暂时禁用阿里云 OAuth 登录及页面入口，仅开放邮箱密码登录。OAuth 环境变量不会启用该功能；下方阿里云接入说明保留供恢复实现后使用。

## 本地启动

```bash
npm ci
# 新环境才需要复制，已有 .env.local 不要覆盖
cp .env.example .env.local
npm run auth:init
npm run dev
```

访问 `http://127.0.0.1:3000/login`，选择「注册」。邮箱密码注册、登录、退出和修改密码无需阿里云配置。

| 环境变量 | 用途 |
| --- | --- |
| `BETTER_AUTH_SECRET` | 至少 32 字符的随机密钥；初始化脚本生成，不能每次启动重新生成。用于签名 Cookie、加密 OAuth 凭证 |
| `BETTER_AUTH_URL` | 浏览器访问的完整源地址，如 `http://127.0.0.1:3000` 或生产 HTTPS 地址；换端口时同步修改 |
| `AUTH_DATABASE_PATH` | 默认 `./data/auth.sqlite`，存储账号、密码哈希、会话、OAuth 账号关联及限流数据 |
| `ALIYUN_OAUTH_CLIENT_ID` | RAM OAuth 应用 ID；留空时邮箱登录可用，阿里云按钮禁用 |
| `ALIYUN_OAUTH_CLIENT_SECRET` | 可选，仅机密客户端填写；OAuth 2.1 PKCE 公共客户端留空，不是云 AccessKey |

SQLite 使用 WAL、外键约束、5 秒 busy timeout，首次访问自动迁移。部署时持久化整个 `data/` 目录，包含 WAL 文件；备份使用 SQLite 在线备份机制或停服后复制。适合单实例或同一主机上的应用，不要把各自拥有独立本地磁盘的多实例当作共享数据库。`data/`、SQLite 文件与环境变量文件均已忽略，不进入 Git。

密码由 Better Auth 使用 scrypt 哈希；会话 Cookie 为 HttpOnly / SameSite=Lax，生产 HTTPS 下为 Secure，默认 7 天。服务端逐请求查询会话，没有启用 Cookie 会话缓存。修改密码会撤销其他登录会话；聊天、文件预览和下载接口也各自校验登录态。

当前未接入邮件发送服务，因此邮箱作为登录名使用，**尚无邮箱所有权验证和忘记密码邮件**。不要依赖未验证邮箱授予组织权限。阿里云账号不会按邮箱自动合并到本地账号。

## 阿里云账号登录

这里接入的是 **RAM OAuth 2.1 / OIDC 应用允许访问的阿里云身份**。哪些主账号、RAM 用户能登录，取决于所创建应用的类型和授权范围；不能把某个企业应用当作已经向所有阿里云账号开放。

1. 在 RAM 控制台进入「集成管理 → OAuth 应用（公测）→ 企业应用」，按官方向导创建 **OAuth 2.1、Web** 应用。
2. 添加精确回调地址：`http://127.0.0.1:3000/api/auth/callback/aliyun`。如果控制台不允许此本地地址，使用可访问的 HTTPS 开发域名，并同步修改 `BETTER_AUTH_URL`。生产回调为 `https://你的域名/api/auth/callback/aliyun`。
3. 配置 `openid`、`profile` 范围及允许使用该应用的用户，复制应用 ID 到 `ALIYUN_OAUTH_CLIENT_ID`。遵循所选客户端类型设置可选 Secret，重启 Next.js。
4. 点击「使用阿里云账号继续」，由阿里云页面完成登录，再返回应用。本站不会收集阿里云密码。

固定使用以下官方元数据（已读取核对）：

- Discovery：`https://oauth.aliyun.com/.well-known/openid-configuration`
- Issuer：`https://oauth.aliyun.com`
- 授权端点：`https://signin.aliyun.com/oauth2/v1/auth`
- Token：`https://oauth.aliyun.com/v1/token`
- JWKS：`https://oauth.aliyun.com/v1/keys`，RS256

本地开发时，请使用 `BETTER_AUTH_URL` 对应的源地址。`localhost` 和 `127.0.0.1` 的 Cookie 不共享；登录页会将本地别名跳到配置的地址，而不会放开跨站校验。修改 `.env.local` 中的 OAuth 应用配置后，开发服务会按配置指纹重建认证实例，保留 SQLite 用户与会话；生产环境仍需重启服务。若看到“配置尚未就绪”，检查应用 ID 和服务端对 OIDC Discovery 的网络访问；若提示地址不一致，核对站点地址与 RAM 回调地址。

认证库校验 state、PKCE S256、ID Token 签名、issuer、audience、nonce 和有效期。账号关联使用稳定的 `sub`；RAM 没有邮箱声明时，内部使用由 issuer/sub 派生的 `@aliyun.invalid` 标识，不展示为真实邮箱，也禁止通过邮箱注册占用该后缀。

ID Token 加密存入 SQLite 的 `account.identityToken`，原始 `idToken` 字段清空；不通过浏览器接口或 Agent 提示词传递 Token。当前不做阿里云 ID Token 静默刷新：只有显式 `AGENT_IDENTITY_AUTH_MODE=login_provider` 时，云 ID Token 临近过期会要求重新登录。默认 `user_id` 和上线后可启用的 `app_jwt` 均基于有效本站会话，身份方式不再与文件共享模式绑定。

### 账号基础资料

账号设置显示阿里云返回的显示名、登录名和账号类型。服务端从登录时已校验、加密保存的 ID Token 中提取白名单字段：`name`、主账号的 `login_name` / RAM 用户的 `upn`、`type`（主账号 / RAM 用户 / RAM 角色）。现有登录刷新页面即可显示，缺少的字段标记为“未提供”。基础资料仅用于界面展示，不发送给 Agent，不参与授权判断。

当前仍只申请 `openid profile`，不增加授权范围。登录名即使形如邮箱也不当作已验证邮箱；目前不展示阿里云头像或真实邮箱。Token 过期后可以展示上次登录的资料，但采用 JWT 联合身份的云资源访问仍需有效 Token；资料在下一次阿里云登录后更新。字段说明见[阿里云 OIDC 用户信息](https://help.aliyun.com/zh/ram/obtain-user-information-through-oidc)。

## 用户身份 → Runloop → Agent Identity → STS

```mermaid
flowchart LR
  A[邮箱登录 / 阿里云 OIDC 登录] --> B[Next.js 校验 SQLite 会话]
  B --> C[服务端确定 userId 或 ID Token]
  C --> D[HTTPS + AgentCore 网关调用 Runloop]
  D --> E[Agent Identity 用户 WAT]
  E --> F[AssumeRoleForWorkloadIdentity]
  F --> G[用户范围 STS]
  G --> H[Next.js 读取 OSS 后流式返回文件]
```

- **`AGENT_IDENTITY_AUTH_MODE=user_id`（本地默认）**：所有登录方式均从已验证会话构造 `app:<用户ID>`，FC 调用 `GetWorkloadAccessTokenForUserId`；浏览器不能指定被信任的用户 ID。
- **`app_jwt`**：本站为已验证的登录会话签发短期 JWT，邮箱和阿里云账号都走 `GetWorkloadAccessTokenForJWT`。需先发布 HTTPS Discovery/JWKS 并配置云端信任；完整步骤见 [本站 JWT 身份接入](app-jwt-identity.md)。
- **`login_provider`（可选兼容模式）**：阿里云账号使用加密保存且未过期的原始 ID Token，邮箱账号使用 ForUserId；云端 JWT 验证失败不降级。
- `FILE_ACCESS_MODE=shared/user` 只控制资源范围；更换身份方式不会自动改变文件共享权限。
- Runloop 使用平台注入的运行时 SA 向 Controller 获取 `agentidentitydata` Resource STS，再调用 Agent Identity。返回的 STS 归属 Workload Identity 的运行时角色，权限不会自动变成该登录用户自身的 RAM 权限。
- Runloop Broker 保持通用：只接收签名保护的身份与可选通用会话 Policy，不含 bucket 或 OSS 路径逻辑。OSS 调用由主应用构造 `oss:GetObject` Policy，与运行时角色权限取交集；`user` 模式限当前账号目录，`shared` 模式限整个配置前缀。
- 两端缓存以身份（JWT 使用完整 Token 的哈希）和 Policy 区分，并合并同一键的并发请求。JWT 过期后不能使用旧缓存。STS 只在服务端内存中保存，不进入 SQLite、页面或浏览器。

### Policy 在哪里收窄权限

当前 Runloop Broker 先通过 `GetWorkloadAccessToken*` 获取 WAT，再把 `policy` 传给 `AssumeRoleForWorkloadIdentity` 换取 STS；Policy 不是这套 SDK 的 WAT 请求参数。可按业务需要由可信主应用构造目录级、单个对象或特定操作的策略，最终权限不超过工作负载角色已有权限。浏览器或模型提供的 Policy 不能直接作为授权决策；先校验身份和资源归属，再生成策略。

直接返回 FC 的 `context.credentials` 只是返回执行角色已有凭证，无法给同一份凭证追加按请求生效的范围限制。不过 FC 也可以调用普通 STS `AssumeRole` 并传入 Policy 来收窄权限；这不是 Agent Identity 独有能力。Agent Identity 的额外价值是统一关联 Workload Identity 和入站用户身份，并把相关身份上下文带入云操作审计。参考：[STS AssumeRole 的 Policy](https://help.aliyun.com/zh/ram/developer-reference/api-sts-2015-04-01-assumerole)、[Agent Identity STS 身份与审计](https://help.aliyun.com/zh/agentidentity/obtain-sts-token)。

当前文件服务在 `shared` 模式请求配置前缀的只读权限，`user` 模式请求当前用户目录的只读权限；未来可在完成资源归属检查后进一步限制到单个文件。只读 STS 的策略不会改变黑盒 Agent 的 OSS 挂载权限，后者仍需执行环境约束。

### 推荐：配置同进程 Runloop Broker

1. Runloop 默认开放 `/v1/sts` 并依赖 AgentCore 公网网关鉴权，不要求 Broker HMAC。可选设置 900–3600 秒的 `AGENTCORE_STS_DURATION_SECONDS`。Workload 名称默认读取平台 `agent.yaml` 的 `metadata.runtimeName`（通常为 `<workspaceId>-<agentId>-latest`）；只有需要覆盖时才设置 `AGENTCORE_STS_WORKLOAD_NAME`。
2. 主应用设置 `AGENT_API_BASE_URL=https://<Agent 主机>`；AG-UI 路径默认是 `/ag-ui/agent`，需要时用 `AGENT_API_PATH` 覆盖。`STS_BROKER_URL` 默认无需设置，Chat 自动使用同一 Base 的 `/v1/sts`，并复用现有 `AGENT_API_KEY` 作为网关 `x-api-key`。需要不同 STS 主机或网关凭证时，分别覆盖 `STS_BROKER_URL`、`STS_BROKER_API_KEY`。
3. 若还需要附加 HMAC，再在 Runloop 成对配置 `AGENTCORE_STS_BROKER_KEY_ID/SECRET`，并在 Chat 成对配置对应 `STS_BROKER_KEY_ID/SECRET`。Agent ID 可作为 Key ID，但不能作为 Secret。
4. 为 Agent 部署绑定 Workload Identity；其角色配置业务资源权限上限。Chat 在完成登录与资源归属校验后按请求生成 Policy，继续收窄到用户目录或单一资源。
5. Runloop 从平台挂载读取 region、Controller、SA Token 和 Agent 配置，不需要给 Chat 注入 AK，也不需要部署独立 FC。

## 对话和文件归属

`FILE_ACCESS_MODE` 默认 `user`；显式设为 `shared` 时，所有登录账号可以读取配置 OSS 前缀及其全部子目录中的文件，仍需有效本站会话，路径映射和只读策略仍生效。以下用户目录限制描述的是 `user` 模式。沿用 OSS 挂载、通过可信 shell 工具约束用户目录的设计见 [Agent 文件端到端方案](agent-file-isolation.md)。

上游 `threadId` 和 `X-AgentCore-Session-ID` 由服务端根据用户 ID 与前端 threadId 派生，相同的客户端 threadId 在不同账号下不会复用 Agent 会话。服务端通过 AG-UI 的 `context` 和 `forwardedProps` 提供可信 `uid`、`userId`、`conversationId` 与 `artifactDirectory`；浏览器提交的同名字段不被采用。

当前黑盒没有在探测中向模型暴露这些独立上下文，主应用额外把目录与文件规则附在发往上游的本轮用户输入前，作为提示词过渡；用户界面保留原文。这个做法不提供工具权限保证，详见端到端方案中的提示词过渡说明。

生成文件的路径约定：

```text
/mnt/oss/data/users/<服务端生成的用户命名空间>/<conversationId>/report.pptx
    ↓ OSS 挂载映射
agentcore/ppts/users/<同一用户命名空间>/<conversationId>/report.pptx
```

**Agent 后端验证请求来自可信主应用后，将 uid/conversationId 固定注入本次 MCP 资源上下文。** shell 在 AgenticFS 会话工作区生成文件，`publish_artifact` 只允许从该会话复制到对应 OSS 会话目录，并返回 `/f/<file-id>`；真实相对路径保存在会话目录的 `.files.json`，模型不能通过工具参数覆盖身份。`context` 中的自然语言说明仅用于指引模型，不能作为授权依据。旧的 `/mnt/oss/data/report.pptx` 共享文件不会自动分配给第一个登录用户；需要明确归属后手动迁移到该用户目录。

写入由 shell 操作 AgenticFS 工作目录，再由 `publish_artifact` 通过已有 OSS 挂载完成，无需新增 `PutObject` 上传服务。Runloop 的 STS 端点负责主应用读取文件时的临时凭证；Agent 挂载层的写入权限由其运行环境管理。

应用接口会校验文件路径归属，OSS STS 再限制读取范围。不过传入用户目录的提示本身不能隔离 Agent 的共享文件系统；如果 Agent 工具拥有读取整个挂载目录的权限，后端还需要按用户限制工具路径/独立沙箱，才能防止它直接读取别人的内容并写入聊天回复。本仓库不能代替远端 Agent 工具的权限检查。

聊天记录仍保存在当前浏览器，使用 `agentcore-chat:v1:<用户ID>` 分区，不跨设备同步。旧版无登录的本地记录保留原键，不自动认领。浏览器存储不是加密保险箱；共享设备应使用独立浏览器配置或清理站点数据。

## 验证

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

本地测试覆盖真实 SQLite 会话、密码/撤销/CSRF、签名 OIDC 模拟回调的 nonce/audience/state 校验、用户范围、Runloop STS 协议及缓存隔离、浏览器注册登录与文件渲染。它们不能替代阿里云应用、Workload Identity 权限、OSS bucket 和远端 Agent 输出路径的云端联调。

参考：[阿里云身份提供商](https://help.aliyun.com/zh/agentidentity/alibaba-cloud)、[用户 WAT](https://help.aliyun.com/zh/agentidentity/obtain-workload-access-token)、[STS 会话策略](https://help.aliyun.com/zh/agentidentity/obtain-sts-token)、[Better Auth OIDC](https://better-auth.com/docs/plugins/generic-oauth)。
