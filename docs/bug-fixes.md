# 真实服务稳定性修复记录

基准日期：2026-08-01（周六）

> 生产机曾错误报告 2026-08-02；本文所有测试和发布记录均按真实日期 2026-08-01 记载。

## 生产基线与根因

- [x] 使用只读诊断确认生产 Crossgram 与 QQNT bridge 均在运行，整个排查过程未在 2C4G 生产机编译。
- [x] 确认生产 SQLite 约 415 MiB，包含约 12 万条消息和约 4.9 万条 reaction 行；其中约 4.87 万条 `count=0`，根因是把完整可选 reaction catalog 重复写入每条消息。
- [x] 确认 Android 会重复调用 `channels.getFullChannel`，而旧 QQNT `/reactions/catalog` 每次等待 5 秒后返回 500，形成重试风暴和空白 reaction。
- [x] 确认生产 QQNT 的 WebSocket 入口持续收到消息；实际“漏消息”根因之一是未知 reaction target 令 durable checkpoint 固定在同一事件并指数退避，后续消息和 reaction 全部被堵住。
- [x] 确认旧历史媒体先返回带 `deferred` 的空 File，再依赖 `message-edit` 替换，直接造成空图片、二次刷新和首屏延迟。
- [x] 确认部分竖图/视频缩略图缺少或丢失尺寸，Android 因而先按 1:1 模糊占位渲染；打开媒体后读取原文件才显示正确比例。

## 修复 checklist

### 1. 消息推送与漏消息

- [x] 轮询恢复从“只发现新会话”改为检测每个会话的 last-message 游标变化。
- [x] WebSocket 失败或重连时按历史窗口补齐同一会话中的多条消息，而不是只补最后一条。
- [x] WebSocket 与轮询并发恢复保持幂等；单次失败不会永久吞掉后续事件。
- [x] dialogs peer hydration 使用独立 `peerRevision`，避免每条消息都使会话/用户缓存失效并触发数据库重扫。
- [x] 未存储的 reaction target 改为安全忽略并推进 durable checkpoint；目标消息日后进入历史时仍携带 QQNT 的权威 reaction 状态。
- [x] 增加“未知 reaction target 后紧跟正常消息”的 durable WebSocket e2e，断言 checkpoint 继续推进且下一条消息落库。
- [x] 真实 AVD 停留在会话列表、不进入 chat 时，目标 dialog 分别在约 1050 ms、1544 ms、3034 ms 更新。
- [x] 最新真实入站 platform message `7669148284060173304` 已落生产 DB：message `127597`、conversation `479613101`、TL message `1077858887`；测试窗口内生产 checkpoint 从 43 推进到 49。

### 2. Reaction

- [x] catalog 增加缓存、退避和空值回退，不再把上游 5 秒超时直接暴露给 Android。
- [x] 每条消息只持久化实际出现的 reaction，不再复制完整 catalog。
- [x] QQNT bridge 优先从本地 `emoji-resource` 发现 catalog，避免依赖可能阻塞的 native RPC。
- [x] catalog 回退、实际 reaction 持久化、recent 容错和 checkpoint 前进均有单元/e2e 覆盖。
- [x] 在真实群聊完成 `👍` reaction E2E：`selectedOrder=1`、`selectedCount=1`，发送、回流和选中状态均正常。
- [x] recent/order/custom-document 冷启动检查通过，reaction 不再先显示空白再等待很久补资源。

### 3. 图片、视频与发送性能

- [x] 删除历史媒体的空 File + `message-edit` 首屏机制；首次投影即提供可下载 locator。
- [x] preview 仅作为缓存优化，不再是消息可用性的前置条件。
- [x] 缺失尺寸时从可靠 preview 补齐宽高，已有比例信息时不再退化为 1×1 正方形。
- [x] 图片上传改为单次流式读取并直接进入有界 Highway 请求，避免重复完整读取和额外文件落盘；对应 upload protocol 单元测试通过。
- [x] Android AVD 验证 1240×1754 竖图的 direct/relay 下载、非正方形布局和完整大图打开。
- [x] QQNT bridge 暴露原生视频 `thumbPath`，Crossgram 对 bridge 本机资源走认证 asset API。
- [x] QQNT bridge v1.0.11 在 Linux QQ 缺少 `userPath` 时，以服务账号 `$HOME/.config` 作为受限可信媒体根。
- [x] 真实视频 TL message `1081568567` 为 640×360、5 秒；认证 asset API 返回 9064 bytes preview，AVD 已显示正确 16:9 缩略图，不再白屏或正方形模糊占位。
- [x] 文本真实发送 wall time 约 2720 ms；图片/贴纸发送均走新直传/确认链路，不再等待空消息后续 edit。

### 4. 表情包

- [x] QQNT 收藏夹稳定作为独立 `QQ 收藏表情` set 展示；空收藏夹也保留，Android set ID `403380618`。
- [x] 商店包 `股市风云`（provider `qqnt:stickers`、pack `11474`、set ID `1025487121`）可在 App 内安装，24 个 document 完整可见。
- [x] 卸载真实 E2E 通过：DB `uninstalled=1`，force-stop/restart 后只剩收藏夹，商店包不会被重新恢复。
- [x] recent sticker 冷启动重发真实 E2E 通过：document `1167901003`，首次 TL message `1082059815`，冷启动后从 recent 再发 TL message `1082059975`，两次均为同一 document。
- [x] 测试消息发送到用户允许的 conversation `479613101`，未向无关会话发送测试内容。
- [x] Android driver 的卸载 tombstone、冷启动不恢复、recent 写入及重发断言已合入 `main`；14/14 runner/source tests 通过，新 APK 已构建并安装到 AVD。

## 发布与回归

- [x] Crossgram focused unit 150/150、项目 e2e 107/107、typecheck 全部通过；全量 unit 仅有 Windows 不支持 Unix socket 的既有 voice 测试限制。
- [x] QQNT bridge typecheck、102 个 QQ kernel tests、除 Windows Unix-socket media gateway 外的完整 Vitest 套件，以及 native Rust tests 通过。
- [x] Android patcher `tests/server-e2e.test.ts` 与 `tests/e2e-run-command.test.ts` 共 14/14 通过。
- [x] Crossgram 生产运行 `44a8eaf`，服务 active。
- [x] QQNT bridge v1.0.11 已部署，ready=true、protocolVersion=19；生产资源 API 和视频缩略图复测通过。
- [x] QQNT bridge 可靠性改动已与 voice-call relay 主线整合并推送 `master`（`69bcce7`）。
- [x] Android sticker lifecycle E2E 已合并并推送 `main`（`8482e27`）。
- [x] 最新生产资源占用约为 Crossgram 1.03 GiB、QQNT bridge 381 MiB、swap 492 MiB；两项 systemd 服务 `NRestarts=0`。
- [x] 已停止临时 relay、SSH tunnel 和远端 `crossgram-e2e-qqnt-proxy.service`，并删除临时代理脚本与本地 E2E 配置/截图目录。
- [ ] 将本文合入 Crossgram `main`，并删除已合并的 worktree/临时分支。

## 证据

- 视频缩略图 AVD 截图：`.runtime/v111-thumb.png`（测试 worktree 本地证据，不提交二进制）。
- 生产视频 asset：message `7669015325778525444`，`kind=image`，length `9064`。
- 最新生产入站：platform `7669148284060173304` → DB message `127597` → TL message `1077858887`。
- 表情包 recent 冷启动重发：document `1167901003` → TL `1082059815` / `1082059975`。
