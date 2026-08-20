<div align=center>
<h1>CrossGram</h1>
<div>Bring any chat platform to Telegram clients.</div>
<div>使用 Telegram 客户端在任何平台上聊天</div><br/>
<img src="https://github.com/user-attachments/assets/be1e04db-c621-4d37-9585-43c1fb6bd452" />
</div><br/>

CrossGram 是一个基于 [cordis](https://github.com/cordiverse/cordis) 和 [mtcute](https://github.com/mtcute/mtcute) 的 Telegram 服务器端实现。它将 Telegram 桥接到其它平台，以让你在 Telegram 客户端下获得远超原生客户端的聊天体验。

---

## 支持情况

### 平台实现

| 平台 | 包名 | 状态 |
|---|---|---|
| **QQ（QQNT）** | `@mtproto-relay/platform-qqnt` | ✅ |
| **Discord（userbot）** | `@mtproto-relay/platform-discord` | ✅ |
| **Satori adaptor** | `@mtproto-relay/platform-satori` | ⚠️ 通用核心能力 |
| **Matrix** | `@mtproto-relay/platform-matrix` | ✅（未加密房间） |
| **参考实现（static）** | `@mtproto-relay/platform-static` | ✅ |
| **Satori exporter** | `@mtproto-relay/satori-exporter` | ✅ 独立插件 |
| 微信 / 其它 | — | 🚧 |

> [!CAUTION]
> Discord 适配器自动化普通用户账号（userbot/selfbot），违反 Discord 服务条款，可能导致账号受限或封禁。建议仅使用可承受风险的独立账号。

<details>
<summary>能力矩阵</summary>

> ✅ 已支持 · ⚠️ 部分支持 · ❌ 不会支持 · 🗓️ 在规划中

<details open>
<summary>历史记录 <code>history</code></summary>

| 能力 | QQ（QQNT） | Discord | Matrix | 参考实现（static） |
|---|:---:|:---:|:---:|:---: |
| 历史消息拉取 | ✅ | ✅ | ✅ | ✅ |

</details>

<details open>
<summary>发送 <code>send</code></summary>

| 能力 | QQ（QQNT） | Discord | Matrix | 参考实现（static） |
|---|:---:|:---:|:---:|:---: |
| 文字 | ✅ | ✅ | ✅ | ✅ |
| 图片 | ✅ | ✅ | ✅ | ✅ |
| 文件 | ✅ | ✅ | ✅ | ✅ |
| 图文混排 | ✅ | ✅ | ✅ | ✅ |

</details>

<details open>
<summary>会话类型 <code>conversations</code></summary>

| 能力 | QQ（QQNT） | Discord | Matrix | 参考实现（static） |
|---|:---:|:---:|:---:|:---: |
| 私聊 (direct) | ✅ | ✅ | ✅ | ✅ |
| 群聊 (group) | ✅ | ✅ | ✅ | ✅ |
| 频道 (channel) | ❌ | ✅ | ⚠️ Space | ✅ |
| 子频道 / 话题 (subchannel) | ❌ | ✅ | ❌ | ✅ |
| 群公告（接收） | 🗓️ | ✅ | ❌ | 🗓️ |

</details>

<details open>
<summary>成员与权限 <code>members</code></summary>

| 能力 | QQ（QQNT） | Discord | Matrix | 参考实现（static） |
|---|:---:|:---:|:---:|:---: |
| 成员列表 | ✅ | ✅ | ✅ | ✅ |
| 管理员信息 | ✅ | ✅ | ✅ | ✅ |
| 成员权限 | ❌ | ✅ | ✅ | ✅ |
| 移除群成员 | 🗓️ | ❌ | ❌ | ❌ |
| 入群申请管理 | 🗓️ | ❌ | ❌ | ❌ |
| 管理群公告 | 🗓️ | ❌ | ❌ | ❌ |

</details>

<details open>
<summary>消息操作 <code>messageActions</code></summary>

| 能力 | QQ（QQNT） | Discord | Matrix | 参考实现（static） |
|---|:---:|:---:|:---:|:---: |
| 撤回自己的消息 | ✅ | ✅ | ✅ | ✅ |
| 撤回他人消息（管理员） | ✅ | ✅ | ✅ | ✅ |
| 编辑消息 | 撤回重发 | ✅ | ⚠️ 文字 | ✅ |
| 转发 | ✅ | ✅ | ❌ | ✅ |
| 合并转发 | ✅ | ❌ | ❌ | ❌ |

</details>

<details open>
<summary>消息响应 <code>reactions</code></summary>

| 能力 | QQ（QQNT） | Discord | Matrix | 参考实现（static） |
|---|:---:|:---:|:---:|:---: |
| 读取 | ✅ | ✅ | ❌ | ✅ |
| 发送 | ✅ | ✅ | ❌ | ✅ |
| 实时事件 | ✅ | ✅ | ❌ | ✅ |
| 显示点赞者 | ✅ | ✅ | ❌ | ✅ |

</details>

<details open>
<summary>头像 <code>avatars</code></summary>

| 能力 | QQ（QQNT） | Discord | Matrix | 参考实现（static） |
|---|:---:|:---:|:---:|:---: |
| 用户头像 | ✅ | ✅ | ✅ | ✅ |
| 会话头像 | ✅ | ✅ | ✅ | ✅ |

</details>

<details open>
<summary>表情包 <code>stickers</code></summary>

| 能力 | QQ（QQNT） | Discord | Matrix | 参考实现（static） |
|---|:---:|:---:|:---:|:---: |
| 查看 | ✅ | ⚠️ | ❌ | ✅ |
| 收藏管理 | ✅ | ❌ | ❌ | ✅ |
| 上传/下载 | ❌ | ❌ | ❌ | ❌ |

</details>

<details open>
<summary>其它</summary>

| 能力 | QQ（QQNT） | Discord | Matrix | 参考实现（static） |
|---|:---:|:---:|:---:|:---: |
| 系统消息（灰字） | 🗓️ | ✅ | ❌ | 🗓️ |
| 小程序（Web App） | ❌ | ❌ | ❌ | ❌ |
| Stories / Premium 等 | ❌ | ❌ | ❌ | ❌ |
| 语音 / 视频通话 | ❌ | ❌ | ❌ | ❌ |
| Secret Chat / E2EE | ❌ | ❌ | ❌ | ❌ |
| 红包 / 转账 | ❌ | ❌ | ❌ | ❌ |

</details>
</details>

### 引入 Satori adaptor

CrossGram 可以直接复用 Satori 的 Cordis adaptor。先安装需要的 adaptor（以下以 Discord 为例）：

```bash
yarn add @satorijs/adapter-discord
```

然后按顺序加载 Satori core、adaptor 和通用桥接插件。`bot` 是 Satori 的 Bot SID，格式为
`platform:selfId`；只有一个 Bot 时可省略：

```yaml
- id: satori-core
  name: '@satorijs/core'

- id: discord-adaptor
  name: '@satorijs/adapter-discord'
  config:
    token: your-token

- id: discord
  name: '@mtproto-relay/platform-satori'
  config:
    bot: discord:your-bot-id
```

当前通用映射覆盖账号、消息事件、会话与历史、联系人、成员、文字/媒体收发、编辑、删除及媒体下载；
具体能力仍取决于 adaptor 在 Satori `login.features` 中声明的 API。Satori 4.6 的 npm 包仍携带 Cordis 3
依赖元数据，本仓库通过 Yarn patch 将它适配到 Cordis 4，并为旧 adaptor 保留 HTTP 兼容 API。

### 导入 Telegram 贴纸包

可选插件 `@mtproto-relay/telegram-sticker-importer` 使用一个 Telegram Bot Token 从 Hosted Bot API
读取公开贴纸包。启用 `app.yml` 中的示例并设置 `TELEGRAM_STICKER_IMPORTER_BOT_TOKEN`；只有测试
或 Local Bot API Server 才需要设置可选的 `apiBase`。在 Telegram 客户端打开 **Sticker Importer**
工具 bot，粘贴 `https://t.me/addstickers/<short_name>`，或发送 `/import <url>`。导入的包会立即安装到
当前 bridge 会话；Token 只在服务端用于代理文件下载，不会提供给客户端。每个会话默认最多导入
100 个包，并有 3 秒导入冷却时间；可通过 `maxImportsPerSession` 和 `importCooldownMs` 调整。

### QQ 闪传工具 bot

内置插件 `@mtproto-relay/qq-flash-transfer-bot` 会在 QQNT 会话中注册 **QQ 闪传** 工具 bot。
把一个或多个文件发给它（可附带文字作为文件集名称），bot 会把上传流交给 QQNT 创建闪传，
然后返回 QQ 原生分享链接和文件集 ID。文件字节保持流式传输，不会先整体读入内存；默认单次最多
100 个文件、总计 100 GiB，可通过 `maxFiles` 与 `maxTotalBytes` 调整。

### 导出平台会话到 Satori

Satori exporter 是独立插件 `@mtproto-relay/satori-exporter`，不再由 bridge 配置或管理。
先加载 bridge 和目标平台，再加载 Satori core、Satori server 与 exporter；`platformId` 使用目标平台配置项的 `id`：

```yaml
- id: satori-core
  name: '@satorijs/core'

- id: satori-server
  name: '@satorijs/plugin-server'
  config:
    path: /satori
    token: ${SATORI_TOKEN}

- id: qq-exporter
  name: '@mtproto-relay/satori-exporter'
  config:
    platformId: qqnt
    platform: qq
```

exporter 跟随 bridge 公布的平台会话生命周期注册 Bot，并只转发持久化成功的新入站消息；
Satori core 或目标平台重载时会清理旧 Bot，再从当前活动会话恢复。

## 快速开始

### 1. 启动服务器

```bash
yarn install
yarn dev          # 开发模式
yarn build && yarn start  # 生产模式
```

首次运行会在 `data/rsa-key.json`（和 `.pem`）自动生成 RSA 密钥，不用手动准备。  

<details>
<summary>app.yml 配置</summary>

```yaml
- id: mtproto01
  name: '@mtproto-relay/mtproto'
  config:
    port: 4430
    host: 127.0.0.1
    rsaKeyPath: ./data/rsa-key.json

- id: bridge01
  name: '@mtproto-relay/bridge'
  config:
    dcId: 1
    serverHost: 192.168.1.10
    serverPort: 4430
    altEndpoints:
      - 192.168.1.11:4430
      - bridge-backup.example:8443
      - '[2001:db8::1]:4430'

- id: qqnt   # QQ 平台
  name: '@mtproto-relay/platform-qqnt'
  config:
    endpoint: http://127.0.0.1:18767/v1
    # 默认隐藏“XXX回应了你的消息：XX”灰条；设为 [] 可全部显示
    grayTipFilters:
      - 回应了你的消息

- id: discord   # Discord 普通用户账号（userbot，有封号风险）
  name: '@mtproto-relay/platform-discord'
  config:
    token: YOUR_DISCORD_USER_TOKEN
    proxy: http://127.0.0.1:7890

- id: matrix   # Matrix 平台（一个配置项对应一个账号）
  name: '@mtproto-relay/platform-matrix'
  config:
    homeserver: https://matrix.example.com
    accessToken: replace-with-your-access-token
    # userId: '@alice:example.com'  # 可选，默认自动探测
    proxy: http://127.0.0.1:7890    # 可选；Node 不会自动使用系统代理
```
</details>

`serverHost` 和 `serverPort` 是主地址；`altEndpoints` 是按配置顺序公告的同一 `dcId`
备用地址字符串，格式为 `host:port` 或 `[IPv6]:port`（裸 IPv6 会被拒绝）。bridge 只公告
这些地址，不做健康检查或主动 fallback；是否在主地址不可用时尝试备用地址由客户端决定。首次
启动连接仍使用二进制补丁写入的主地址，因此补丁的 `--host` 和 `--port` 应指向
`serverHost` / `serverPort`。

Matrix 适配器当前支持未加密房间。端到端加密事件会显示明确的占位消息，
不会把密文当作附件下载；完整配置、能力与限制见
[`packages/platform-matrix/README.md`](packages/platform-matrix/README.md)。

启动后浏览器打开 http://127.0.0.1:3140/platform-accounts  
页面上会显示桥接平台的资料、自动分配的虚拟手机号（`+888...`）以及每 30 秒轮换的 6 位登录码，这些就是客户端登录要用的。QQ 账号会稳定映射，例如 QQ `1234567890` 对应 `+888 123 456 7890`。

---

### 2. 给 Telegram 客户端打补丁

用脚本直接修改二进制文件，替换公钥和服务器地址，不用重新编译。

<details>
<summary>支持修补的客户端</summary>

| 客户端 | 系统 | 状态 |
|---|---|---|
| Telegram Desktop 及其分支 | Windows / macOS / Linux | ✅ |
| 基于 TDLib 的客户端（Unigram 等） | Windows / Linux | ⚠️ |
| Telegram Android 及分支 | Android | 🚧 |
| Telegram Web / WebK | 浏览器 | 🚧 |
| Telegram iOS | iOS | 🚧 |
| 官方 macOS 原生客户端 | macOS | ❌ |
</details>

#### 用法

脚本位置：`binary_patch/patch-tdesktop.cjs`

```bash
node binary_patch/patch-tdesktop.cjs /Applications/materialgram.app
node binary_patch/patch-tdesktop.cjs --port 4430 /usr/bin/telegram-desktop
node binary_patch/patch-tdesktop.cjs --host 192.168.1.10 --port 4430 --no-resign "Telegram.exe"
```

默认会：
- 自动用 `data/rsa-key.json.pem` 替换客户端内的 RSA 公钥（也可 `--key` 指定别的 PEM）
- 把所有内置 DC 地址改成 `--host`（默认 `127.0.0.1`），端口改成 `--port`（默认 `4430`）
- 服务端的 `help.getConfig` 只公布 bridge 配置的单个 `dcId`；补丁仍改写所有内置地址，防止客户端绕回官方 Telegram
- 生成 `<binary>.original` 备份，macOS 上自动 `codesign` 重签名并去除隔离属性

<details>
<summary>全部参数说明</summary>

| 参数 | 说明 | 默认值 |
|---|---|---|
| `--key <file>` | RSA 公钥 PEM（PKCS#1） | 自动找 `data/rsa-key.json.pem` |
| `--host <ip>` | 重定向所有 DC 到的 IPv4 | `127.0.0.1` |
| `--port <n>` | 重定向端口 | `4430` |
| `--no-resign` | 跳过 macOS 重签名 | 关闭 |
| `--no-backup` | 不生成 `.original` 备份 | 关闭 |
| `--dry-run` | 只打印修改位置，不实际写入 | 关闭 |
</details>

---

### 3. 登录

1. 启动打好补丁的客户端。
2. 输入页面上显示的虚拟手机号（`+888...`）。
3. 输入当前显示的 6 位登录码。
4. 进入主界面后，就能看到桥接过来的会话和消息了。

## 设计文档

- [Telegram 消息 ID 分配](docs/MESSAGE_ID_ALLOCATION.zh.md)
- [跨平台 IM 接口](docs/IM_PLATFORM.zh.md)

## License

MIT
