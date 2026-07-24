# Telegram 消息 ID 分配

本文档描述桥接消息如何从平台时间戳映射到 Telegram 的 32 位 `message.id`，以及私聊、群聊、历史回填和同秒冲突的处理方式。

## 目标与约束

Telegram 的消息 ID 是正的 signed int32，因此可用范围是 `1..0x7fffffff`。

桥接层需要同时满足：

- 私聊消息 ID 在整个账号内唯一，并在每个私聊内递增。
- channel / megagroup 消息 ID 在各自频道内唯一并递增。
- 历史消息可能晚于新消息写入数据库，不能依赖写入顺序生成 ID。
- QQ 普通消息有 per-chat 递增的 `msgSeq`，但灰条等服务消息不一定占用 `msgSeq`。
- 一条平台消息可能投影为多条 Telegram 消息，例如多媒体消息的多个 part。

## 唯一域

每个唯一域拥有独立的时间 epoch 和已占用 ID 集合。

| 会话类型 | 唯一域 | 效果 |
|---|---|---|
| 私聊 `direct` | `account:<platformSessionId>` | 同一账号下所有私聊共用一张映射表，ID 不能跨私聊重复。 |
| 群聊 `group` | `channel:<platformSessionId>:<conversationId>` | 每个群独立分配，不同群可以出现相同 ID。 |
| 频道 `channel` | `channel:<platformSessionId>:<conversationId>` | 每个频道独立分配。 |
| forum 子频道 | 父频道的 channel scope | Telegram topic 属于同一个 megagroup，因此与父频道共用消息 ID 域。 |

数据库通过 `mtproto_tl_message_part(scope, tlMessageId)` 唯一约束保证域内不会产生重复 ID。

## 时间戳编码

每秒预留 16 个 slot：

```text
bucket = (timestampSeconds - epoch) * 16
tgid   = bucket + slot
slot   = 0..15
```

实现使用乘法而不是 JavaScript 位运算，避免位运算把数值强制转换为 signed int32。

16 slot 占用 4 bit，剩余 27 bit 表示相对秒数：

```text
最大相对秒数 = floor((0x7fffffff - 15) / 16)
             = 134217727 秒
```

完整窗口约为 1553.4 天，即 4.25 年。

由于 Telegram message ID 必须大于零，`timestamp == epoch` 的第一个 bucket 不使用；有效相对秒从 `1` 开始。

## Epoch

epoch 按唯一域持久化在 `mtproto_message_id_epoch` 中。一个 scope 第一次分配消息 ID 时，将首条消息放在 ID 空间中点：

```text
initialRelativeSecond = 0x40000000 / 16
epoch = firstTimestamp - initialRelativeSecond
```

因此默认可同时容纳约 2.13 年历史和约 2.13 年未来消息。epoch 一旦写入便保持稳定，进程重启不会改变既有映射。

如果消息时间戳超出该 scope 的约 4.25 年窗口，分配器会明确报错；不能通过截断或取模继续分配，否则会破坏递增关系并与旧消息碰撞。需要扩大窗口时，应降低每秒 slot 数或执行显式的全量 ID 迁移。

## Slot 与邻秒插空

分配器首先尝试目标秒的 `slot 0..15`。带有原生消息序号的消息不会从
`slot 0` 开始连续填充，而是从当前可用 slot 的中位数开始，再向两侧展开。
这样即使同秒消息按 `100, 102, 101` 的顺序到达，迟到的 `101` 通常仍有空间插入
`100` 和 `102` 的 Telegram ID 之间。

没有原生消息序号的灰条等消息仍从较小的空闲 slot 开始分配。如果本秒 slot
已满，则搜索相邻秒：

- live 消息优先搜索后一秒，再搜索前一秒。
- history 消息优先搜索前一秒，再搜索后一秒。
- 一条消息投影为多个 part 时优先向后扩展，使 part ID 保持递增。

例如目标 bucket 为 `1600`：

```text
本秒：1600..1615
live 溢出优先：1616..1631
history 溢出优先：1584..1599
```

搜索不是覆盖写入。候选 ID 必须同时满足：

1. 在 signed int32 正数范围内；
2. 在当前唯一域中未被占用；
3. 第一轮不越过同一 chat 中相邻 `msgSeq` 消息的 ID 边界。

第三条在有空间时保证私聊共用账号映射表的情况下，即使其它私聊占用了目标秒
附近的 slot，也不会把当前消息插到本 chat 的上一条消息之前或下一条消息之后。

如果旧数据或极端乱序已经让两个相邻 `msgSeq` 占用了连续 Telegram ID，严格区间
内将不存在任何整数。此时分配器会进行第二轮邻近搜索，忽略序号边界并选择附近
空闲 slot。这个回退可能让极少数消息的 Telegram ID 顺序与 `msgSeq` 不一致，但会
优先保证消息成功持久化，避免单条消息阻塞整条平台事件流。

## QQ `msgSeq` 与灰条

`msgSeq` 不再直接参与 ID 数值编码；时间戳决定 preferred bucket。`msgSeq` 仍会持久化为 `nativeSequence`，用于：

- 限制同一 chat 内历史回填的上下边界；
- 将 QQ `replayMsgSeq` 解析到目标消息的实际 Telegram ID；
- 在目标消息占用了非零 slot 或邻秒 slot 时仍能正确生成 reply header。

没有 `msgSeq` 的灰条使用同一时间戳 bucket 的空闲 slot。本秒满时同样按 history/live 方向在邻秒插空。

## 历史消息与迁移

消息投影记录包含 `allocationVersion`。旧记录没有当前版本，或仍使用旧的 scope 时，在消息再次载入后会删除旧投影并按时间戳规则重新分配。

历史同步不再从某个中点简单递减，而是直接根据消息时间戳定位 preferred bucket。
正常密度下，历史页以任意顺序写入时，时间桶和中位 slot 策略会为乱序消息保留
插入空间；如果整数区间已经被旧数据完全夹紧，则使用上述邻近回退。

## 容量示例

- 同一账号可以保存任意数量的私聊会话；它们竞争账号 scope 中的 16 slot/秒，并可使用邻秒空位。
- 不同群拥有独立 scope，所以两个群在同一秒都可以使用相同的 `tgid`。
- 单个 scope 的理论 ID 容量接近 `2^31`，时间覆盖约 4.25 年。
- 100 万条消息只占整个 ID 空间的一小部分；真正的限制是某个 scope 内消息时间跨度和局部同秒密度，而不是会话数量。
