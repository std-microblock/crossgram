# platform-lark

飞书 / Lark 适配器：通过开放平台**自建应用**接入 CrossGram bridge，支持两种模式（`mode` 配置项）：

| | `mode: bot`（默认） | `mode: user` |
|---|---|---|
| 接收 | WS 长连接事件订阅（机器人需进群） | **轮询** `im/v1/messages`（按会话增量，默认 60s） |
| 发送 | 机器人身份（tenant_access_token） | 登录用户本人身份（user_access_token，OAuth 授权） |
| 前置条件 | 应用开启机器人能力、拉 bot 进群 | OAuth 授权（需公网回调地址）+ `get_as_user` 系列权限 |
| 单聊 | ✓（用户给机器人发私信） | ✗（无公开的单聊会话发现接口，仅群聊） |
| 凭据 | 无需持久化 | 存 bridge 数据库 `mtproto_platform_session.credentials` |

## 配置

```yaml
- id: lark
  name: '@mtproto-relay/platform-lark'
  config:
    appId: cli_xxx
    appSecret: xxx
    # mode: user              # 用户身份收发（默认 bot）
    # baseUrl: https://open.larksuite.com   # Lark 国际版
    # publicUrl: https://relay.example.com  # user 模式：OAuth 回调公网地址
    # pollIntervalMs: 60000   # user 模式：轮询间隔
```

## 开放平台设置步骤

1. [开放平台](https://open.feishu.cn/) 创建**企业自建应用**，记录 `App ID` / `App Secret`
2. **应用功能 → 机器人**：开启机器人能力（两种模式都需要；bot 模式的身份、user 模式的事件通道都依赖它）
3. **权限管理**按模式开通：

   **bot 模式**：
   - `im:message:send_as_bot`（以应用的身份发消息）
   - `im:message.group_at_msg:readonly`（接收 @机器人 消息，普通权限即开即用）
   - `im:message.group_msg`（获取群组中所有消息，**敏感权限**，需管理员审批——收全量群消息的硬前提；未生效时适配器启动会提示"仅 @机器人"可见，群内其他消息不被桥接）
   - `im:message.p2p_msg:readonly`（单聊接收）
   - `im:resource`（上传/下载图片、文件）
   - `im:chat:readonly`（会话列表/群详情）

   **user 模式**：
   - 发送：`im:message` + `im:message.send_as_user`（**两个同时开**）
   - 历史（轮询）：`im:message` + `im:message.group_msg:get_as_user`（群聊）
   - `im:resource`（上传/下载媒体）
   - `im:chat:readonly`（会话列表/群详情）
4. **事件与回调**（bot 模式）→ 订阅方式切换为**使用长连接接收事件**，添加事件：
   - `im.message.receive_v1`（接收消息）
   - `im.message.message-recalled_v1`（消息撤回）
   - `im.message.reaction.created_v1` / `im.message.reaction.deleted_v1`（表情回应，可选）
   > 注意：切换长连接方式前需先用本适配器启动一次建立连接，否则控制台无法保存
5. **user 模式**：安全设置添加重定向 URL `<publicUrl>/lark/<id>/oauth/callback`；启动后日志会打印授权链接
6. 发布应用版本并等待企业管理员通过
7. **bot 模式**：把机器人拉进需要桥接的群（或给机器人发首条私信）
8. **user 模式**：无需拉 bot 进群（轮询可见性＝你本人所在的群）

## 已知限制

- bot 模式：群消息事件不包含机器人自己发的消息（以 bot 身份发送的消息无回显，正常）
- 表情回应：仅支持内置映射表内的常用 emoji（约 30 个，语义确定项）；飞书自有表情无官方 Unicode 对照，未映射项显示为 `[KEY]`、发送时忽略
- user 模式：仅群聊；轮询延迟最高一个 `pollIntervalMs`；会话多时注意 API 配额（全局 1000 次/分钟）
- user 模式：refresh_token 每次刷新轮换；若刷新持久化间隙进程崩溃，需要重新授权
- 不支持：消息编辑、已读同步、贴纸、转发、语音通话

## 故障排查

- `230002 Bot is not in the chat`（bot 模式收不到某群）→ 机器人不在该群
- 控制台无法保存长连接订阅方式 → 先启动一次本适配器让 SDK 建立连接
- user 模式发送报权限错误 → 核对 `im:message` 与 `im:message.send_as_user` 是否**都**已开通
