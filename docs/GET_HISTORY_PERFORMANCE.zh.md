# `messages.getHistory` 延迟问题总结与改造建议

> 状态：问题已复现并完成第一轮分段 profiling；尚未决定替换 ORM，也尚未把 Redis 接入历史消息链路。
>
> 样本日期：2026-07-26；当前数据量约为 14,129 条消息、14,129 条 alias、14,173 条 TL message part、1,245 条媒体和 2,052 个用户。

## 1. 用户可见问题

Telegram Desktop 发出的典型请求为：

```text
messages.getHistory
offsetId=1 offsetDate=0 addOffset=-25 limit=50 maxId=0 minId=0
```

客户端观测到一次请求耗时约 **2.46 s**。服务端对相同参数的连续样本也出现了 **1.10–3.40 s** 的总耗时，其中一个相邻样本为 **2.521 s**，因此慢点在 relay 的 RPC 处理链路内可以稳定观察到，不是单纯的客户端显示或 MTProto 网络计时误差。

合并转发不是主要原因。合并转发已经直接复用 QQNT 自带的预览文本，不再自行生成预览。未生成完成的图片、贴纸等历史媒体也已经先返回空内容占位，后台完成后通过 edit update 替换，因此 `getHistory` 不应等待媒体文件下载或转码。

## 2. 当前调用链

```text
messages.getHistory
  -> DialogRpc.getHistory
     -> hydrate peers
     -> DialogRpc._loadHistory
        -> PlatformData.getHistory
           -> adapter.getHistory（QQNT 上游）
           -> MessageStore.ingestMany（写入 Minato/SQLite）
           -> MessageStore.readHistory（第一次完整回读）
        -> sync stored users
        -> MessageStore.readProjectedHistory（第二次完整回读）
        -> remember reply targets
     -> load message senders
     -> project TL messages/chats/users
```

这里存在一个直接的重复工作：`DialogRpc._loadHistory()` 并不使用 `PlatformData.getHistory()` 返回的完整消息列表，随后会调用 `readProjectedHistory()` 再读一次。因此 `PlatformData.getHistory()` 内部的 `readHistory()` 对这条调用路径是一次无效的完整回读。

## 3. Profiling 结果

以下为会话 `54404627`、实际 fetch limit 为 76 的连续样本范围。范围来自已落盘的 bridge profile 日志，而不是估算：

| 阶段 | 观测范围 | 说明 |
|---|---:|---|
| RPC 总耗时 | 1,099–3,400 ms | 客户端最终感受到的主要部分 |
| peer hydrate | 热路径 7–9 ms；冷峰值 982–1,973 ms | 存在明显的冷加载或并发抖动 |
| `_loadHistory` | 864–2,345 ms | 包含下面的平台、写入和读取阶段 |
| QQNT adapter 上游 | 230–1,407 ms | 平台侧有波动，但不能解释全部总耗时 |
| history ingest | 284–565 ms | 75 条消息即使大多已存在也会逐条检查 |
| `PlatformData.readHistory` | 104–164 ms | 随后结果被调用方丢弃，属于重复读取 |
| `readProjectedHistory` | 157–255 ms | 再次读取消息、alias、reaction、sender、part、media |
| sender 组装 | 139–179 ms | TL 返回前又有一轮用户读取/组装 |
| TL projection | 0–2 ms | 纯内存 TL 对象构造很快，不是瓶颈 |

一个 2.521 s 样本的 RPC 分解为：

```text
hydrate=8 ms
load=2,353 ms
select=0 ms
senders=157 ms
project=1 ms
total=2,521 ms
```

对应的 `_loadHistory` 分解为：

```text
anchor=2 ms
PlatformData.getHistory=2,047 ms
users=29 ms
projected read=255 ms
materialize=0 ms
replies=0 ms
total=2,345 ms
```

其中 `PlatformData.getHistory=2,047 ms` 仍不是纯平台耗时，而是：

```text
QQNT upstream=1,407 ms
history ingest=467 ms
readHistory=154 ms
other=约 19 ms
```

所以“platform 侧看起来不慢”和“整个 getHistory 很慢”并不矛盾；relay 在上游返回后仍进行了大量数据库工作。

## 4. 为什么数据库阶段不合理

表上已经存在主要索引，包括：

- `mtproto_im_message(conversationId, timestamp)`
- `mtproto_im_message_alias(messageId)`
- `mtproto_tl_message_part(messageId)`
- `mtproto_tl_message_part(platformSessionId, conversationId, tlMessageId)`
- `mtproto_im_media(messageId)`

当前只有约 1.4 万条消息。按会话和时间索引读取 76 条主消息，本身不应稳定消耗数百毫秒。更可疑的是 ORM 调用形状，而不是数据规模或缺少最基础的分页索引。

### 4.1 读取存在典型 N+1

`_hydrateMessage()` 对每条消息分别查询：

1. aliases；
2. reactions；
3. sender user；
4. conversation。

`readProjectedHistory()` 在上述查询之外，还会为每条消息分别查询：

5. TL message parts；
6. media。

因此读取 76 条 projected messages 至少约为 `2 + 76 × 6 = 458` 次 ORM 查询。前面的 `readHistory()` 又至少约为 `2 + 76 × 4 = 306` 次查询。两次读取合计已经超过 760 次，尚未计入 anchor、用户同步、reply target 和 sender 阶段。

### 4.2 写入也按消息串行检查

`ingestMany()` 虽然在一个事务中执行，但内部依次处理每条消息。对于一条已经存在且未变化的消息，仍可能依次执行 sender get/upsert/get、alias get、message get 和 projection select 等操作。75 条历史消息通常又会产生约 450 次或更多 ORM 调用。

一次热请求因此很容易超过 **1,200 次** ORM/SQLite 往返。单条 SQL 即使很快，大量 Promise、SQL 编译/绑定、行转换和 JSON 编解码累计后也足以形成当前延迟。

### 4.3 写锁不是当前主因，但会放大并发延迟

history ingest 的 profile 中，写队列等待通常只有约 7 ms，执行本身为 284–478 ms，因此当前样本首先指向事务内部的逐条工作，而不是长时间等待写锁。

不过 history ingest 持有串行写队列期间，其他实时消息写入已经出现 30–159 ms 的排队。多个并发 `getHistory` 还会重复拉取和落库同一页，继续放大写队列与上游压力。

## 5. 是否应该从 Minato 换成 TypeORM

当前结论：**不应先做整体替换。**

现有证据能证明调用次数和重复读写有问题，但尚不能证明 Minato 对“相同 SQL、相同调用次数”显著慢于 TypeORM。若把当前 N+1 原样迁移到 TypeORM，查询次数不会减少，实体 hydration 和 unit-of-work 甚至可能增加额外开销。

TypeORM 只有在以下对照完成后仍有价值：

1. 对等 raw SQLite 查询基准确认数据库执行本身很快；
2. Minato 改成批量 `$in` 查询后仍有不可接受的固定开销；
3. 用相同 schema、相同事务、相同 SQL 数量做 Minato / TypeORM / raw driver 对比；
4. TypeORM 能提供项目实际需要且 Minato 无法实现的查询或迁移能力。

短期内直接换 ORM 会扩大改动范围，同时掩盖真正需要修复的数据访问形状。

## 6. Redis 是否适合

Redis 适合作为可选的 Cordis service plugin，但不应替代 SQLite 作为消息、TL ID 分配、update state 和 edit/delete 一致性的事实来源。

### 6.1 适合 Redis 的内容

- 相同会话和窗口的短 TTL projected-history 读穿缓存；
- `platformSessionId + conversationId + tlMessageId` 到 native anchor 的短 TTL 映射；
- peer/user TL projection 缓存；
- 相同 history 请求的 singleflight / 分布式互斥，避免并发重复拉取和重复 ingest；
- 多进程部署时共享会话 revision 和热点页。

建议用“每会话 revision”做失效：任何 new/edit/delete/reaction/media-placeholder-replaced 事件都递增 revision，history cache key 包含该 revision。这样不需要扫描删除旧 key，旧数据由 TTL 自动回收。

### 6.2 不适合 Redis 的内容

- auth key、凭据、TOTP secret 等敏感事实数据；
- TL message ID 的最终分配状态；
- update journal、pts/seq 和未发布 delivery；
- 只依赖 TTL、没有 revision/invalidation 的消息正文缓存。

### 6.3 Redis 不是第一修复点

SQLite 和 relay 在同一进程，而 Redis 至少多一次序列化与网络往返。在保留上千次 ORM 调用的情况下加 Redis，只会绕过部分症状，并引入缓存一致性复杂度。

优先顺序应为：先消除重复读取和 N+1，再用内存缓存验证收益；只有需要多 worker 共享或跨进程 singleflight 时，才把相同接口落到 Redis service。

## 7. 建议实施顺序

### P0：不引入新存储，先修数据访问形状

1. 给 `PlatformData.getHistory()` 增加只同步/落库的路径，避免 `_loadHistory()` 丢弃一次 `readHistory()` 结果后再完整读取。
2. 把 `readProjectedHistory()` 改成批量读取：主消息一条查询，aliases/reactions/users/parts/media 分别一条 `$in` 查询，再用 Map 在内存组装。
3. 批量预取 ingest 所需的 conversation、users、aliases、messages 和 projections；对完全未变化的消息整页快速跳过逐条 upsert。
4. 为相同会话的并发 history 请求增加进程内 singleflight，避免并发重复调用 QQNT 和重复 ingest。
5. 检查 peer hydration 的 TTL、锁和并发复用；热路径只有 7–9 ms，但冷峰值达到 1–2 s。

### P1：加入可重复基准和 SQL 计数

1. 继续使用 `packages/test-suite/src/profile-history.ts` 通过 mtcute 对真实 MTProto 连接重复发送同一个请求。
2. 在 Minato database adapter 边界统计每次 RPC 的 SQL 次数、累计执行时间和最慢 SQL，不记录参数中的消息正文或凭据。
3. 增加 raw SQLite 对照：分页主查询、批量关联查询、事务内 75 条 unchanged ingest。
4. 分别记录冷请求、热请求、两个并发相同请求和媒体未缓存请求。

### P2：实现可选 Redis service 与 history cache

1. 独立 `@mtproto-relay/redis` Cordis plugin，暴露 namespace、JSON、TTL、NX 和关闭生命周期。
2. bridge 只依赖抽象 cache service；未配置 Redis 时使用进程内实现或完全禁用。
3. 首先接 singleflight 和会话 revision，再接 projected-history 页缓存。
4. Redis 不可用时 fail open 回 SQLite，不得使登录和历史读取失败。

### P3：再决定是否做 TypeORM 对照

完成 P0/P1 后，如果批量查询下 Minato 仍占据主要耗时，再做一个限定在 history read path 的 TypeORM/raw driver spike；不要直接迁移整个数据库层。

## 8. 验收目标

建议把“快”拆成平台外开销和端到端两个指标：

- 热缓存、无 QQNT 请求：p50 ≤ 100 ms，p95 ≤ 250 ms；
- 冷请求：relay 自身额外开销 p50 ≤ 150 ms，p95 ≤ 300 ms；
- 端到端冷请求约等于 QQNT upstream + relay 额外开销；
- 相同请求并发时只允许一次上游 fetch/ingest；
- 未缓存媒体不阻塞 history，先返回空占位，生成后通过 edit update 替换；
- edit/delete/reaction/媒体替换后，下一次 history 不得返回旧缓存。

## 9. 当前判断

数据库阶段耗时 **不合理**，但“数据库慢”更准确地说是“当前 Minato 数据访问模式产生了大量重复和 N+1 查询”。现阶段没有证据支持把 TypeORM 作为首要修复；Redis 可以建设为通用 service，并在完成批量化之后承担热点 history cache 和 singleflight，但不能取代持久库和正确的失效机制。
