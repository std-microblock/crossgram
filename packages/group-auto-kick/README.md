# @mtproto-relay/group-auto-kick

群满员自动踢人插件：当配置的群达到 `maxMembers`（例如满员 2000）时，踢出**最久没有发言**的成员，
把人数据降到 `targetMembers`（例如 1995），从而继续为新人腾出位置。

## 行为

- 每 `intervalMs`（默认 5 分钟）巡检一次；插件启动后、以及平台会话上线后各延迟 `startupDelayMs` 触发一次。
- 先读人数：只有 `人数 >= maxMembers` 才会继续，否则本轮不做任何事。
- 需要踢人时扫描完整群成员列表，并按“最后发言时间”从旧到新排序：
  - 排序依据是 Crossgram 消息库（`mtproto_im_message`）中该群每个发送者的最新消息时间；
  - 在 relay 记录里**从未发言**的成员视为最久没发言，排在最前；
  - 群主、管理员（可关闭）与当前登录账号永远不参与排序。
- 一轮最多踢 `maxKicksPerRound`（默认 10）人，每踢一个间隔 `kickIntervalMs`。
- 踢之前会按成员逐个复查：谁的“最新发言”比排行快照更新（例如刚被踢过又重新加群并发言），本轮就跳过谁，
  把名额让给下一个最久没发言的人；跳过的成员记在日志与本轮结果的 `skippedStale` 里。
- 单个成员踢失败只记录日志，不影响本轮其他成员。

## 配置

群与人数都是配置项，支持配置多个群。配置写在 Cordis 的配置文件里；生产环境的运行配置是
`/opt/crossgram/.runtime/app.yml`（不受 git 跟踪，升级不会覆盖）。

```yaml
- id: group-auto-kick
  name: '@mtproto-relay/group-auto-kick'
  config:
    # 先干跑观察一轮日志，确认踢人名单无误后再改成 false
    dryRun: true
    intervalMs: 300000
    groups:
      # 群可以用平台会话 ID（QQ 群号）
      - conversationId: 1002974327
        label: 示例群
        maxMembers: 2000
        targetMembers: 1995
      # 也可以直接用 Telegram 里看到的群 chat id（-100…）
      - conversationId: '-1000371852035'
        maxMembers: 2000
        targetMembers: 1995
        maxKicksPerRound: 5
        protectAdministrators: true
        rejectAddRequest: false
```

### 群规则字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `conversationId` | 必填 | 平台会话 ID（QQ 群号）或 Telegram 群 chat id（`-100…`）。 |
| `label` | 会话标题 | 仅用于日志的群名。 |
| `platformSessionId` | 全部在线会话 | 限定只在某个平台会话上执行。 |
| `maxMembers` | `2000` | 达到该人数时开始踢人。 |
| `targetMembers` | `1995` | 一轮踢人后要降到的人数，必须小于 `maxMembers`。 |
| `maxKicksPerRound` | `10` | 单轮最多踢出多少人。 |
| `protectAdministrators` | `true` | 保护管理员；群主始终受保护。 |
| `unknownLastSpoke` | `oldest` | relay 记录中从未发言的成员如何排序：`oldest` 视为最久未发言（优先踢出），`newest` 排在所有有记录的人之后，只踢“可测量的最久未发言”。 |
| `rejectAddRequest` | `false` | 踢出时同时拒绝对方再次加群。 |

### 全局字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `dryRun` | `false` | 只记录将要踢出的成员，不真正执行。 |
| `intervalMs` | `300000` | 巡检间隔。 |
| `startupDelayMs` | `30000` | 启动后（及平台会话上线后）首次巡检的延迟。 |
| `kickIntervalMs` | `1000` | 同一轮内两次踢人之间的间隔。 |
| `rankingTtlMs` | `1800000` | “最后发言时间”排行的缓存时长。缓存期间每个候选人在真正被踢前都会重新核对一次最新发言，因此缓存不会导致踢掉刚发言的成员。 |
| `memberPageSize` | `500` | 扫描群成员时分页请求的条数（上游每页实际返回较少，会自动翻页）。 |
| `maxMemberScan` | `5000` | 单次扫描群成员的上限，超出后本轮按已有成员决策。 |
| `scanDeadlineMs` | `60000` | 单次扫描群成员的超时时间。 |
| `maxRankingScan` | `2000000` | 回退扫描消息时的行数上限。 |

## 运维

插件注册了 `ctx.groupAutoKick` 服务，可在调试脚本里手动触发一轮：

```ts
export function apply(ctx: any) {
  void ctx.groupAutoKick.run('manual').then((result: unknown) => ctx.logger('probe').info('%o', result))
  void ctx.groupAutoKick.invalidate()
}
```

## 注意

- “最后发言时间”来自 relay 已入库的消息；relay 上线之前的历史发言无法还原，因此在 relay 记录里
  没有发言的成员会被优先踢出。`dryRun` 可以先确认名单是否符合预期。
- 成员的“沉默”是历史记录，不会因为重新加群而清零：如果被踢的成员重新进群后一直不说话，下一轮仍会
  被选中。要阻断这种反复进群，请把 `rejectAddRequest` 设为 `true`。
- 成员列表需要向平台逐页拉取（QQ 每页约 30 人），因此满员群的一轮巡检需要数十次上游调用，
  请勿把 `intervalMs` 配得过小。
