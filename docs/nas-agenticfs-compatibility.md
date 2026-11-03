# NAS / AgenticFS 共享文件预览

应用支持 OSS 和 NAS 两种后端，当前本地配置已选择 `nas` + `shared`。Agent 交付路径为 `/mnt/agenticfs/shared/...`，所有已登录用户可以预览和下载该共享工作区的文件。图片、PPTX、DOCX、PDF、文本等继续使用现有 `/api/files` 与 `/api/files/content` 接口。

Agent 写入 NAS 已由用户确认正常；本次接入目标是 Chat 读取现有文件、预览和下载。真实读取验证应使用一个已有文件，不要求 Agent 重新生成或调整现有 NAS 写入部署。

## 当前资源与环境变量

所有 NAS 配置只在服务端使用，不加 `NEXT_PUBLIC_`。以下均为示例值，请按自己的 NAS 资源配置到 `.env.local`：

| 变量 | 示例值 | 用途 |
| --- | --- | --- |
| `FILE_STORAGE_BACKEND` | `nas` | 选择 NAS 文件读取后端；省略时仍为 OSS |
| `FILE_ACCESS_MODE` | `shared` | 已登录账号共享读取 |
| `NAS_FILE_SYSTEM_ID` | `examplefs123` | 构造 NAS 文件系统资源 ARN |
| `NAS_AGENTIC_SPACE_ID` | `agentic-example123` | 保留工作空间标识，供部署核对；文件读取不直接使用此 ID |
| `NAS_ACCESS_POINT_ID` | `ap-example123` | 构造接入点 ARN，限制 STS 可挂载入口 |
| `NAS_REGION` | `cn-hangzhou` | 来自已提供的接入点域名 |
| `NAS_ACCOUNT_ID` | `1234567890123456` | NAS 所属主账号 UID，用于文件系统与接入点 ARN |
| `NAS_ACCESS_POINT_DOMAIN` | `ap-example123.examplefs123-example.cn-hangzhou.nas.aliyuncs.com` | 实际 NFS 挂载地址，不是 HTTP URL |
| `NAS_ACCESS_POINT_PATH` | `/agentcore/share` | 新 Agent 返回的 NFS 挂载来源路径；待读取端云上验证 |
| `NAS_MOUNT_BASE` | `/tmp/agentcore-nas` | 文件服务创建临时只读挂载和凭证文件的私有父目录 |

2026-09-20 通过新 Agent 接口生成测试文件，Agent 返回的挂载来源是该接入点的 `:/agentcore/share`，因此本地读取配置已修正为 `NAS_ACCESS_POINT_PATH=/agentcore/share`。Agent 可见目录仍为 `/mnt/agenticfs/shared`。应用只读取已存在的内容，不自动创建远端目录或迁移旧文件。

## 保留现有身份和 STS 授权链路

```mermaid
flowchart LR
  B[浏览器：NAS 文件路径] --> A[Next.js：验证本站会话和路径范围]
  A --> I[现有 getUserIdentity]
  I --> S[Runloop STS Broker / Agent Identity]
  S --> M[用户 STS + NAS 只读策略 → 临时 NFS 挂载]
  M --> F[读取文件并返回预览 / 下载]
  F --> C[流结束或取消 → 关闭文件并卸载]
```

`AGENT_IDENTITY_AUTH_MODE`、登录方式、Broker URL 与按身份/策略缓存 STS 的机制继续使用现有实现。NAS 请求传入原登录用户的 `userId` 或 JWT，不退回机器身份、长期 AK/SK 或旧 OSS 凭证。Runloop Broker 默认依赖 AgentCore 网关鉴权，可选附加 HMAC，并继续只处理通用身份和 Policy，无需加入 NAS 文件读取逻辑。

资源策略由 `oss:GetObject` 改为 `nas:ClientMount`，限定到当前文件系统，并用 `nas:AccessPointArn` 条件限定接入点。主应用生成相同范围的会话策略，实际权限与 Workload Identity 运行时 RAM 角色权限取交集。部署模板见 [workload-nas-read.json](../deploy/nas/workload-nas-read.json)。将 `YOUR_REGION` 和 `YOUR_ACCOUNT_ID` 替换后，附加到 **Broker 最终获取 STS 所对应的运行时角色**，不是仅修改 FC 执行角色。

请将策略模板中的区域、账号、文件系统和接入点标识全部替换为自己的资源；示例值不可直接用于部署。

NAS 的挂载/读取权限属于接入点粒度，不是 OSS 对象前缀授权。本次选择一个共享 AgenticSpace，应用仅接受 `/mnt/agenticfs/shared/` 下的文件引用。即使将来使用 `FILE_ACCESS_MODE=user`，应用的目录校验也不能代替每用户独立接入点/AgenticSpace 的云端隔离；目前仅按共享场景部署。

每个文件请求使用该用户的 STS 写入独立、权限 `0600` 的凭证文件，再交给 `mount.alinas`。凭证不会放入命令行参数、日志、浏览器响应或 Agent 消息。挂载选项包含 `tls,vers=3,ram,ro,nosuid,nodev,noexec,nosharecache`。服务端读完、报错或浏览器取消时关闭文件、卸载并删除临时凭证；不会递归删除挂载目录。

## Linux 部署要求

1. 文件读取服务在与接入点连通的 VPC Linux 环境中运行，启用接入点 RAM 授权及 TLS，并放行所需网络访问。仅在同 VPC 并不表示已经具备挂载能力。
2. 安装官方 ALINAS 客户端及 NFS 依赖，确保 `/bin/mount` 能调用 `mount.alinas`、`/bin/umount` 可用。运行服务的容器/进程必须拥有其挂载命名空间内的 NFS 挂载与卸载权限；普通无挂载权限的容器会返回 `NAS_MOUNT_FAILED`。在专用 Linux 服务/容器中部署此读取逻辑，并保持 `/proc/self/fd` 可用。
3. `NAS_ACCOUNT_ID` 已填入本地配置，部署时同步此配置；给 Chat 读取所用的运行时角色附加 NAS 只读策略，确认接入点策略也允许该角色。Agent 的写入授权与 Chat 的读取授权分别核对。默认不授予 `nas:ClientWrite` 或 `nas:ClientRootAccess`。如果文件返回无权限，核对接入点 POSIX 用户和文件/目录读取、遍历权限；不要直接扩大为 NAS 全权限。
4. `NAS_MOUNT_BASE` 必须由服务运行账号拥有、权限 `0700`；不能指向 Agent 的数据目录。临时挂载与 Agent 的现有挂载分离，不会卸载 Agent 工作区。
5. 核对 `NAS_ACCESS_POINT_PATH` 的实际对应关系，重启服务后，用一个真实已生成文件从聊天页面进行预览和下载联调。Mac 本地运行会返回 `503 / NAS_REQUIRES_LINUX`，不会把本地同名目录当作 NAS。

当前采用每请求临时挂载以保留用户 STS 的实际使用，元信息和内容请求各需一次挂载，有额外延迟；每进程最多 16 个在途挂载，超限返回 `NAS_BUSY`。首次上线应验证实际延迟、并发、取消及客户端的凭证处理行为，再决定是否按身份和授权范围复用挂载。STS 仍由现有 Broker 客户端缓存和提前刷新。

进程被强制杀死、主机掉线或卸载失败时，可能留下临时挂载和凭证。优先用服务专属的 mount namespace 和临时卷管理生命周期；出现清理失败日志时由运维核对该目录，先卸载再删除，不能对仍挂载的目录运行递归删除。

## 路径、预览与旧文件

Chat 传入的输出约定已更新为本轮 `artifactDirectory`。在 NAS 模式，它是 `/mnt/agenticfs/shared/<uid>/<conversationId>`；`uid` 是登录用户稳定命名空间，`conversationId` 是用户作用域化的上游 threadId。`forwardedProps` 同时发送这两个字段供 Runloop 建立同样的挂载边界。若旧静态提示词仍强制 `/mnt/oss/data`，按 [办公助手提示词](../prompts/office-assistant.txt) 更新路径约定。

### 客户端上传输入文件

上传输入和 Agent 生成的产物使用同一个用户/会话归属，但输入固定放在 `uploads` 子目录。浏览器先向 Chat 服务端申请由登录身份派生的上传位置，再直传 OSS；文件字节不进入聊天请求或 Runloop 请求。

```text
OSS object:
  <OSS_OBJECT_PREFIX>/users/<uid>/<conversationId>/uploads/<uploadId>/<safeFilename>

Runloop 宿主盘物化位置：
  /mnt/agenticfs/shared/<uid>/<conversationId>/uploads/<uploadId>/<safeFilename>

Agent 内可见位置：
  /workspace/uploads/<uploadId>/<safeFilename>
```

`uid`、`conversationId`、`uploadId` 和完整 object key 均由 Chat 服务端生成；浏览器只提交原文件名和内容类型。上传完成后，消息只保存 `oss://bucket/object`、OSS 返回的 ETag 与 region。每次发起对话时，Chat 服务端再为已确认对象签发 10 分钟有效的单对象 GET URL，并放入仅供 Harness 使用的 `forwardedProps.attachmentDownloads`；签名 URL 不进入消息或模型上下文。Runloop 校验 OSS 主机、当前会话前缀和 ETag 后以 `If-Match` 下载，再把引用改写为当前会话 `uploads/...` 的本地绝对路径。图片随后调用 `view_image`，参考图生成通过 `referenced_image_paths` 使用同一路径；其他文件通过受控文件工具读取。

前端调用 `POST /api/uploads` 的 `create` 操作取得 10 分钟有效、仅允许写一个对象的 PUT URL，随后从浏览器直接 PUT 到 OSS；完成后调用同一接口的 `confirm` 操作。服务端通过 HEAD 核对对象大小、类型与 ETag，再把不可变引用交给聊天消息。bucket CORS 需允许 `BETTER_AUTH_URL` 对应 Origin 的 `PUT` 与 `Content-Type` 请求头；不要求暴露 ETag。取消或失败留下的未确认对象由 OSS 生命周期规则定期清理。

```text
Agent: /mnt/agenticfs/shared/<uid>/<conversationId>/reports/季度报告.pdf
API:   /api/files/content?path=<上述完整路径>
NFS:   <接入点域名>:<NAS_ACCESS_POINT_PATH>/reports/季度报告.pdf
```

服务端拒绝路径穿越、编码分隔符、符号链接和非普通文件；Linux 上还检查打开后的文件描述符路径。支持 `HEAD`、单段 `Range`、大文件流式下载和请求取消，沿用原有预览大小限制。NAS 文件在元信息检查和打开之间变化时返回 `FILE_CHANGED`；生成端应完成写入后再交付，推荐通过同目录临时文件加原子重命名发布，不能把读取中的原地改写当作不可变快照。

旧 `/mnt/oss/data/...` 链接仍能被页面识别，但 NAS 模式会明确返回 `STORAGE_PATH_MISMATCH`，不会把旧路径静默映射到 NAS 的同名文件。历史文件需单独迁移并使用新路径；切回 `FILE_STORAGE_BACKEND=oss` 可继续走原 OSS 读取链路。

## 验证范围

历史联调中，Agent AG-UI 调用成功（HTTP 200），返回的测试文件引用能被 Chat 识别；Mac 运行环境的文件接口返回 `503 / NAS_REQUIRES_LINUX`，尚未由 Chat 独立读回文件字节。真实资源地址、测试文件标识和联调记录不随开源源码发布。复测记录位于 `artifacts/nas-live-read.json`，仅供本地检查，不应提交或公开分享，其中可能包含 Agent 回复和挂载来源。

可手动运行 `node --import tsx scripts/smoke-nas.ts` 复测：通过真实 Chat handler 和临时登录账号，让 Agent 在共享目录独占创建一个唯一命名的小 TXT，再请求文件元信息和内容并验证字节。每次运行会创建一个新测试文件，不删除远端文件；文件读取失败会以非零状态退出。

`/ag-ui/agent` 是 Agent 对话入口，不是本站 `/api/files` 文件读取入口。如果 Chat 继续在 Mac 本地运行，需要另外提供 VPC 内的受鉴权文件读取服务（或接入受支持的沙箱文件 API）；也可将 Chat 后端部署到具备上述挂载能力的 VPC Linux 环境。当前代码尚未实现 HTTP 文件网关。

本地测试覆盖资源/接入点策略、身份传递、私有 STS 文件、只读挂载命令及清理、NAS 路径识别、共享和用户目录校验、元信息/Range/空文件/取消/符号链接/更新检测。浏览器测试覆盖新路径图片的展示、放大、下载链接和历史恢复。

挂载命令在本地测试中使用替身，文件内容来自临时目录，浏览器文件接口使用测试响应。这些检查不等于已验证真实 Linux NFS、接入点 RAM 策略、VPC 网络或该 AgenticSpace 的文件。云端联调需在上述部署条件满足后执行。

## 官方依据

- [AgenticFS 概述](https://help.aliyun.com/zh/nas/product-overview/agenticfs-overview)：AgenticFS / AgenticSpace 模型与 NFSv3。
- [管理 AgenticSpace](https://www.alibabacloud.com/help/zh/nas/user-guide/manage-agenticspace)：AgenticSpace 接入点与 VPC 挂载限制，当前根文件系统不能直接挂载。
- [接入点 RAM 策略](https://help.aliyun.com/zh/nas/user-guide/management-access-point)：`nas:ClientMount` 表示挂载/读取，写入与 root 访问是独立权限。
- [通过接入点挂载](https://help.aliyun.com/zh/nas/user-guide/linux-system-accesses-file-system-through-access-point)：TLS、STS 凭证文件及 `ram_config_file` 用法。
