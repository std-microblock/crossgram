# platform-lark

飞书 / Lark 适配器：通过开放平台**自建应用 + OAuth 用户授权**，把用户的飞书账号接入 CrossGram bridge（Telegram 侧以该用户身份收发消息）。

- 收消息：应用 WebSocket 长连接事件订阅（`im.message.receive_v1`），需开启**敏感权限** `im:message.group_msg`（获取群组中所有消息），并把机器人拉进群
- 发消息：`user_access_token` 以登录用户本人身份发送（支持文本、图片、文件、语音、回复引用）
- 单聊（p2p）：用户先给机器人发一条消息后即可互通

## 配置

```yaml
- id: lark
  name: '@mtproto-relay/platform-lark'
  config:
    appId: cli_xxx
    appSecret: xxx
    # baseUrl: https://open.larksuite.com   # Lark 国际版
    # publicUrl: https://relay.example.com  # 公网地址，用于 OAuth 回调
```

## 开放平台设置步骤

1. [开放平台](https://open.feishu.cn/) 创建**企业自建应用**，记录 `App ID` / `App Secret`
2. **权限管理**开通（用户身份接口有专用权限点，缺一不可）：
   - 发送（用户身份）：`im:message` + `im:message.send_as_user`（**两个同时开**）
   - 历史消息（用户身份）：`im:message` + `im:message.group_msg:get_as_user`（群聊）/ `im:message.p2p_msg:get_as_user`（单聊）
   - 事件推送：`im:message.group_msg`（获取群组中所有消息，**敏感权限**，需管理员审批——收全量群消息的硬前提）、`im:message.p2p_msg:readonly`（单聊接收）
   - 媒体上传/下载：`im:resource`
   - 会话列表/群详情：`im:chat:readonly`
   - 撤回：`im:message`（已含在发送条目中）
3. **安全设置**添加重定向 URL：`<publicUrl>/lark/<id>/oauth/callback`
4. **事件与回调** → 订阅方式切换为**使用长连接接收事件**，添加事件：
   - `im.message.receive_v1`（接收消息）
   - `im.message.message-recalled_v1`（消息撤回）
   > 注意：切换长连接方式前需先用本适配器启动一次建立连接，否则控制台无法保存
5. 发布应用版本并等待企业管理员通过
6. 启动 CrossGram，日志会打印授权链接，浏览器打开完成 OAuth 授权
7. 把机器人拉进需要桥接的群（或给机器人发首条私信）。**机器人进群只是为了接收事件**；发送走用户身份（user_access_token），只要求你本人在群里

## 已知限制

- 群消息事件不包含机器人（应用）自己发的消息；本适配器以用户身份发送，不受影响
- 不支持：消息编辑、表情回应、已读同步、贴纸、转发、语音通话
- refresh_token 每次刷新轮换；若刷新持久化间隙进程崩溃，需要重新授权
- 会话列表（`im/v1/chats`）只含群聊；单聊会话在收到首条消息后出现
- OAuth 凭据持久化在 bridge 数据库 `mtproto_platform_session.credentials`，随 `cordis.db` 一起备份
