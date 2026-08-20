# platform-crossgram ↔ qqnt-bridge 协议

本文档描述 `platform-crossgram`（QQNT `IMPlatform` 适配器）与本地
`qqnt-bridge` 服务之间的完整线上协议。协议包括三部分：

1. **HTTP JSON API** —— 会话、消息、媒体、贴纸、表情回应、好友/群申请、登录等。
2. **WebSocket 事件流** —— 服务端主动推送消息、撤回、回应、通话信号等事件。
3. **本地 Unix socket PCM 媒体通道** —— 语音通话的 48 kHz s16le 音频帧传输。

协议版本由 `qqnt-bridge` 在 `/v1/status` 中返回，当前服务端版本为
`26`。`platform-crossgram` 适配器当前支持的版本范围为 `19` 到 `26`；
高于或低于该范围的版本会被适配器拒绝。两个仓库的协议类型定义分别在
`packages/platform-crossgram/src/protocol.ts`（适配器侧，`Wire*` 类型）
与 `qqnt-bridge/src/protocol.ts`（服务端侧，`QQ*` 类型）中。

---

## 1. 传输与认证

### 1.1 基础 URL

`qqnt-bridge` 默认监听：

```text
http://127.0.0.1:18767/v1
```

`platform-crossgram` 通过配置项 `endpoint` 指定该地址，未配置时使用上面的
默认值。所有 HTTP API 均以 `/v1/...` 开头。

### 1.2 WebSocket 事件 URL

事件流默认从 `endpoint` 推导：

```text
ws://127.0.0.1:18767/v1/events/ws
```

配置项 `webSocketEndpoint` 可以把事件流指向不同主机或路径，而 HTTP API
仍使用 `endpoint`。WebSocket 连接可以通过查询参数 `lastEventId` 指定
事件游标，从该事件之后开始重放；如果游标已过期，服务端会重放最近保留
的事件，并通过日志说明丢弃数量。

### 1.3 认证

`qqnt-bridge` 可以配置一个共享 token。配置后，所有 HTTP 请求必须携带：

```text
Authorization: Bearer <token>
```

WebSocket 握手也必须携带相同的 `Authorization` 头。未配置 token 时认证
不启用。HTTP 401 响应体为：

```json
{ "error": "unauthorized" }
```

### 1.4 通用响应约定

- JSON 请求与响应均使用 `content-type: application/json; charset=utf-8`。
- 错误响应统一为 `{ "error": "<message>" }`。
- 涉及历史、会话列表等可缓存响应会返回 `ETag`，并支持
  `If-None-Match` 返回 `304 Not Modified`。
- 大 JSON 请求体有 1 MiB 限制，超过会返回 500。
- 内核未就绪时返回 `503`，响应体为 `{ "error": "QQNT kernel is not ready" }`。

---

## 2. HTTP API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/status` | 服务端状态与协议版本 |
| GET | `/v1/login/status` | 登录状态 |
| GET | `/v1/login/qrcode.png` | 登录二维码图片 |
| GET | `/v1/login/qrcode/url` | 登录二维码文本 URL |
| POST | `/v1/login/qrcode/refresh` | 刷新登录二维码 |
| GET | `/v1/group-join/probe` | 群加入契约探测（需 token） |
| GET | `/v1/dialogs` | 会话列表 |
| GET | `/v1/contacts` | 联系人列表 |
| GET | `/v1/conversations/resolve` | 按 QQ 号/群号解析会话 |
| GET | `/v1/conversations/:id` | 会话详情 |
| GET | `/v1/conversations/:id/history` | 拉取历史消息 |
| GET | `/v1/conversations/:id/search` | 搜索会话内消息 |
| GET | `/v1/conversations/:id/members` | 群成员列表 |
| POST | `/v1/conversations/:chatType/:peerUin/notification-mask` | 设置群消息通知屏蔽 |
| GET | `/v1/stickers/packs` | 贴纸包列表 |
| GET | `/v1/stickers/packs/:packId` | 贴纸包详情 |
| GET | `/v1/stickers/saved` | 已收藏贴纸 |
| GET | `/v1/stickers/:stickerId` | 单个贴纸元数据 |
| POST | `/v1/stickers/saved` | 收藏/取消收藏贴纸 |
| POST | `/v1/stickers/asset` | 拉取贴纸资源字节 |
| POST | `/v1/uploads/prepare` | 准备媒体上传（CDN/Highway） |
| POST | `/v1/messages` | 发送消息（可带流式媒体体） |
| POST | `/v1/messages/delete` | 撤回消息 |
| POST | `/v1/messages/get` | 按 ID 取单条消息 |
| POST | `/v1/messages/multi-forward` | 读取合并转发内容 |
| POST | `/v1/messages/forward` | 转发消息 |
| POST | `/v1/messages/read` | 标记已读 |
| GET | `/v1/messages/reactions` | 读取消息回应状态 |
| GET | `/v1/messages/reactions/list` | 读取回应成员分页 |
| POST | `/v1/messages/reactions` | 设置消息回应 |
| GET | `/v1/reactions/catalog` | 回应定义目录 |
| POST | `/v1/reactions/asset` | 拉取自定义回应资源字节 |
| GET | `/v1/requests` | 好友/群加入申请分页 |
| POST | `/v1/requests/:id/resolve` | 同意/拒绝申请 |
| GET | `/v1/users/:uid` | 用户信息 |
| POST | `/v1/files/direct-url` | 获取 QQ CDN 直链 |
| POST | `/v1/files/asset` | 拉取 QQ 媒体资源字节 |
| POST | `/v1/calls/media-lease` | 获取语音通话 PCM 媒体租约 |
| POST | `/v1/calls/control` | 控制语音通话（接听/拒绝/挂断） |

---

## 3. 核心数据模型

### 3.1 会话 `conversation`

```ts
interface WireConversation {
  id: string
  kind: 'direct' | 'group'
  title: string
  peerUid: string
  peerUin: string
  chatType: 1 | 2            // 1 好友，2 群
  groupMsgMask?: 0 | 1 | 2 | 3 | 4
  avatarUrl?: string
  avatar?: WireMedia
  participantCount?: number
  selfRole?: 'owner' | 'administrator' | 'member'
  unreadCount?: number
  lastMessage?: WireMessage
  firstUnread?: { msgSeq: string, msgTime: string }
  readInboxMaxMessage?: WireMessage
}
```

`id` 即 QQ 的 `peerUid`，对好友和群都稳定且不透明。旧版本可能在 ID 前
加 `1:` 或 `2:` 前缀，服务端 `parseConversationId` 仍会接受这种旧格式。
`chatType` 为 1（好友）或 2（群）。`groupMsgMask` 是 QQ 群消息通知策略：

- `0` 未指定
- `1` 通知
- `2` 群助手
- `3` 屏蔽
- `4` 静默接收

### 3.2 消息 `message`

```ts
interface WireMessage {
  id: string
  sourceIds?: string[]
  conversationId: string
  senderId: string
  timestamp: number
  outgoing: boolean
  sender?: {
    id: string
    numericId?: string
    name: string
    alias?: string
    avatar?: WireMedia
  }
  msgSeq?: string
  telegramMessageId?: number
  telegramReplyToMessageId?: number
  originRequestId?: string
  replyToId?: string
  serviceAction?: { type: 'custom', text: string }
  parts: Array<
    | WireTextPart
    | { type: 'markdown', content: string }
    | { type: 'inline-keyboard', keyboard: WireInlineKeyboard }
    | { type: 'media', media: WireMedia }
    | { type: 'sticker', sticker: WireSticker }
    | { type: 'multi-forward', title: string, preview?: string, locator: WireMultiForwardLocator }
    | { type: 'card', card: WireCard }
  >
  reactionContext?: WireReactionState
}
```

文本片段：

```ts
interface WireTextPart {
  type: 'text'
  text: string
  entities?: Array<
    | { type: 'mention', offset: number, length: number, userId: string, numericId?: string }
    | { type: 'qq-face', offset: number, length: number, faceId: string, faceType: number }
  >
}
```

### 3.3 媒体 `media` 与定位器 `locator`

```ts
interface WireMedia {
  id: string
  kind: 'image' | 'file'
  name?: string
  mimeType?: string
  size?: number
  width?: number
  height?: number
  duration?: number
  voice?: boolean
  preview?: {
    mimeType?: string
    size: number
    width: number
    height: number
    locator: QQMediaLocator
  }
  locator: QQMediaLocator
}
```

`locator` 是媒体下载的唯一凭据，字段如下：

```ts
interface QQMediaLocator {
  messageId: string
  elementId: string
  chatType: 1 | 2
  peerUid: string
  kind: 'image' | 'file' | 'voice'
  fileName: string
  fileSize?: string
  filePath?: string
  fileUuid?: string
  fileSubId?: string
  fileBizId?: number
  md5?: string
  sha?: string
  sha3?: string
  file10MMd5?: string
  originImageUrl?: string
  imageSpec?: 0 | 198 | 720
  videoCodecFormat?: number
  avatarUin?: string
  avatarUrl?: string
  previewKey?: string
  cachedPath?: string
  deferred?: true
}
```

关键字段说明：

- `kind` 为 `image` 时可通过 `imageSpec` 选择原图（`0`）或 QQ 原生
  缩略图规格（`198`、`720`）。
- `originImageUrl` 是 QQ 原始 CDN URL。当其中的 RKey 过期时，服务端可
  通过 OIDB `OidbSvcTrpcTcp.0x9067_202` 刷新私聊/群聊 RKey 后返回新直链。
- `file10MMd5` 是文件前 10 MiB 的 MD5，QQ 私有文件 CDN API 需要。
- `videoCodecFormat` 仅对原生 QQ 视频元素出现，`0` 为 H.264，`1` 为
  H.265。
- `avatarUrl` 是 QQNT 按 UID 返回的头像直链，优先级高于 `avatarUin`。
- `avatarUin` 用于 QQNT 没有返回 UID 头像直链时，通过固定 qlogo 端点回退，不经过 bridge 下载。
- `deferred` 表示这是历史消息中的占位媒体，字节在适配器通过
  message-edit 事件发布后才能获取。

### 3.4 贴纸 `sticker`

贴纸引用分三类：

- `sysface`：QQ 系统表情（黄脸），`faceId` + `faceType` + `animated: true`。
- `market`：商城贴纸，`packageId` + `stickerId` + `key`，可能包含
  `staticPath`、`dynamicPath` 和 `mimeType`（gif/apng/png）。
- `favorite`：收藏贴纸，`resId` + `path` + `md5`，可能带 `locator`。

贴纸元数据：

```ts
interface WireSticker {
  stickerId: string
  packId?: string
  title?: string
  format: 'static' | 'animated'
  mimeType: string
  width?: number
  height?: number
  size?: number
  version?: number
  reference: QQStickerReference
}
```

### 3.5 表情回应 `reaction`

回应目录 `WireReactionContext` 包含 `available: WireReactionDefinition[]`、
当前消息回应状态 `reactions` 和 `maxSelected`。自定义回应的资源定位器是
`{ reactionKey: string }`，只能通过 `/v1/reactions/asset` 获取字节。
`recentActors` 只包含不透明 `userId`，QQNT 不提供回应时间戳。

### 3.6 申请 `request`

```ts
interface WireRequest {
  id: string
  kind: 'friend' | 'group-join'
  status: 'pending' | 'accepted' | 'rejected'
  requester: { id: string, name?: string }
  group?: { id: string, name?: string }
  message?: string
  timestamp?: string | number
}
```

---

## 4. HTTP API 细节

### 4.1 状态：`GET /v1/status`

```json
{
  "protocolVersion": 22,
  "ready": true,
  "selfUin": "10001",
  "selfUid": "u_xxxx"
}
```

`ready` 为 `false` 时，除登录、状态和 `group-join/probe` 外的 API 返回
`503`。`protocolVersion` 是协议版本，适配器用它在运行时决定能力。

### 4.2 会话与联系人

`GET /v1/dialogs` 查询参数：

- `cursor`：分页游标
- `limit`：每页数量，默认 100
- `afterId`：按会话 ID 增量拉取

返回 `{ conversations, nextCursor?, total? }`，支持 `ETag`/`304`。

`GET /v1/contacts` 查询参数：

- `cursor`
- `limit`（默认 500）

返回 `{ users, nextCursor? }`，`users` 元素含 `id`、`numericId`、`name`、
`signature?`、`avatar?`。

`GET /v1/conversations/resolve?kind=group|friend&id=<QQ号或群号>` 按数字
QQ 号解析会话。`kind` 为 `group` 时解析群，否则解析好友。

`GET /v1/conversations/:id/history` 查询参数：

- `cursor`
- `beforeId` / `afterId`
- `aroundUnreadSeq`：定位到未读边界
- `limit`（默认 50）

返回 `{ messages, nextCursor? }`。

`GET /v1/conversations/:id/search` 查询参数：

- `q`：关键词
- `cursor` / `limit`（默认 50）
- `fromUserId`
- `minTimestamp` / `maxTimestamp`
- `mediaKind`：`image` 或 `file`

返回 `{ messages, nextCursor? }`。

`GET /v1/conversations/:id/members` 查询参数：

- `cursor`
- `limit`（默认 100）

返回 `{ members, total?, nextCursor? }`。

### 4.3 发送消息：`POST /v1/messages`

发送请求使用自定义头 `x-qqnt-manifest`，值为 `base64url(JSON.stringify(SendManifest))`：

```ts
interface SendManifest {
  conversationId: string
  text?: string
  textParts?: QQTextPart[]
  replyToId?: string
  replyToSequence?: string
  originRequestId?: string
  sticker?: QQStickerReference
  mediaFraming?: 'length-prefixed-v1'
  media?: QQSendMediaSpec[]
  uploadedMedia?: QQPreparedMedia[]
}
```

消息体分两种情况：

1. **普通消息**：`content-length: 0`（空 body），媒体元数据在
   `media` 中，已上传的 CDN 元数据在 `uploadedMedia` 中。
2. **流式语音消息**：协议 21 起支持。`mediaFraming` 为
   `length-prefixed-v1` 时 body 直接是音频字节流；适配器侧发送纯 PTT
   `voice` 媒体时使用流式 body，服务端边收边转码。语音请求体超过服务端
   限制会返回 `413`。

发送结果返回完整 `WireMessage`。当 QQNT 对本次发送返回永久拒绝时，服务端
返回 `403`，适配器将识别该错误并不再重试。

### 4.4 上传准备：`POST /v1/uploads/prepare`

请求：

```json
{
  "conversationId": "u_xxx",
  "media": {
    "kind": "image",
    "name": "photo.jpg",
    "mimeType": "image/jpeg",
    "size": 12345,
    "md5": "...",
    "sha1": "...",
    "file10MMd5": "...",
    "width": 100,
    "height": 200,
    "duration": 0
  }
}
```

返回 `QQMediaUploadPlan`：

```ts
{
  prepared: {
    kind: 'image',
    fileUuid: '...',
    msgInfo: '...'
  } | {
    kind: 'file',
    fileUuid: '...',
    fileHash?: '...',
    exists: boolean,
    commandId: 71 | 95
  },
  highway?: {
    servers: Array<{ host: string, port: number }>,
    ticket: string,
    extendInfo: string,
    selfUin: string,
    commandId: number,
    sequenceStart: number,
    blockSize: number,
    fileSize: number,
    fileMd5: string
  }
}
```

`highway` 存在时，适配器把文件字节直接上传到 QQ Highway 服务器；上传完成
后把 `prepared` 作为 `uploadedMedia` 写入发送清单。`highway` 不存在表示 QQ
报告文件字节已存在 CDN，无需实际上传。适配器会校验 Highway 返回的
`fileSize` 和 `fileMd5` 与本地一致。

### 4.5 QQ 闪传复用/上传：`POST /v1/flash-transfers`

请求头 `x-qqnt-flash-manifest` 是 base64url 编码的 JSON：

```json
{
  "name": "Telegram files",
  "framing": "length-prefixed-v1",
  "files": [
    {
      "source": "qq-media",
      "name": "alpha.txt",
      "size": 5,
      "locator": { "messageId": "...", "elementId": "...", "chatType": 1, "peerUid": "...", "kind": "file", "fileName": "alpha.txt" }
    },
    { "source": "upload", "name": "beta.bin", "size": 3 }
  ]
}
```

body 只对 `source: "upload"` 的文件使用与多媒体发送相同的 4 字节大端长度分帧，
并用零长度帧结束该文件；`source: "qq-media"` 不占用 body 中的文件序号。
已有 QQ 媒体通过 locator 复用 QQNT 受信任的本地缓存路径，不再从 QQ 下载并跨 HTTP 重传；
只有直接上传到工具 bot 的新文件才使用长度分帧 body 写入账户私有暂存目录。两类路径最终都只交给
QQNT `FlashTransferService`，本接口不申请 Crossgram Highway plan。成功响应为
`{ fileSetId, shareLink, expiresAt? }`。暂存文件保留到闪传有效期之后的清理窗口，
避免 QQNT 后台上传仍在读取时源文件被提前删除。

### 4.6 媒体下载

两个媒体端点都支持 HTTP `Range`（`bytes=start-end`），返回 `206`，且都
设置 `accept-ranges: bytes` 与 `cache-control: no-store`。

- `POST /v1/files/asset`：请求体是 `QQMediaLocator`，返回 QQ 原生媒体
  （图片、文件、语音）字节流。响应头 `content-type` 是媒体 MIME 类型。
- `POST /v1/files/direct-url`：请求体是 `QQMediaLocator`，返回可直接
  HTTP GET 的 QQ CDN URL。视频文档保留下载端点按需 Range 拉取；图片和
  文件则优先使用直链以绕过 bridge 字节中转。用户头像优先使用 QQNT 返回的
  UID 直链并回退 qlogo，群头像直接从 qlogo 构造，均不经过 bridge。

### 4.6 贴纸资源

`POST /v1/stickers/asset`：请求体是 `QQStickerReference`，返回贴纸图片
字节，支持 `Range`。响应头 `x-qqnt-size` 给出完整字节数。资源不存在时
返回 `404`，错误信息由服务端给出。

### 4.7 表情回应

- `GET /v1/reactions/catalog`：返回 `WireReactionContext`（含定义目录）。
- `GET /v1/messages/reactions?conversationId=...&messageId=...`：返回
  单条消息的 `WireReactionState`。
- `GET /v1/messages/reactions/list?conversationId=...&messageId=...`
  可选 `reactionKey`、`offset`、`limit`：返回 `WireReactionActorPage`。
- `POST /v1/messages/reactions`：请求体
  `{ conversationId, messageId, reactionKeys: string[] }`，设置/清除回应，
  返回更新后的状态。
- `POST /v1/reactions/asset`：请求体 `{ reactionKey?: string }`，返回
  自定义回应资源字节，支持 `Range`。

### 4.8 撤回、已读、转发与合并转发

- `POST /v1/messages/delete`：
  `{ conversationId, messageIds: string[], forEveryone?: boolean }`。
  默认 `forEveryone=true`，即“撤回所有人”。
- `POST /v1/messages/read`：`{ conversationId, messageId }`，标记已读到
  指定消息。
- `POST /v1/messages/get`：`{ conversationId, messageId }`，取单条消息；
  不存在返回 `404`。
- `POST /v1/messages/forward`：
  `{ from, to, messageIds: string[], merged?: boolean }`，返回
  `{ messages: WireMessage[] }`。
- `POST /v1/messages/multi-forward`：请求体是
  `{ conversationId, rootMessageId, parentMessageId? }`，展开合并转发
  内容，返回 `{ messages: WireMessage[] }`。

### 4.9 群通知屏蔽

`POST /v1/conversations/:chatType/:peerUin/notification-mask`：

请求体 `{ msgMask: 0|1|2|3|4 }`。只有 `chatType=2`（群）合法；其他值
返回 `400`。成功返回 `{ ok: true, chatType, peerUin, msgMask }`。

### 4.10 好友/群加入申请

- `GET /v1/requests?kind=friend|group-join&cursor=...&limit=...`
  返回 `{ requests, nextCursor? }`。`kind` 缺省返回全部类型。`limit`
  默认 100，最大 500。
- `POST /v1/requests/:id/resolve`：请求体 `{ action: "accept" | "reject" }`，
  返回处理后的 `WireRequest`。

### 4.11 登录二维码

`qqnt-bridge` 可选暴露 `QQLoginController`：

- `GET /v1/login/status`：返回登录状态对象。
- `GET /v1/login/qrcode.png`：返回 PNG 图片。
- `GET /v1/login/qrcode/url`：返回二维码 URL 文本。
- `POST /v1/login/qrcode/refresh`：刷新二维码，返回 `202` 与状态。

### 4.12 群加入契约探测

`GET /v1/group-join/probe` 仅在配置了 bridge token 时可访问。它只读取
允许列表中的 QQNT 群加入相关方法描述符和宿主运行时版本，不做任何写入，
也不验证 QQNT 原生调用契约。

---

## 5. WebSocket 事件流

连接 URL 为 `/v1/events/ws`。服务端每 15 秒发送一次 WebSocket ping。

事件信封统一为：

```json
{ "id": "<eventId>", "event": { ... } }
```

事件类型 `WireEvent`：

- `message`：新消息，携带 `conversation` 与 `message`。
- `message-delete`：撤回，携带 `conversation`、`messageIds` 与时间戳。
- `message-reactions`：回应变化，携带 `conversation`、目标消息与新的
  `context`。
- `request`：好友/群申请变化，携带 `request`。
- `call-signal`：语音通话信令，携带 `signal`、`callId`、`conversation`
  等。
- `native-avsdk`：原生 AVSDK 事件透传（回调名与参数数组）。

重放语义：

- 连接时通过 `?lastEventId=<id>` 指定游标，服务端从该事件之后开始重放。
- 游标未命中时，服务端从保留的最近事件窗口尾部重放，并记录 dropped 数量。
- 重放事件先于实时事件，按队列顺序写入同一 WebSocket。

---

## 6. 语音通话：Unix socket PCM 通道

### 6.1 租约

`POST /v1/calls/media-lease` 请求 `{ callId }`，成功返回：

```json
{
  "version": 1,
  "socketPath": "/path/to/qqnt-media-gateway.sock",
  "leaseId": "<16字节hex>",
  "token": "<base64url 32字节>",
  "expiry": 1234567890
}
```

`POST /v1/calls/control` 请求 `{ callId, operation }`，`operation`
为 `accept`、`reject` 或 `hangup`。

### 6.2 PCM 帧协议

连接 Unix socket 后，先发送认证帧，然后双向传输音频帧。帧格式为：

```text
[1 字节 type][4 字节大端 payload 长度][payload]
```

认证帧：

- type = `0x01`（auth）
- payload = `[1 字节协议版本=1][16 字节 leaseId hex][32 字节 token]`

音频帧：

- type = `0x02`（上行，客户端→bridge）
- type = `0x81`（下行，bridge→客户端）
- payload 为固定 20 ms 的 48 kHz、单声道、s16le PCM
  （每帧 1920 字节）

服务端就绪时发送 `0x80`（ready）帧，payload 为协议版本字节。

---

## 7. 协议版本简表

| 版本 | 关键能力 |
|---|---|
| 19 | 好友/群申请分页与处理、贴纸、合并转发、搜索、表情回应 |
| 20 | 语音通话信令、媒体租约与 PCM Unix socket |
| 21 | 流式 PTT 语音上传、source-backed 语音控制 |
| 22 | 群加入契约探测、过滤后的好友申请来源等 |

适配器通过 `MIN_PROTOCOL_VERSION` 与 `MAX_PROTOCOL_VERSION` 约束兼容
范围。服务端始终向下兼容，直到旧版本特性被正式移除。

---

## 8. 安全边界

- 服务端只监听 `127.0.0.1`，不应暴露到公网。
- 配置 token 后，所有 HTTP、WebSocket 和 Unix socket 认证都使用该共享
  密钥派生出的 SHA-256 摘要进行常量时间比较。
- `leaseId` 与 PCM token 为随机字节；客户端在认证后立即清零本地 token。
- 带外直链只包含 QQ CDN URL，不包含 bridge token。
- 用户头像优先使用 QQNT 的 UID 直链并回退 qlogo；群头像由适配器直接构造 qlogo URL，均不经过 bridge。
- `group-join/probe` 只在配置了 token 时开放，且只返回方法描述符和宿主
  运行时版本，不执行任何 QQNT 群加入写入。
