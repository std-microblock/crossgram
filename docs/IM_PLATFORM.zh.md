# IMPlatform 适配器规范

本文定义 `@mtproto-relay/bridge` 的平台适配器接口契约。平台适配器只负责对接具体 IM 协议；消息入库、Telegram ID 分配、媒体分片与 MTProto TL 对象构造均由 Bridge 处理。

## 1. 注册与生命周期

Bridge 通过 `ctx.imPlatform` 提供适配器注册表，每个 Cordis 配置项的 `id` 即为该平台账号的唯一 `platformId`：

```ts
import type { Context } from 'cordis'
import { resolvePlatformPluginId } from '@mtproto-relay/bridge'

export const inject = ['imPlatform']

export function apply(ctx: Context, config: Config) {
  const id = resolvePlatformPluginId(ctx)
  ctx.imPlatform.register(new QQPlatform(config), id)
}
```

同一个适配器包可在 `app.yml` 中挂载多次，每个条目对应一个独立的平台账号和虚拟手机号：

```yaml
- id: qq-primary
  name: '@mtproto-relay/platform-qqnt'
- id: qq-secondary
  name: '@mtproto-relay/platform-qqnt'
```

适配器注册后，Bridge 调用 `getAccount()` 获取当前登录用户资料，创建或更新持久化会话，并调用 `subscribe()` 监听实时事件。`subscribe()` 回调返回的 Promise 具有背压语义：适配器必须等待该 Promise 完成后再推进上游游标，防止进程退出导致消息丢失。

## 2. ID 与幂等

- 用户、会话、消息、媒体与消息组 ID 均为不透明字符串（opaque string），禁止强转为数字或定长哈希。
- 用户按 `(platformId, platformUserId)` 唯一标识，数据库自增主键即为其 Telegram `user_id`。
- `IMMessage.id` 为逻辑消息 ID，`sourceIds` 包含该逻辑消息对应的全部平台物理消息 ID（例如多图合并为一条逻辑消息时）。
- Bridge 按 `(platformSessionId, conversationId, sourceId)` 幂等入库。

## 3. 会话与成员

```ts
interface IMConversation<L = unknown> {
  id: string
  kind: 'direct' | 'group' | 'channel'
  title: string
  parentId?: string
  spaceId?: string
  avatar?: IMMedia<L>
  selfRole?: 'owner' | 'administrator' | 'member' | 'guest'
  selfPermissions?: IMConversationPermissions
  metadata?: JsonObject
}
```

- QQ/微信群使用 `group`（Bridge 统一投影为 Telegram Megagroup）。
- Discord 服务器放入 `spaceId`，频道/子线程使用 `channel`，父频道或分类放入 `parentId`（当 `parentId` 指向同一会话下的另一个 `channel` 时，自动投影为 Forum Topic）。
- 实时消息事件必须携带完整的 `IMConversation` 对象，以便在未拉取会话列表时直接入库。
- 成员列表通过 `getConversationMembers()` 按游标分页，角色分为 `owner | administrator | member | guest`，具体权限通过 `IMConversationPermissions` 显式声明。

## 4. 消息与媒体

### 4.1 媒体定位器（Locator）

`IMMedia<L>` 的 `locator` 是适配器自定义的强类型凭据，Bridge 仅在落库时将其序列化为 JSON，并在调用 `downloadMedia(session, media, options)` 时原样传回。

图片可附带 `strippedThumbnail: Uint8Array`（Telegram `photoStrippedSize` 格式），Bridge 会将其直接内联进消息，无需客户端额外请求缩略图。

### 4.2 发送与服务消息

`sendMessage(session, conversation, input, options)` 接收有序的 `parts`（支持文字、图片、文件、贴纸混排），返回带平台最终消息 ID 的 `IMMessage`。若平台消息正文原生为 Markdown（如 QQ 官方机器人），适配器除了提供渲染后的 `parts`，还可在 `content.richMarkdown` 中附上原始 Markdown，由 Bridge 转换为 Telegram 富文本（Article）消息块以支持表格、列表与多级标题。

系统提示使用 `content.serviceAction`：
- `{ type: 'custom', text }`：通用灰条提示。
- `{ type: 'phone-call' }`：通话记录提示。
- `{ type: 'members-joined', text, members, actor?, viaInviteLink? }`：结构化入群通知，投影为可点击成员姓名的原生入群消息。

> **QQ 灰条特例**：QQ 灰条与伴随的普通消息共用同一个 `msgSeq`。Bridge 会将指向灰条的回复重定向到同序号的正文消息，且删除灰条时仅在本地隐藏，绝不向 QQ 发起撤回请求（避免误撤回同序号的正文消息）。

### 4.3 链接预览（web page）

Telegram 的链接预览本来由服务端抓取生成；Bridge 自己就是服务端，因此由 Bridge 合成：正文里第一条裸 `http(s)` 链接会被异步抓取（OpenGraph / Twitter card / `<title>`），缩略图落在 `linkPreview.cachePath`（默认 `data/bridge-link-preview`），再投影成 `messageMediaWebPage`（`manual` 卡片，与 QQ ark 卡片同一条路）。

- 抓取不在投影路径上：消息先以普通链接投递，抓取完成后补一条 `message-edit`（`eventId = link-preview:<会话>:<消息>`，`forceDelivery`）让客户端重画同一条消息。
- 防护：只允许 http/https，解析后拒绝回环、RFC1918、CGNAT、link-local、私网 IPv6 与内网域名；超时、HTML 与图片大小上限、并发与缓存 TTL 都可配置；失败只留普通链接，并短暂负缓存避免重试风暴。
- QQ ark / 小程序 / 合并转发卡片本身已经带预览，不再重复抓取；`messages.getWebPagePreview`（客户端输入框预览）未实现。
- 反方向（Telegram → QQ）不需要处理：QQ 服务端自己给链接出卡片。

## 5. 历史分页与已读同步

- `getDialogs()` 与 `getHistory()` 每次调用只返回一页数据，严禁在单次调用内自动循环拉取后续游标。
- 若平台支持标记已读，声明 `capabilities.readState.markRead = true` 并实现 `markRead()`；若支持其他端已读同步推送，声明 `capabilities.readState.events = true` 并推送 `{ type: 'read', conversationId, upToMessageId }`。

## 6. 实时事件与消息操作

```ts
type IMEvent =
  | { type: 'message', conversation: IMConversation, message: IMMessage }
  | { type: 'message-edit', eventId: string, conversation: IMConversation, message: IMMessage }
  | { type: 'message-delete', eventId: string, conversation: IMConversation, messageIds: string[], timestamp: number }
  | { type: 'message-reactions', eventId: string, conversation: IMConversation, target: IMReactionTarget, context: IMReactionContext, timestamp: number }
  | { type: 'conversation', conversation: IMConversation }
  | { type: 'read', conversationId: string, upToMessageId: string }
```

- 撤回采用 Tombstone 机制：消息从会话与历史中隐藏（或按配置标记为已撤回），但平台 ID 与 Telegram ID 映射永久保留。
- `capabilities.messageActions` 声明撤回、编辑（`native | delete-and-resend | unsupported`）与转发能力。
- 支持「戳一戳」的平台声明 `capabilities.poke = { maxCount }` 并实现 `sendPoke()`。

## 7. 媒体上传与下载

### 7.1 预检秒传与流式直传

支持 `crossgram.prepareMediaUpload` 的客户端在上传分片前会先提交文件哈希（MD5、SHA-1、前 10 MiB MD5 及分块 SHA-1 状态）。适配器实现 `prepareMediaUpload()`：

- **秒传命中**：返回不含 `sink` 的结果，客户端跳过所有 `upload.saveFilePart` 分片上传。
- **流式直传**：返回带 `sink` 的上传计划，Bridge 在内存中重排乱序分片（上限 32 个分片 / 16 MiB）并直接按序写入 `sink`（如 QQ Highway 1 MiB 分块直传），全程不落盘临时文件。
- **回退模式**：未预检的客户端上传分片暂存至磁盘，发送时通过 `media.source.stream()` 边读边传。

### 7.2 按需下载与直链

适配器必须实现 `downloadMedia(session, media, { offset, limit, signal })` 支持字节区间读取。若平台支持客户端直连 CDN，可额外实现 `resolveDirectDownload()` 返回带过期时间的 HTTP(S) URL。

## 8. 贴纸与表情回应

### 8.1 Sticker Provider（`ctx.imSticker`）

贴纸目录独立于 `IMPlatform`，通过 `ctx.imSticker.register(provider, id)` 注册：
- 提供 `listPacks()`、`getPack()`、`getSticker()`、`openAsset()` 与可选的 `prepareSend()`。
- QQ 收藏表情作为独立的 `qq-favorites` 贴纸包暴露，客户端收藏/取消收藏直接映射为 QQ 收藏夹操作。

### 8.2 表情回应（Reaction）

- 标准 Emoji 回应声明 `presentation: { type: 'emoji', emoticon }`，复用 Bridge 内置的 Telegram 动画资源。
- 平台自定义回应声明 `presentation: { type: 'custom', alt, resource }`，由 `downloadReactionResource()` 提供图片字节。
- `setMessageReactions(session, target, reactionKeys)` 接收消息最终选中的回应 Key 列表。
