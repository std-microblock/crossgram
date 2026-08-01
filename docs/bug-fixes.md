# 真实服务稳定性修复记录

基准日期：2026-08-01（周六）

## 生产基线

- [x] 使用只读诊断确认生产 Crossgram 与 QQNT bridge 均在运行。
- [x] 确认 Crossgram 生产 checkout 落后于当前 `main`，生产为 `41130cd`。
- [x] 确认 2C4G 主机上的 Crossgram 常驻内存约 1.3–1.4 GiB，曾产生约 309 MiB swap。
- [x] 确认生产 SQLite 已增长到约 415 MiB，包含约 120k 条消息和约 49k 条 reaction 行。
- [x] 确认约 48.7k 条 reaction 行的 `count=0`，属于把完整可选 catalog 重复写进每条消息造成的写放大。
- [x] 确认 Android 会反复调用 `channels.getFullChannel`；QQNT `/reactions/catalog` 每次固定等待 5 秒后返回 500，形成重试风暴。
- [x] 确认 QQNT bridge 在 30 分钟内收取并写入 WebSocket 约 1124 条消息事件，入口本身没有丢失这些事件。
- [x] 用生产 QQNT 事件流复现到另一条关键阻塞：未存入 relay 历史窗口的消息发生 reaction 时，`setReactions` 抛错，durable checkpoint 固定在同一个 event 并指数退避，后续消息/reaction 全部被堵住。
- [x] 确认历史媒体当前会先返回带 `deferred` 的空 File，再通过 `message-edit` 替换；这正是空图片和二次刷新机制的来源。
- [x] 记录时钟异常：任务基准是 2026-08-01，但生产机报告 2026-08-02 01:01（未来时间），并由 chrony 跟随腾讯云链路本地 NTP。未在共享业务机上盲目回拨。

## 修复 checklist

### 消息推送与漏消息

- [x] 轮询恢复从“只发现新会话”改为检测每个会话的 last-message 游标变化。
- [x] WebSocket 失败或重连时按历史窗口补齐同一会话中的多条漏消息，而不是只补最后一条。
- [x] 对 WebSocket/轮询并发恢复保持幂等，失败后可在下一轮重试。
- [x] dialogs peer hydration 改用独立 `peerRevision`，避免每条消息都让会话/用户缓存失效并反复扫描数据库。
- [x] 未存储 reaction target 改为安全忽略并推进 durable checkpoint；消息以后进入历史时会携带当时的完整 reaction 状态。
- [x] 本地修复版 relay 连接生产 QQNT 后，checkpoint 从 `2273` 连续追到 `37513`，未再卡在未知 reaction target。
- [x] Android AVD 两次停留在会话列表、不进入 chat 的真实入站验证通过，分别在 1289 ms、1264 ms 更新目标群 top message；第二次确认是在已有 dialog 上更新。
- [ ] Android AVD 验证后台、前台、断网重连和重进会话四种状态。

### reaction

- [x] catalog 加缓存、退避和可用的空值回退，禁止把上游 5 秒超时直接返回给 Android。
- [x] 每条消息只持久化实际出现的 reaction，不再复制完整 catalog。
- [x] QQNT bridge 优先从本地 `emoji-resource` 加载 catalog，避免依赖会卡住的 native RPC。
- [x] catalog 回退、实际 reaction 持久化和 recent 容错均有单元/e2e 覆盖。
- [x] 增加“未知 reaction target 后紧跟正常消息”的 durable WebSocket e2e，要求 checkpoint 继续推进且下一条消息落库。
- [ ] Android AVD 验证 reaction 事件到达、资源展示、最近使用顺序与发送。

### 图片、视频与发送性能

- [x] 删除历史媒体的空 File + `message-edit` 首屏机制。
- [x] 原始媒体首次投影即提供可下载 locator，preview 作为缓存优化而不是消息可用性的前置条件。
- [x] 缺失尺寸时从可靠 preview 补齐宽高，避免已有比例信息时仍投影成 1×1 正方形。
- [ ] 图片发送避免同一源重复完整读取，补上传耗时与进度测试。
- [ ] Android AVD 验证横图、竖图、视频、GIF/APNG、贴纸和冷缓存。

### 表情包

- [ ] QQNT 收藏夹作为独立表情包集展示。
- [ ] 商店表情包可在 App 内安装、卸载并持久化。
- [ ] 最近使用、收藏和商店来源的发送路径均不依赖临时空 File。
- [ ] Android AVD 覆盖添加、删除、重启恢复和发送。

### 发布与回归

- [ ] 轻量生产数据回放通过。
- [x] `yarn typecheck` 通过。
- [x] 单元测试 66 个文件、619 个测试全部通过。
- [x] 项目 e2e 15 个文件、107 个测试全部通过，其中 QQNT 消息顺序/断线恢复 12 个测试通过。
- [ ] Android AVD e2e 通过。
- [ ] 分阶段 commit + push。
- [ ] 锁定主工作区后合并主分支、最终回归、push 并清理 worktree/分支。
