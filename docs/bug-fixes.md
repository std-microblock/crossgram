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
- [x] Android AVD 在群 `1084013940` 验证 reaction 发送、回流、选中顺序和最近使用；普通 `👍` 不需要 custom document，`selectedOrder=1`、`selectedCount=1`。

### 图片、视频与发送性能

- [x] 删除历史媒体的空 File + `message-edit` 首屏机制。
- [x] 原始媒体首次投影即提供可下载 locator，preview 作为缓存优化而不是消息可用性的前置条件。
- [x] 缺失尺寸时从可靠 preview 补齐宽高，避免已有比例信息时仍投影成 1×1 正方形。
- [ ] 图片发送避免同一源重复完整读取，补上传耗时与进度测试。
- [x] Android AVD 验证 1240×1754 竖图的 direct/relay 两条下载路径与非正方形布局。
- [x] QQNT bridge v1.0.8 暴露原生视频 `thumbPath`；Crossgram `44a8eaf` 对 bridge 本机资源改走认证 asset API并已部署。
- [x] v1.0.9 真实验证发现 Linux QQ `userPath` 缺失会使 asset API 500；v1.0.10 将缺失字段改为运行时容错，v1.0.11 再以服务账号 `$HOME/.config` 作为受限可信根。对应 95 个 QQ kernel 测试通过。
- [ ] v1.0.11 CI、生产部署后重新确认 `tlMessageId=1081568567` 的 640×360 视频缩略图实际显示（v1.0.10 仍因可信根不匹配返回 404）。

### 表情包

- [x] QQNT 收藏夹作为独立 `QQ 收藏表情` 集展示；空收藏夹也保留 set，Android 显示 set ID `403380618`。
- [x] 商店表情包 `股市风云`（pack `11474`）可在 App 内安装并在冷启动后保留，24 个 document 完整可见。
- [x] Android E2E driver 已新增卸载 tombstone/冷启动不恢复，以及“先写最近使用、冷启动、从 recent 再发送”的真实 RPC/落库断言并提交到 `142c854`。
- [ ] 新 driver 的 Java 编译已通过；本机临时签名配置缺失导致 APK package 阶段失败，仍需生成临时 keystore 后完成卸载与 recent-send AVD 实跑。

### 发布与回归

- [x] 轻量生产数据回放通过；durable checkpoint 从 130 持续推进到 146，未知 reaction target 不再阻塞后续事件。
- [x] `yarn typecheck` 通过。
- [x] 单元测试 66 个文件、619 个测试全部通过。
- [x] 项目 e2e 15 个文件、107 个测试全部通过，其中 QQNT 消息顺序/断线恢复 12 个测试通过。
- [ ] Android AVD e2e 全量通过（消息推送、图片、reaction、收藏夹与安装已通过；卸载/recent-send 和 v1.0.11 视频缩略图待最终复测）。
- [x] 分阶段 commit + push；Crossgram、QQNT bridge、Android E2E driver 均已推送独立提交。
- [x] Crossgram 在锁定主工作区后完成 150 个 focused unit、typecheck、107 个 e2e，`44a8eaf` fast-forward 到 `main` 并部署；全量 unit 中仅 Windows 不支持 Unix socket 的既有 voice 测试失败。
- [ ] QQNT bridge 与 Android patcher 合并主分支并清理 worktree/临时代理。

## 发布记录

- Crossgram 生产：`44a8eaf`，服务 active，部署后内存约 818 MiB。
- QQNT bridge：v1.0.7 修复收藏夹空集；v1.0.8 暴露原生视频缩略图；v1.0.9 增加认证 asset API；v1.0.10 修复 Linux 缺失 `userPath` 的异常；v1.0.11 增加服务账号 config root（待 CI/部署）。
- Android E2E patcher：`142c854`，12 个 server-E2E 单元测试及 2 个 runner 测试通过。
