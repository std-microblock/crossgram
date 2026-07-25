# IMPlatform 适配器实现规范

本文描述 `@mtproto-relay/bridge` 的平台适配契约。QQ、微信、Telegram、Discord 等实现都应只处理平台 API；消息缓存、Telegram 数字 ID、媒体分组和 MTProto 对象由 bridge 负责。

## 1. 注册与生命周期

bridge 通过 `ctx.imPlatform` 暴露 Cordis registry service。平台实现本身也是 Cordis 插件，registry key 直接使用配置项的 `id`；`IMPlatform` 不再维护第二个 ID。

静态参考平台的单实例配置：

```yaml
- id: bridge01
  name: '@mtproto-relay/bridge'
- id: static
  name: '@mtproto-relay/platform-static'
```

同一个平台包可以加载多次，每个 Cordis entry 是完全独立的 adapter 实例：

```yaml
- id: static-primary
  name: '@mtproto-relay/platform-static'
  config:
    transferChunkSize: 65536
- id: static-secondary
  name: '@mtproto-relay/platform-static'
  config:
    transferChunkSize: 262144
```

此处的 `static-primary` / `static-secondary` 就是写入 `PlatformSession.platformId`、HTTP 路径和数据库绑定的唯一平台 ID。不要在 adapter 配置中再定义 ID。

自定义平台包的入口保持同样结构：

```ts
import type { Context } from 'cordis'
import { resolvePlatformPluginId } from '@mtproto-relay/bridge'

export const inject = ['imPlatform']

export function apply(ctx: Context, config: Config) {
  const id = resolvePlatformPluginId(ctx)
  ctx.imPlatform.register(new QQPlatform(config), id)
}
```

bridge 不注册默认 adapter。平台插件注册后，bridge 会调用 `getAccount()` 获取当前平台用户，自动创建或刷新该 Cordis entry 唯一的 active session，并为它分配稳定虚拟手机号；同一 session 的多个 MTProto 连接不会重复订阅。平台插件卸载时只停止该平台的订阅，其他实例不受影响。

`subscribe()` handler 返回的 Promise 有背压语义。adapter 应等待它结束再确认/提交自己的消费游标，否则进程在入库前退出可能丢消息。

### 1.1 当前平台账号

账号资料必须由 adapter 自己提供，bridge 不接受外部注册请求，也不会生成用户 ID、姓名或头像：

```ts
interface IMPlatformAccount<L> {
  user: IMUser<L> // id / firstName / lastName / username / avatar
  credentials?: JsonValue
}

interface IMPlatform<L> {
  getAccount(): Promise<IMPlatformAccount<L>>
  // ...
}
```

同一个 Cordis platform entry 对应一个账号和一个虚拟手机号。bridge 在 `/platform-accounts` 页面展示平台资料、手机号和每 30 秒轮换的六位 TOTP 登录码。`user.avatar` 继续使用 adapter 的 typed `IMMedia<L>`，页面头像由 bridge 调用 `downloadMedia()` 读取；TOTP secret 和 credentials 不会下发到浏览器。

## 2. ID 与幂等

- user、conversation、message、media 和 group ID 都是 opaque string。
- 不得把 ID 转成 `number`、`bigint`、hash 或固定长度数据库字段。
- adapter 提供的 opaque user ID 会原样保存为 `mtproto_im_user.platformUserId`；bridge 以
  `(platformId, platformUserId)` 唯一确定用户，并使用该表的自增主键 `id` 作为 Telegram
  `user_id`。因此同一 platform 下跨 session 的同一用户会得到同一个 Telegram ID，进程
  重启后也不会变化。
- 用户姓名、username、头像 locator 和 metadata 都保存在 `mtproto_im_user`；消息通过
  `mtproto_im_message.senderUserId` 关联该用户行，不在消息 metadata 中复制用户资料。
- `IMMessage.id` 表示逻辑消息 ID；`sourceIds` 保存被该逻辑消息覆盖的所有平台物理消息 ID。
- bridge 按 `(platformSessionId, conversationId, sourceId)` 幂等入库。
- 外部 ID 到 Telegram message ID 的映射持久化在数据库，重连和重启后保持不变。

Telegram album 示例：三条具有同一 `grouped_id` 的 Telegram message 应由 TG adapter 聚合成一个 `IMMessage`，三个原始 message ID 放进 `sourceIds`，三个媒体按原顺序放进 `content.parts`。

## 3. Conversation

```ts
interface IMConversation {
  id: string
  kind: 'direct' | 'group' | 'channel'
  title: string
  parentId?: string
  spaceId?: string
  avatar?: IMMedia<PlatformMediaLocator>
  metadata?: JsonObject
}
```

- QQ/微信群使用 `group`。
- Discord guild/workspace ID 放入 `spaceId`。
- Discord category、parent channel 或 thread owner 放入 `parentId`。
- Discord channel/thread 使用 `channel`。当 `parentId` 指向同一 session 中另一个 channel 时，父 channel 映射为 Telegram forum，子 channel 映射为 `ForumTopic`；其他层级（例如 category ID）继续作为 opaque parent 信息保存。
- `metadata.broadcast: true` 会生成 Telegram broadcast channel；其他 channel 生成 megagroup。

消息事件必须携带完整 conversation，不能只给 conversation ID。这样 push-only 平台首次收到群消息时也能独立完成入库。

### 3.1 成员、管理员与权限

`getConversationMembers()` 使用 cursor 分页返回 `IMConversationMember`；`getConversationMember()` 用于单成员查询。角色只有 `owner / administrator / member / guest`，具体操作权限放在 `IMConversationPermissions`，不要通过角色名推断：

```ts
interface IMConversationMember<L> {
  user: IMUser<L>
  role: 'owner' | 'administrator' | 'member' | 'guest'
  permissions: {
    manageConversation: boolean
    manageMembers: boolean
    deleteAnyMessage: boolean
    editAnyMessage: boolean
    pinMessages: boolean
    inviteMembers: boolean
  }
  joinedAt?: number
  title?: string
}
```

`members.administrators` 表示平台能区分管理员，`members.permissions` 表示权限字段来自平台真实数据。bridge 将其投影为 Telegram participant/admin rights；不能获取成员时不要伪造当前用户为群主。

bridge 会把所有平台 `group` 投影为 Telegram megagroup，不使用 basic chat。客户端通过
`channels.getParticipants(offset, limit)` 按需获取成员；bridge 负责把 Telegram offset
映射到平台的 opaque cursor。

## 4. 消息内容

`IMMedia` 的 locator 是 adapter 自己声明的泛型，不是 `JsonValue`。用户头像和群头像也使用同一套 `IMMedia<L>` / `downloadMedia()`：

```ts
interface QQMediaLocator {
  fileId: string
  downloadToken: string
}

class QQPlatform implements IMPlatform<QQMediaLocator> {
  async *downloadMedia(session, media: IMMedia<QQMediaLocator>) {
    // media.locator?.downloadToken 在此处保持静态类型。
  }
}
```

图片可以携带 adapter 已提取的 `preview: { mimeType, size, width, height, locator }`。
bridge 会把它投影为 Telegram 的 `photoSize(type='m')`，完整图片使用 `type='x'`；客户端请求
`thumb_size=m` 时，bridge 仍调用同一个 `downloadMedia()`，但传入 preview 的 locator。

消息、用户、会话和事件沿用同一个 locator 泛型。只有 bridge 的数据库持久化边界会把 locator 显式序列化；平台实现中不得用 `JsonValue` 或无类型字段代替 locator 模板。

发送统一使用一个接口：

```ts
sendMessage(session, conversation, {
  parts: [
    { type: 'text', text: 'caption' },
    { type: 'media', media: image },
    { type: 'media', media: file },
  ],
}, options)
```

`parts` 有序，允许纯文字、单图、图文、多图和文件混合。adapter 返回的 `IMMessage` 必须包含平台最终确认的 message/media ID，不应复用客户端临时 ID。

平台系统提示使用 `content.serviceAction`，不得伪装成普通 text part。当前通用表达为
`{ type: 'custom', text }`，bridge 将其投影为 Telegram `messageService` / `messageActionCustomAction`，
因此历史和实时 update 都由客户端按灰字系统消息渲染。系统消息的 `parts` 可以为空。

一条逻辑消息有多个媒体时，bridge 为每个媒体生成一条连续 Telegram message，共享持久化 `groupedId`；第一条携带文本 caption，其余文本为空。

## 5. History 分页

`getDialogs()` 和 `getHistory()` 都只返回一页。禁止 adapter 在一次调用中自行遍历全部 cursor。

```ts
interface IMHistoryQuery {
  cursor?: string
  limit?: number
  before?: { id: string, timestamp: number }
  after?: { id: string, timestamp: number }
}
```

bridge 会把 Telegram `offsetId/offsetDate/limit` 解析成平台 anchor，并只请求当前窗口。平台返回的 `nextCursor` 只描述下一页，不表示 bridge 会在当前 RPC 中继续读取。

返回顺序可以是平台原生顺序；bridge 会在当前页内按 timestamp 归一化。history 回填 ID 从中间水位向下分配，subscribe/send 的 live ID 向上分配，因此读取更老页面不会修改已暴露的 ID。

如果未实现 `getHistory`，`capabilities.history` 必须是 `false`。此时 Telegram history 完全读取 subscribe 已落库的数据。如果实现了 history，bridge 先拉当前平台页、幂等入库，再从数据库返回。

## 6. Subscribe 事件

```ts
type IMEvent =
  | { type: 'message', conversation: IMConversation, message: IMMessage }
  | {
      type: 'message-edit'
      eventId: string
      conversation: IMConversation
      message: IMMessage
    }
  | {
      type: 'message-delete'
      eventId: string
      conversation: IMConversation
      messageIds: string[]
      timestamp: number
    }
  | { type: 'conversation', conversation: IMConversation }
  | { type: 'read', conversationId: string, upToMessageId: string }
```

`message-edit` 必须携带编辑后的完整 `IMMessage`，并保持原 message ID；`message-delete.messageIds` 可以使用主 ID 或任意 `sourceIds` alias。mutation 的 `eventId` 是平台侧 opaque 操作 ID，同一 edit/delete 重投时必须保持不变。

message 和 mutation 事件先事务入库并生成/复用投影，再通过进程内有界 delivery journal 保留 `pts/seq`，最后只向绑定该 platform session 的 auth key 推送 `updateNew*`、`updateEdit*` 或 `updateDelete*`。`pts/seq` 状态仍持久化；进程重启会丢失增量 journal，客户端下次同步时收到 `updates.differenceTooLong` 并走全量同步。发送失败时平台重投会复用原 `pts/seq`；已成功发布的 event ID 不会重复推送。

撤回采用 tombstone：消息不会再出现在 dialogs/history/getMessages，但外部 ID、alias 和 Telegram message ID 映射继续保留，确保撤回 update、重试和重启后的 ID 都稳定。

### 6.1 下游主动 mutation

`capabilities.messageActions` 同时声明策略和语义：

- `delete.own / delete.others` 分别声明是否支持撤回自己的消息和管理员撤回他人消息；`maxAgeSeconds` 省略表示不限时间。
- `edit.mode` 为 `native / delete-and-resend / unsupported`。`delete-and-resend` 由 bridge 严格按“成功撤回旧消息后再发送新消息”执行；撤回失败时不会发送。
- `forward.mode` 为 `native / copy / unsupported`，`preservesAuthor` 明确平台是否保留原作者署名。

原子方法为 `deleteMessages()`、`editMessage()` 和 `forwardMessages()`。目标 ID 使用 `sourceIds` 中对应的物理 ID；adapter 不解析 Telegram 数字 ID。原生编辑必须保持平台逻辑 message ID；撤回重发会向 Telegram 客户端发布 delete + new update，而不是伪造保持 ID 的 edit。

adapter 可以提供 at-least-once 事件；不要求自己实现 exactly-once。事件 handler 抛错时不得静默推进不可恢复的远端 cursor。

## 7. 流式媒体与进度

Telegram `upload.saveFilePart` 到达后，bridge 将每个 part 独立写入临时文件。调用 adapter 时不会构造完整文件 Buffer：

```ts
for await (const chunk of media.source.stream({ signal: options.signal })) {
  await platformUploader.write(chunk)
  transferred += chunk.length
  await options.onProgress?.({
    phase: 'upload', mediaIndex, transferredBytes: transferred,
    totalBytes: media.source.size,
  })
}
```

adapter 必须边读取 `source.stream()` 边向平台上传。不要先将所有 chunk 收集到内存或另一个完整临时文件后再开始平台上传。成功返回后 bridge 清理 Telegram upload parts；失败时保留 parts，允许客户端以同一个 random ID 重试。

Telegram Desktop 通常不会把 `inputMediaUploadedPhoto` / `inputMediaUploadedDocument` 直接交给 `messages.sendMedia`，而是使用两阶段流程：

```text
upload.saveFilePart / upload.saveBigFilePart
  -> messages.uploadMedia
  -> messageMediaPhoto / messageMediaDocument
  -> messages.sendMedia(inputMediaPhoto / inputMediaDocument)
```

bridge 会在 `messages.uploadMedia` 后暂存媒体引用，并允许客户端通过 `upload.getFile` 读取预览。暂存状态属于整个 bridge 服务及 platform session，不属于单个 MTProto 连接，因此上传连接与发送连接可以不同。只有 adapter 已确认发送且消息完成入库后才删除暂存引用和磁盘分片；平台失败时同一引用和 random ID 都可重试。`upload.getFile` 的 layer 224 long offset 会先做安全整数校验，媒体对象中的 `dcId` 始终与 bridge 配置一致。

进度是传输过程的观测值，不是第二套上传协议。每个媒体独立使用 `mediaIndex`，`transferredBytes` 必须单调递增；未知总长度时可以不传 `totalBytes`。取消通过 `AbortSignal` 传播。

下载实现 `downloadMedia(session, media, { offset, limit, signal, onProgress })`，range 语义由 adapter
负责；远端只支持整文件时，adapter 可以从本地缓存读取 range，或边流式丢弃 offset 前的数据。
bridge 会再次限制单次 `upload.getFile` 的输出不超过 `limit`，不会把完整远端文件装入内存。

## 8. Capability 与错误

adapter 必须准确声明 `send.text/images/files/mixed/maxTextLength/maxMedia` 和 conversation 能力。bridge 会在调用平台前完成通用校验；平台限流、权限和内容审核错误应保留可诊断的 error message。

以下情况不得返回伪成功：缺上传 part、已取消、平台未确认 message ID、媒体读取不完整、history cursor 无效或 session 已失效。

## 9. Sticker Provider

Sticker catalog 不属于 `IMPlatform`。bridge 通过 `ctx.imSticker` 聚合平台原生 Provider 和独立贴纸插件：

```ts
ctx.imSticker.register(provider, 'qq-main:native')
ctx.imSticker.register(companyStickerProvider, 'company-stickers')
```

全局 sticker identity 为 `(providerId, stickerId)`，pack identity 为 `(providerId, packId)`。Provider 负责：

- `listPacks()` / `getPack()` / `getSticker()` / `search()`。
- 通过 `openAsset()` 提供 Telegram 预览、下载和跨平台上传所需的流。
- 可选通过 `prepareSend()` 返回平台 native reference；没有 native 表达时 bridge 使用 asset upload。

平台插件可以共享同一个底层 client，同时注册 `IMPlatform` 和平台原生 `IMStickerProvider`。独立贴纸包只注册 Provider，不需要依赖任何具体 IM API。

`messages.getRecentStickers`、`saveRecentSticker`、`getFavedStickers`、`faveSticker` 和 clear 操作全部由 bridge 数据库统一管理。发送经平台确认并完成入库后才进入 recent；Provider 临时卸载不会删除 favorite/recent 记录。

平台本身已有的用户收藏可由 Provider 的 `listSavedStickers()` 暴露。此列表允许返回不属于任何 pack 的 sticker：

```ts
{
  providerId: 'qq-main:native',
  stickerId: 'user-saved-123',
  packId: undefined,
  format: 'static',
  mimeType: 'image/webp',
}
```

bridge 会将这种 loose sticker 投影为：

```ts
{
  _: 'documentAttributeSticker',
  stickerset: { _: 'inputStickerSetEmpty' },
}
```

它会出现在统一 `messages.getFavedStickers` 中，仍然可以下载、发送、进入 recent，并可由 bridge 再次收藏；但不会伪造 sticker set，也不会出现在 `getAllStickers`。本地收藏和 Provider 收藏按 `(providerId, stickerId)` 去重。

Sticker set 的安装状态同样属于 bridge 用户状态。`installStickerSet`、`uninstallStickerSet`、`toggleStickerSets` 和 `reorderStickerSets` 写入 bridge 数据库；安装后的 set 通过 `StickerSet.installedDate` 返回，服务重启后保持。

`IMMessagePart` 和 `IMMessageInputPart` 支持 `type: 'sticker'`。发送计划分为：

```ts
type IMStickerSendPlan =
  | { type: 'native', providerId: string, stickerId: string, reference: JsonValue }
  | { type: 'upload', providerId: string, stickerId: string, format: 'static' | 'animated' | 'video', source: IMMediaSource, ... }
```

adapter 只负责执行最终 native/upload 输入，不实现 Telegram sticker set、收藏或最近使用逻辑。

## 10. Reaction

Reaction 是消息 mutation，不属于 message text/media，也不能通过 `message-edit` 模拟。平台使用 opaque native key：

```ts
interface IMReactionSummary {
  key: string
  count: number
  selected?: boolean
  recentActors?: Array<{ userId: string, timestamp?: number }>
}
```

发送使用最终状态语义：

```ts
setMessageReactions(session, target, reactionKeys)
```

Reaction 定义由平台按 chat 或具体消息动态返回：

```ts
interface IMReactionDefinition {
  key: string
  title?: string
  presentation:
    | { type: 'emoji', emoticon: string }
    | { type: 'custom', alt: string, resource: IMReactionResource }
}

interface IMReactionContext {
  available: IMReactionDefinition[]
  reactions: IMReactionSummary[]
  maxSelected: number
}
```

- `presentation.type === 'emoji'` 只提供平台 native key 到 Telegram 标准 emoji 的映射。标准 reaction 的图标和动画由 bridge 的 Telegram reaction catalog 提供，adapter 不提供资源。
- `presentation.type === 'custom'` 用于 Discord guild emoji 等 chat/message scoped reaction。资源由 `downloadReactionResource()` 下载，不经过 Sticker Provider。
- `getAvailableReactions(session, { conversationId })` 返回 chat 默认能力。
- 传入 `messageId/targetId` 时返回具体消息能力，允许同一 chat 中不同消息有不同 reaction allow-list。
- `getMessageReactions()` 返回消息当前 count；history 返回的 `IMMessage.reactionContext` 使用相同结构。

这样 Telegram `messages.sendReaction` 的 vector 可以直接映射到平台，不需要 bridge 猜测 add/remove 操作。平台推送使用完整 context：

```ts
{
  type: 'message-reactions',
  eventId,
  conversation,
  target,
  context,
  timestamp,
}
```

bridge 将 context 独立入库，通过进程内 delivery journal 发布 `updateMessageReactions`。Custom resource 的 synthetic Document ID 包含 session、conversation、native key 和 resource version，避免跨 guild 泄漏或资源更新后命中旧缓存。

`messages.getAvailableReactions` 是 bridge 账号级 Telegram 标准 reaction catalog；`ChatFull.availableReactions` 才是平台针对当前 chat 返回的允许集合。

## 11. 最小 conformance 清单

每个平台实现至少覆盖：

1. subscribe 重复事件幂等、handler 背压、unsubscribe。
2. 8K 以上 message ID 和包含特殊字符的 conversation ID。
3. history 第一页、before anchor、limit 不越界，且单次调用不遍历 nextCursor。
4. 纯文字、单图、图文、两媒体 album、普通文件。
5. source 被逐 chunk 消费，进度单调、取消可中断、失败可重试。
6. download offset/limit 字节一致。
7. direct/group/channel/subchannel sender 与层级信息完整。
8. history 与 subscribe 同时返回同一消息时只保留一条。
9. 服务重启后相同外部 ID 对应相同 Telegram message/group ID。
10. edit 保持 message/TL ID，delete 从 history 隐藏且重复 mutation 不重复推进 pts。
11. 至少 1000 条并发 subscribe 事件不丢 message、alias 或 TL projection。
12. 万级历史只返回请求窗口，深分页不在单次 RPC 中全量入库。
13. 平台 native sticker 与独立 Provider sticker 同时出现在 catalog，均可下载、发送并进入统一 recent/favorite。
14. Unicode/custom-emoji reaction 均可从 reaction pack 映射、发送、写入历史并通过 push update 发布。
15. owner/admin/member、权限、成员分页和管理员筛选与平台数据一致。
16. 用户/群头像通过带类型 locator 的 `IMMedia` range 下载；原生编辑、撤回重发、限时/不限时撤回及转发策略均有覆盖。

bridge 内部行为测试位于 `packages/bridge/src`，包括 `message-store.test.ts`、`platform-manager.test.ts`、`media-projection.test.ts`、`media-send.test.ts` 和 `conversation-kinds.test.ts`。

跨包契约测试独立位于 `@mtproto-relay/test-suite`，依赖方向固定为：

```text
test-suite -> platform-static -> bridge -> mtproto
           -> bridge -----------^
```

- `platform-static.test.ts` 直接验证 Cordis 多例、Group A 每秒 new/edit/delete、Group B→C 用户镜像、Group D 万级分页、混合媒体、传输进度、subscribe 背压和错误行为。
- `login.e2e.test.ts` 通过真实 MTProto socket 验证登录/重连/重启、new/edit/delete 推送和 tombstone、主动编辑/撤回/转发、成员与管理员权限、用户/群头像下载、B→C bridge history、万级历史窗口入库、群相册、文件传输及 channel/subchannel。

运行 adapter 契约与跨包 e2e：

```bash
pnpm --filter @mtproto-relay/test-suite exec vitest run
```
