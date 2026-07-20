# IMPlatform 适配器实现规范

本文描述 `@mtproto-relay/bridge` 的平台适配契约。QQ、微信、Telegram、Discord 等实现都应只处理平台 API；消息缓存、Telegram 数字 ID、媒体分组和 MTProto 对象由 bridge 负责。

## 1. 注册与生命周期

配置通过 `BridgeConfig.platforms` 一次注册多个 adapter，`id` 必须全局唯一：

```ts
ctx.plugin(bridge, {
  platforms: [qqPlatform, wechatPlatform, telegramPlatform, discordPlatform],
})
```

每个 `PlatformSession.platformId` 决定实际 adapter。bridge 启动时会为数据库中所有 active session 调用一次 `subscribe()`；同一 session 的多个 MTProto 连接不会重复订阅。插件停止时会等待 `Unsubscribe`。

`subscribe()` handler 返回的 Promise 有背压语义。adapter 应等待它结束再确认/提交自己的消费游标，否则进程在入库前退出可能丢消息。

## 2. ID 与幂等

- user、conversation、message、media 和 group ID 都是 opaque string。
- 不得把 ID 转成 `number`、`bigint`、hash 或固定长度数据库字段。
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
  metadata?: JsonObject
}
```

- QQ/微信群使用 `group`。
- Discord guild/workspace ID 放入 `spaceId`。
- Discord category、parent channel 或 thread owner 放入 `parentId`。
- Discord channel/thread 使用 `channel`。当前 Telegram 表现层将子 channel 展平为 synthetic channel，但父子关系不会丢失。
- `metadata.broadcast: true` 会生成 Telegram broadcast channel；其他 channel 生成 megagroup。

消息事件必须携带完整 conversation，不能只给 conversation ID。这样 push-only 平台首次收到群消息时也能独立完成入库。

## 4. 消息内容

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
  | { type: 'conversation', conversation: IMConversation }
  | { type: 'read', conversationId: string, upToMessageId: string }
```

message 事件先事务入库并生成投影，再通过持久化 delivery/outbox 保留 `pts/seq`，最后只向绑定该 platform session 的 auth key 推送 update。发送失败时平台重投会复用原 `pts/seq`；发送成功后重复出现同一 source ID 不会重复推送。

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

进度是传输过程的观测值，不是第二套上传协议。每个媒体独立使用 `mediaIndex`，`transferredBytes` 必须单调递增；未知总长度时可以不传 `totalBytes`。取消通过 `AbortSignal` 传播。

下载实现 `downloadMedia(session, media, { offset, limit, signal, onProgress })`，应从平台侧尽量按 range 读取。bridge 会再次限制单次 `upload.getFile` 的输出不超过 `limit`，不会把完整远端文件装入内存。

## 8. Capability 与错误

adapter 必须准确声明 `send.text/images/files/mixed/maxTextLength/maxMedia` 和 conversation 能力。bridge 会在调用平台前完成通用校验；平台限流、权限和内容审核错误应保留可诊断的 error message。

以下情况不得返回伪成功：缺上传 part、已取消、平台未确认 message ID、媒体读取不完整、history cursor 无效或 session 已失效。

## 9. 最小 conformance 清单

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

仓库测试可作为参考：`message-store.test.ts`、`platform-manager.test.ts`、`media-projection.test.ts`、`media-send.test.ts`、`conversation-kinds.test.ts` 和 `login.e2e.test.ts`。
