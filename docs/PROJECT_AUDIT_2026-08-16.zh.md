# CrossGram 项目审计报告

- 审计日期：2026-08-16
- 审计基线：`469a63a2312033a224b99fb1511305b51a7748c7`
- 审计范围：`crossgram`、`qqnt-bridge`、`crossgram-desktop`
- 审计方式：架构、正确性、安全、测试、发布运维多维只读审查，并运行构建、单元测试、类型检查与 E2E

## 总结

CrossGram 的主链路已经比较完整，QQNT 事件 checkpoint、消息幂等入库、SQLite 投影、MTProto 握手与会话恢复等部分具备较多行为测试。但当前仍存在会导致账号接管、静默丢更新、跨仓库功能失效和坏版本发布的结构性问题。

修复优先级应为：

1. 修复 `auth.bindTempAuthKey` 身份切换绕过。
2. 为登录 token 批准端点增加真实授权边界。
3. 修复重启后的 MTProto update gap。
4. 统一各平台 adapter 的入站事件提交与游标语义。
5. 恢复类型检查和 E2E 全绿，并让发布严格依赖验证成功。

## P0：立即阻塞项

### 1. 无效 `auth.bindTempAuthKey` 可切换到其它永久身份

**严重级别：Critical**

证据：

- `packages/mtproto/src/session/server-session.ts:923-968`
- `packages/bridge/src/index.ts:1205-1225`

服务端会在证明验证完成前，根据请求中的 `permAuthKeyId` 加载并设置永久 key。验证失败后，原实现只记录警告并返回 `boolTrue`，没有恢复此前身份。持有合法临时 key、并获知目标 auth-key ID 的攻击者，可能借此让后续临时 key 流量按目标永久 key 的平台绑定处理。

修复要求：

- 在完整验证 `bind_auth_key_inner` 前不得修改 `_permAuthKey`。
- 验证失败必须返回错误，不能返回 `boolTrue`。
- 验证失败不得持久化临时 key 关联。
- bare 和 wrapped bind 必须通过同一授权状态变更队列串行执行。
- 存储失败不能留下半提交身份或 API layer。

> 状态：本报告落盘时，该问题已在同一变更中修复，并补充单元测试、真实 TCP E2E 和独立安全复核。

### 2. 登录 token 批准端点匿名可用

**严重级别：High；管理端口严格 loopback 时风险降低，但授权缺失仍然存在。**

证据：

- `packages/bridge/src/index.ts:504-558`
- `packages/bridge/src/index.ts:1050-1074`

攻击者可以通过 MTProto 为自己的 key 申请 login token，再调用匿名 `POST /api/login-tokens/:platform/approve`，将 token 批准到任意已 provision 的平台账号。若管理 HTTP 被反代、端口映射、SSRF 访问或处于不可信同机环境，会形成完整平台账号接管。

建议要求 SSO 管理员身份、平台级授权与 CSRF 防护，并在生产配置中显式绑定 loopback。

### 3. 服务重启后会确认并跳过离线更新

**严重级别：High**

证据：

- `packages/bridge/src/update-journal.ts:17-23`
- `packages/bridge/src/message-store.ts:1277-1308`
- `packages/bridge/src/update-manager.ts:829-894`
- `packages/bridge/src/update-manager.test.ts:1610-1631`

`pts/seq/date` 被持久化，但 delivery journal 默认只存在内存。重启后，客户端以旧 `pts` 调用 `updates.getDifference` 时，服务端会返回空更新和已经前进的新 state，导致消息、编辑、撤回、reaction 或已读状态永久不再通过 update 链路恢复。

最小安全修复是：journal 缺失且客户端游标落后时返回正确的 `updates.differenceTooLong`，不能返回空 difference 后推进游标。长期方案是将 delivery outbox 与 state 分配放在同一数据库事务中持久化。

### 4. Matrix、Discord、Satori 不满足统一的入站可靠性契约

证据：

- `packages/platform-matrix/src/index.ts:120-126,379-419`
- `packages/platform-discord/src/index.ts:636-643`
- `packages/platform-satori/src/platform.ts:83-87`
- 正确的 QQNT 对照：`packages/platform-crossgram/src/index.ts:416-430`

Matrix 在 handler 成功前推进 sync token；Discord 与 Satori 会吞掉 handler 异常。数据库临时失败、磁盘满或投影异常时，源平台可能继续前进，而 Bridge 没有可重放的本地记录。

### 5. 主分支验证失败，但发布不受阻

审计时的证据：

- `packages/bridge/src/platform-manager.test.ts:889-895`
- `.github/workflows/test.yml:48-52`
- `.github/workflows/npm.yml:3-39`
- `.github/workflows/tag.yml:29-39`
- `.github/workflows/build.yml:66-79`

审计基线上的类型检查失败；标准 CI 不运行 E2E；nightly、tag、build 和 npm publish 没有依赖测试 workflow 成功。类型错误随后已由主分支提交修复，但发布门禁问题仍存在。

## P1：近期必须修复

### MTProto 密钥生命周期

- `mt_destroy_auth_key` 只返回成功，不删除 key、不清理绑定、不关闭关联会话：
  - `packages/mtproto/src/session/server-session.ts:909-915`
  - `packages/mtproto/src/session/auth-key-store.ts:15-21`
- 临时 PFS key 在已有 TCP 连接中到期后仍可继续使用：
  - `packages/mtproto/src/session/server-session.ts:304-324`
- `auth.signIn` 没有校验 `phoneCodeHash`：
  - `packages/bridge/src/index.ts:641-662`

### 跨仓库通话协议漂移

Core 已调用并文档化 `POST /v1/calls/control`：

- `packages/platform-crossgram/src/client.ts:128-142`
- `packages/platform-crossgram/PROTOCOL.md:101-112`

但审计时的 `qqnt-bridge` 没有该 route，未知路由会返回 404：

- `qqnt-bridge/src/server.ts:272-300,761-762`

因此 Telegram 侧的 QQ 来电接听、拒绝和挂断会失败。两个仓库需要建立固定版本的 contract CI。

### 文件与网络安全边界

- Sticker asset API 接受调用方提供的本地路径或 URL，可能导致本地文件读取和 SSRF：
  - `qqnt-bridge/src/server.ts:430-440`
  - `qqnt-bridge/src/qq-kernel.ts:1633-1686`
- 卡片缩略图 fetch 存在 DNS rebinding SSRF：
  - `packages/bridge/src/card-thumbnail.ts:92-164`
- MTProto listener 缺少 per-connection buffer、frame length、握手超时和连接总量限制：
  - `packages/mtproto/src/transport/server-connection.ts:158-197`

### 平台账号和订阅缺少自动恢复

- `packages/bridge/src/index.ts:481-502,592-628`
- `packages/bridge/client/page.tsx:212-247`
- `packages/platform-matrix/src/index.ts:104-137`
- `packages/bridge/src/platform-manager.ts:189-235`

平台初始化失败后只记录错误，不会自动重试。先启动 CrossGram、后登录 QQ 时，仍需要人工刷新或重启才能恢复账号和订阅。

### 上传临时文件没有完整生命周期

- `packages/bridge/src/upload-manager.ts:26-82`
- `packages/bridge/src/index.ts:750-760`

缺少每账号/全局配额、part 数量与大小限制、TTL、启动回收和 staged metadata 的重启恢复。认证客户端可以持续写入 abandoned upload，导致磁盘或堆内存耗尽。

### QQ 编辑是不可补偿的撤回后重发

- `packages/bridge/src/message-actions.ts:34-50`

撤回成功但重发失败时，旧消息已经不可恢复。需要明确 partial-failure 状态、后台重试或用户可见的补偿入口。

### 大账号分页能力不完整

- Satori dialogs 的 `afterId` 只在当前 100 项中查找：`packages/platform-satori/src/platform.ts:148-183`
- Matrix members 忽略 cursor：`packages/platform-matrix/src/index.ts:307-326`
- Discord 只抓取最多 1,000 个成员，却把局部 cache 当成完整列表：`packages/platform-discord/src/index.ts:380-396,846-864`

不能立即实现完整分页时，应先降级 capability，避免客户端把局部结果理解为完整结果。

## P2：上线前需要明确的边界

### 语音通话不是 crash-safe

- `packages/bridge/src/voice/call-registry.ts:208-220`
- `packages/bridge/src/index.ts:250-258`

通话和 tombstone 都在内存。进程退出或插件卸载时，没有主动向 QQ 挂断，也没有向 Telegram 发布终态。

### Discord 与 Satori 大文件完整进入 Node heap

- `packages/platform-discord/src/index.ts:877-899,1359-1379`
- `packages/platform-satori/src/convert.ts:142-175,217-237`

需要真正流式上传，或至少定义并强制执行硬性文件大小上限。

### 敏感文件权限依赖调用者 umask

- `packages/mtproto/src/session/auth-key-store.ts:98-108`
- `packages/mtproto/src/crypto/rsa-keygen.ts:104-113`

应在创建和更新时显式设置私钥、auth key 文件为 `0600`，敏感目录为 `0700`。

### macOS Desktop 产物未签名和公证

- `crossgram-desktop/.github/workflows/release.yml:669-676,710-724`

正式向普通用户发布时应签名、公证并验证；否则明确标记为 unsigned developer preview。

### 依赖与安装链

- `sharp@0.34.5` 命中高危 libvips advisory，应升级至已修复版本：
  - `packages/platform-crossgram/package.json:12-17`
  - `packages/platform-crossgram/src/media-preview.ts:109-118`
- root 安装脚本下载 latest/动态工件，但缺少 checksum、签名或 provenance 验证：
  - `deploy/install.sh:57-100`
  - `qqnt-bridge/deploy/install.sh:56-59,203-214`

## 文档与测试治理

- README 的系统消息、语音等能力状态与源码存在漂移：`README.md:129-139`
- QQNT 协议文档仍写支持 19–21，代码实际接受 19–22：`packages/platform-crossgram/PROTOCOL.md:10-14`
- `binary-clean:test` 指向不存在的测试文件：`package.json:26`
- Desktop patch E2E 存在，但没有进入默认测试入口：`package.json:28-33`
- 当前没有默认 `yarn test` script，也没有覆盖率配置或覆盖率门槛。

## 审计验证结果

| 检查 | 结果 |
|---|---|
| Build | 通过 |
| Vitest 单元测试 | 93 个文件、979 个测试通过 |
| Node 单元测试 | 19 个通过 |
| TypeScript | 审计基线失败；后续主分支已修复该 fixture 类型错误 |
| 完整 E2E | 19 个文件中 17 个通过；143 个测试中 141 个通过、2 个失败 |
| 性能 E2E | 单独运行通过，固定 wall-clock 阈值存在环境抖动 |
| merged-forward E2E | 单独运行仍稳定失败，实际 URL 已含消息 ID，测试仍期待旧 URL |
| 发布门禁 | E2E 不在标准 CI；nightly/tag/release 不依赖测试成功 |

## 建议执行顺序

1. 修复 `auth.bindTempAuthKey`。
2. 修复匿名登录批准接口。
3. 修复 update restart gap 和 adapter checkpoint 语义。
4. 恢复并保持 typecheck/E2E 全绿，把验证变成发布硬门禁。
5. 建立 CrossGram 与 qqnt-bridge 的 contract CI。
6. 补齐自动恢复、上传配额/GC、事件队列背压和分页。
7. 统一 capability、协议文档和实际测试入口。
