# Crossgram

Crossgram 是基于 [cordis](https://github.com/cordiverse/cordis) 4 和 [mtcute](https://github.com/mtcute/mtcute) 的 Telegram 服务器端实现。服务器把 QQ 等 IM 平台的账号映射为 Telegram 账号，把平台上的会话、消息和成员转换为 Telegram API 的对象。经过修改、能够连接自定义服务器的 Telegram 客户端登录该账号后，即可收发平台消息。本文说明服务器的组成、各平台的支持范围、服务器部署、客户端接入与登录方式，以及随服务器提供的扩展功能。

<div align=center>
<img src="https://github.com/user-attachments/assets/be1e04db-c621-4d37-9585-43c1fb6bd452" />
</div>

## 系统组成

Crossgram 由一组 cordis 插件组成，插件及其配置在 [app.yml](app.yml) 中声明。处理 Telegram 客户端请求的核心插件有三类：

- **MTProto 服务**（`@mtproto-relay/mtproto`）：监听 Telegram 客户端连接，负责 MTProto 传输、加密握手和 auth key 存储。首次启动时，服务在 `data/rsa-key.json` 生成服务器 RSA 密钥对，并把公钥另存为 `data/rsa-key.json.pem`；客户端必须使用这个公钥才能与服务器握手。
- **bridge**（`@mtproto-relay/bridge`）：实现 Telegram API 方法，包括登录、会话列表、历史消息、媒体收发和更新推送。bridge 把平台数据转换为 Telegram 对象，为平台消息分配 Telegram 消息 ID，并通过 update store 持久化客户端需要补拉的更新。bridge 还在 WebUI 中提供平台账号、表情包和 bot 的管理页面。
- **平台适配器**（`@mtproto-relay/platform-*`）：连接具体 IM 平台，实现 bridge 定义的 `IMPlatform` 接口。

`app.yml` 中的每个平台适配器配置项对应一个平台账号，也对应一个可登录的 Telegram 身份。适配器通过 capabilities 声明平台支持的操作，例如能否编辑消息、撤回时限和单条消息的媒体数量上限；bridge 依据声明决定向客户端开放的功能，并把平台不支持的请求作为 Telegram 错误返回。接口约定见 [IMPlatform 适配器实现规范](docs/IM_PLATFORM.zh.md)。

## 平台支持

各适配器连接的对象和完成程度如下：

| 平台 | 包名 | 连接对象 | 完成程度 |
|---|---|---|---|
| QQ | `@mtproto-relay/platform-qqnt` | 注入 QQNT 的 qqnt-bridge 本地服务 | 主要目标平台，功能最完整 |
| Discord | `@mtproto-relay/platform-discord` | Discord 普通用户账号（userbot） | 收发、频道与子频道、回应 |
| Matrix | `@mtproto-relay/platform-matrix` | homeserver 的 Client-Server API | 仅支持未加密房间 |
| Satori | `@mtproto-relay/platform-satori` | 任意 Satori cordis adaptor | 能力取决于 adaptor |
| 微信 | `@mtproto-relay/platform-wechat` | Windows 上的 ComWeChat HTTP API | 只接收消息 |
| static | `@mtproto-relay/platform-static` | 内存中的模拟数据 | 参考实现，用于测试 |

QQ 适配器的源码位于 `packages/platform-crossgram`。适配器通过 HTTP 调用 qqnt-bridge 的 API，通过 WebSocket 接收有序的事件流；图片、视频等消息媒体保持 QQ 原始格式，由客户端从 QQ CDN 直接下载。

> [!CAUTION]
> Discord 适配器以普通用户账号的身份自动操作，违反 Discord 服务条款，账号可能因此受限或被封禁。请仅使用能够承受该风险的独立账号。

### 能力对照

下表比较 QQ、Discord、Matrix 和 static 适配器声明的能力。Satori 和微信适配器的能力范围另见下文。

| 能力 | QQ | Discord | Matrix | static |
|---|:---:|:---:|:---:|:---:|
| 历史消息 | ✓ | ✓ | ✓ | ✓ |
| 已读状态同步 | 仅标记已读 | ✓ | ✓ | ✓ |
| 消息搜索 | ✓ | ✗ | ✗ | ✗ |
| 发送文字、图片、文件、图文混排 | ✓ | ✓ | ✓ | ✓ |
| 私聊与群聊 | ✓ | ✓ | ✓ | ✓ |
| 频道 | ✗ | ✓ | Space | ✓ |
| 子频道（Telegram 话题） | ✗ | ✓ | ✗ | ✓ |
| 成员列表与管理员 | ✓ | ✓ | ✓ | ✓ |
| 成员权限 | ✗ | ✓ | ✓ | ✓ |
| 设置管理员 | ✓ | ✗ | ✗ | ✓ |
| 禁言与移出成员 | ✓ | ✗ | ✗ | ✗ |
| 好友与入群申请 | ✓ | ✗ | ✗ | ✗ |
| 撤回消息 | ✓<sup>[1]</sup> | ✓ | ✓ | ✓ |
| 编辑消息 | 撤回后重发<sup>[1]</sup> | ✓ | 仅纯文本 | ✓ |
| 转发 | ✓ | ✓ | ✗ | ✓ |
| 合并转发 | ✓ | ✗ | ✗ | ✗ |
| 回应（reaction） | ✓ | ✓ | ✗ | ✓ |
| 表情包 | 收藏表情 | 作为图片接收 | ✗ | ✓ |
| 系统提示（灰条） | ✓<sup>[2]</sup> | ✓ | ✗ | ✗ |
| 戳一戳 | ✓ | ✗ | ✗ | ✗ |
| 语音消息与转写 | ✓ | ✗ | ✗ | ✗ |
| 群文件 | ✓ | ✗ | ✗ | ✗ |
| 语音通话 | 私聊<sup>[3]</sup> | ✗ | ✗ | ✗ |

[1] QQ 只允许撤回 120 秒内的消息。QQ 不支持编辑已发送的消息，适配器在 120 秒内以撤回原消息并发送新消息的方式实现编辑。

[2] `grayTipFilters` 列出需要隐藏的灰条文字。默认配置隐藏“回应了你的消息”灰条，因为同一事件已经以消息回应的形式显示。

[3] 语音通话需要单独运行 voice-worker，见 [voice-worker](packages/voice-worker/README.md)。如果 bridge 未配置 `voiceWorkerSocketPath`，那么通话不可用。视频通话不受支持。

所有适配器都不支持 Secret Chat、Stories、Premium、红包和转账。群公告既不显示也不能管理。Matrix 适配器不解密端到端加密事件，这类事件显示为占位消息；配置与限制见 [Matrix 适配器文档](packages/platform-matrix/README.md)。

### 微信

微信适配器连接 Windows 上的 ComWeChat。适配器通过 `endpoint` 调用 ComWeChat 的 HTTP API，并在本机 `callbackPort` 端口上监听 ComWeChat 推送的消息回调。适配器只提供接收能力：账号资料、联系人会话、群成员和实时文字消息可以同步，媒体消息显示为文字说明，发送消息和历史消息不可用。部署方式和安全注意事项见 [微信适配器文档](packages/platform-wechat/README.md)。

### Satori

`@mtproto-relay/platform-satori` 把 Satori 的 cordis adaptor 接入 bridge，因此 Satori 生态已有的 adaptor 都可以作为平台使用。配置时依次加载 Satori core、adaptor 和适配器。适配器的 `bot` 字段是 Satori 的 Bot SID，格式为 `platform:selfId`；如果只有一个 Bot，那么可以省略。以 Discord adaptor 为例：

```bash
yarn add @satorijs/adapter-discord
```

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

适配器覆盖账号、消息事件、会话列表、联系人、成员、文字与媒体收发、媒体下载。历史消息、成员列表、撤回和编辑需要 adaptor 在 Satori `login.features` 中声明对应 API，未声明的功能不会向客户端开放。适配器不支持转发、回应和表情包。

Satori 4.6 的 npm 包仍声明依赖 cordis 3。本仓库通过 Yarn patch 把 `@satorijs/core` 和 `@satorijs/plugin-server` 适配到 cordis 4，并为依赖旧接口的 adaptor 保留 HTTP 兼容 API。

## 部署服务器

### 本地运行

服务器需要 Node.js 24 或更高版本，以及通过 corepack 启用的 Yarn 4。

```bash
corepack enable
yarn install
yarn dev                  # 开发模式，启用热重载
yarn build && yarn start  # 生产模式
```

`yarn dev` 和 `yarn build` 都会先构建 WebUI。首次启动时，服务器在 `data/` 下生成 RSA 密钥、auth key 存储文件和 SQLite 数据库 `cordis.db`。WebUI 位于 `http://127.0.0.1:3140`。

普通运行不需要 Rust 或 C++ 工具链。只有语音通话使用的 voice-worker 和 `native/` 下的 tgcalls 封装需要原生构建，构建环境由 [flake.nix](flake.nix) 提供。

### 配置

服务器的网络配置分两部分：MTProto 服务的 `host` 和 `port` 决定实际监听的地址，bridge 的 `serverHost` 和 `serverPort` 决定在 `help.getConfig` 中向客户端公布的地址。服务器位于 NAT 或反向代理之后时，两组地址可能不同；`serverHost` 必须是客户端能够访问的地址。

```yaml
- id: mtproto01
  name: '@mtproto-relay/mtproto'
  config:
    host: 0.0.0.0
    port: 4430
    rsaKeyPath: ./data/rsa-key.json
    authKeyStorePath: ./data/auth-keys.json

- id: bridge01
  name: '@mtproto-relay/bridge'
  config:
    dcId: 1
    serverHost: 192.168.1.10
    serverPort: 4430
    altEndpoints:
      - bridge-backup.example:8443
      - '[2001:db8::1]:4430'

- id: qqnt
  name: '@mtproto-relay/platform-qqnt'
  config:
    endpoint: http://127.0.0.1:18767/v1
    token: your-qqnt-bridge-token
```

bridge 在 `help.getConfig` 中只公布 `dcId` 指定的一个 DC。`altEndpoints` 是该 DC 的备用地址，按配置顺序排在主地址之后公布，格式为 `host:port` 或 `[IPv6]:port`。bridge 只公布备用地址，不检查地址是否可用；主地址不可用时是否改用备用地址，由客户端决定。客户端首次连接时尚未获取服务器配置，因此使用客户端内置的地址；该地址应与 `serverHost` 和 `serverPort` 一致。

QQ 适配器的 `token` 是 qqnt-bridge 的访问令牌。如果配置中未提供 `token`，那么适配器读取环境变量 `QQNT_BRIDGE_TOKEN`。适配器默认通过 `${endpoint}/events/ws` 接收事件；如果事件流使用不同的地址，那么可以用 `webSocketEndpoint` 单独指定。其它适配器的配置见 [app.yml](app.yml) 和各适配器文档。

### Linux 生产部署

[deploy/](deploy/README.md) 提供 Linux 上的 systemd 部署方式。安装脚本创建 `crossgram` 系统用户，把仓库检出到 `/opt/crossgram`，并把数据保存在 `/var/lib/crossgram/data`。生产配置使用 PostgreSQL 存储数据，并让 WebUI 只监听 `127.0.0.1:3140`，因此需要通过 SSH 隧道或反向代理访问 WebUI。

```sh
curl -fsSL https://raw.githubusercontent.com/std-microblock/crossgram/main/deploy/install.sh \
  | sudo CROSSGRAM_PUBLIC_HOST=203.0.113.10 sh
```

安装脚本不创建数据库，也不生成密钥。首次启动前，需要运行 `deploy/provision-postgres.sh` 创建 PostgreSQL 角色和数据库，并在 `/etc/crossgram.env` 中设置 Telegram Bot API 使用的 `TELEGRAM_BOT_TOKEN_VERIFIER_SECRET`。之后通过 `sudo crossgram-update` 更新：更新脚本只接受 `origin/main` 的快进合并，重新安装依赖、构建并重启服务，不修改数据目录。完整步骤见 [Linux 部署文档](deploy/README.md)。

## 连接 Telegram 客户端

官方 Telegram 客户端内置官方服务器的地址和 RSA 公钥，客户端只与持有对应私钥的服务器完成握手。连接 Crossgram 需要把这两项替换为 Crossgram 服务器的地址和 `rsa-key.json.pem` 中的公钥。替换方式有两种：使用从源码修改的预构建客户端并在登录页导入服务器配置，或者用二进制补丁直接改写已安装的 Telegram Desktop。

### 预构建客户端

[crossgram-project](https://github.com/crossgram-project) 组织下的 patcher 仓库修改上游客户端的源码，并在 GitHub Releases 发布构建产物。除服务器选择外，Android 和桌面端的修改还使客户端能够直接从平台 CDN 下载媒体、利用 QQ 秒传上传文件，并显示戳一戳、合并转发和已撤回消息。

| 仓库 | 上游客户端 | 系统 |
|---|---|---|
| [crossgram-desktop](https://github.com/crossgram-project/crossgram-desktop) | Telegram Desktop、64Gram、AyuGram、materialgram | Windows、macOS、Linux |
| [crossgram-android](https://github.com/crossgram-project/crossgram-android) | Telegram、Nagram、Nnngram、Nullgram、Mercurygram、Forkgram | Android |
| [crossgram-unigram](https://github.com/crossgram-project/crossgram-unigram) | Unigram | Windows |
| [crossgram-telegram-x](https://github.com/crossgram-project/crossgram-telegram-x) | Telegram X | Android |
| [crossgram-mithka](https://github.com/crossgram-project/crossgram-mithka) | Mithka | Android、iOS、桌面 |

Unigram、Telegram X 和 Mithka 基于 TDLib，三者共用 [crossgram-tdlib](https://github.com/crossgram-project/crossgram-tdlib) 对 TDLib 的修改。Telegram Web 和官方 iOS、macOS 原生客户端没有对应的 patcher。

这些客户端在登录页提供服务器选择，每个账号可以分别选择服务器，也可以继续使用官方 Telegram 服务器。服务器以 JSON 描述，所有客户端使用相同的格式：

```json
{
  "name": "Crossgram",
  "enable_special_config": false,
  "host": "203.0.113.10",
  "port": 4430,
  "rsa_key": "-----BEGIN RSA PUBLIC KEY-----\n...\n-----END RSA PUBLIC KEY-----",
  "dcs": [{ "id": 1, "ip": "203.0.113.10", "port": 4430 }]
}
```

`rsa_key` 是 PKCS#1 格式的服务器公钥，`dcs` 列出各 DC 的地址，缺少的 DC 1–5 由客户端按 `host` 和 `port` 补齐。`enable_special_config` 为 `false` 时，客户端不使用 Telegram 的 special config 机制获取官方备用地址。WebUI 的平台账号页面和平台管理 bot 的 `/server` 命令按 bridge 的 `serverHost` 和 `serverPort` 输出该 JSON；生产部署中也可以用 `crossgram-client-config --host <IP> --port 4430` 生成。

### 二进制补丁

[patch-tdesktop.cjs](binary_patch/patch-tdesktop.cjs) 直接改写 Telegram Desktop 及其分支的可执行文件，无需重新编译。脚本替换客户端内置的生产、测试和 special config RSA 公钥，把所有内置 DC 的 IPv4 和 IPv6 地址改为 `--host`，并把内置 DC 表中的端口 443 改为 `--port`。改写后，脚本检查文件中不再残留官方公钥、地址和端口；如果有残留，或者文件中找不到替换后的公钥，那么脚本报告不支持该文件并退出。

```bash
node binary_patch/patch-tdesktop.cjs /Applications/materialgram.app
node binary_patch/patch-tdesktop.cjs --host 192.168.1.10 --no-resign Telegram.exe
```

| 参数 | 作用 | 默认行为 |
|---|---|---|
| `--key <file>` | 指定 PKCS#1 格式的 RSA 公钥 | 在仓库、脚本目录和工作目录的 `data/` 下查找 `rsa-key.json.pem` |
| `--host <ip>` | 内置 DC 的目标地址，仅接受 IPv4 | `127.0.0.1` |
| `--port <n>` | 内置 DC 的目标端口 | `4430` |
| `--no-resign` | 不对 macOS 应用重新签名 | 重新签名并移除隔离属性 |
| `--no-backup` | 不生成备份 | 生成 `<binary>.original`，已存在时不覆盖 |
| `--dry-run` | 只输出修改位置，不写入文件 | 写入文件 |

二进制补丁把地址固定写入客户端，`--host` 和 `--port` 应与 bridge 的 `serverHost` 和 `serverPort` 一致。

## 登录

bridge 为每个平台账号分配 `+888` 开头的虚拟手机号。QQ 账号的手机号由 QQ 号确定，例如 QQ 号 `1234567890` 对应 `+888 1234567890`；其它平台的账号分配随机的 12 位号码，分配后保持不变。

登录码是 6 位的 TOTP 码，每 30 秒更新一次，服务器只接受当前时间段的登录码。服务器不向客户端发送登录码，用户需要在以下位置查看：

- WebUI 的平台账号页面（`/platform-accounts`）显示每个账号的虚拟手机号和当前登录码。
- 已登录的客户端中，平台管理 bot `@CrossGramAdminBot` 可以显示登录码，用于登录其它设备，也可以批准其它设备的二维码登录。

在客户端中输入虚拟手机号和当前登录码即可登录。如果在 WebUI 中为账号设置了登录密码，那么输入全零的登录码（如 `000000`）后，客户端进入密码验证步骤。

## 扩展功能

以下功能由独立的 cordis 插件或 bridge 的可选模块提供，可以在 `app.yml` 中单独启用或停用。

### 合并转发查看

`@mtproto-relay/merged-forward` 把 QQ 的合并转发消息显示为“查看聊天记录”链接。点击链接后，客户端以只读群组的形式打开被转发的聊天记录，其中嵌套的合并转发可以继续打开。链接中编码了消息在数据库中的位置，服务器重启后仍然有效。

### 群文件

bridge 的 `groupFilesMiniApp` 模块在群聊的附件菜单中提供“群文件”Mini App，用于浏览、搜索和下载平台的群文件，不支持上传或删除。只有 QQ 适配器提供群文件数据。

Mini App 以网页形式在客户端中打开，`publicUrl` 是客户端访问该网页的地址；移动端客户端需要可以访问的 HTTPS 地址，通常经由反向代理提供。Mini App 的访问令牌由 `secret` 签名。如果 `secret` 和环境变量 `CROSSGRAM_GROUP_FILES_SECRET` 都未设置，那么服务器每次启动时生成随机密钥，已签发的令牌在重启后失效。

### 平台管理 bot

`@mtproto-relay/platform-admin-bot` 在客户端中提供 `@CrossGramAdminBot` 会话，用于查看服务器状态、平台账号、登录码和客户端会话，输出服务器 JSON，以及管理表情包关联。默认情况下，每个平台身份都能看到该 bot，但只能管理自己；`allowedPlatformSessionIds` 限定可以使用 bot 的身份，`crossAccountAccess` 允许这些身份管理其它身份。命令列表见 [平台管理 bot 文档](packages/platform-admin-bot/README.md)。

### Telegram Bot API

`@mtproto-relay/telegram-bot-api` 在 WebUI 所在的 HTTP 服务上提供兼容 Telegram Bot API 的接口（`/bot<token>/<method>`），并在客户端中提供 `@BotFather` 用于创建 bot。服务器不保存 bot token 原文，只保存以 `verifierSecret` 为密钥计算的 HMAC 校验值。`verifierSecret` 必须随机生成并长期保持不变，更换后所有已创建的 bot token 都会失效。

### QQ 闪传

`@mtproto-relay/qq-flash-transfer-bot` 在 QQ 账号中提供“QQ 闪传”bot，把文件上传到 QQ 闪传并返回 QQ 的分享链接和文件集 ID。

- 转发给 bot 的 QQ 文件使用 QQ 服务器上已有文件的标识和哈希秒传，不读取或重新上传 QQNT 本地缓存。如果 QQ 服务器已不再保留该文件，那么秒传失败，bot 返回错误。
- 直接发送给 bot 的新文件以流式方式交给 QQ 闪传上传一次。随文件发送的纯文本说明用作文件集名称。

每次闪传最多包含 100 个文件，总大小不超过 100 GiB，`maxFiles` 和 `maxTotalBytes` 可以调低这两项限制。

### 导入 Telegram 贴纸包

`@mtproto-relay/telegram-sticker-importer` 使用一个官方 Telegram Bot Token，从 Telegram Bot API 读取公开贴纸包，插件默认停用。启用插件并设置 `TELEGRAM_STICKER_IMPORTER_BOT_TOKEN` 后，在客户端中向 Sticker Importer bot 发送 `https://t.me/addstickers/<short_name>` 或 `/import <url>`，贴纸包即导入并关联到当前平台身份。

贴纸文件在客户端请求时由服务器经 Bot API 下载，Bot Token 只在服务器端使用。Telegram 托管的 Bot API 限制单个文件不超过 20 MB；如需绕过该限制，可以把 `apiBase` 指向自建的 Local Bot API Server。每个平台身份默认最多导入 100 个贴纸包，两次导入至少间隔 3 秒，分别由 `maxImportsPerSession` 和 `importCooldownMs` 调整。

### 导出到 Satori

`@mtproto-relay/satori-exporter` 把一个已接入 bridge 的平台账号发布为 Satori Bot，供基于 Satori 的机器人框架使用。exporter 依赖 Satori core 和 `@satorijs/plugin-server`，应在 bridge 和目标平台之后加载：

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

`platformId` 是目标平台适配器配置项的 `id`，`platform` 是 Satori 中使用的平台名，省略时取适配器的平台类型。一个 exporter 配置项只导出一个账号，导出多个账号需要多个配置项。

exporter 向 Satori 推送已成功写入数据库的新入站消息，以及消息删除和撤回事件；Satori 应用也可以通过该 Bot 发送、查询和删除消息，查询群组和成员。exporter 跟随 bridge 中平台账号的上线和下线注册或移除 Bot；Satori core 或目标平台重载时，exporter 移除旧 Bot，再按仍在线的账号重新注册。

### 群人数自动清理

`@mtproto-relay/group-auto-kick` 在指定的 QQ 群人数达到上限时，按最近发言时间移出最久未发言的成员，使人数回到目标值；群主和登录账号本身不会被移出，管理员是否受保护由配置决定。插件默认不在 `app.yml` 中，配置见 [群人数自动清理文档](packages/group-auto-kick/README.md)。

## 开发

```bash
yarn typecheck   # 类型检查
yarn test:unit   # 单元测试
yarn test:e2e    # 端到端测试，会先执行 yarn build
```

开发与排查问题可以使用以下工具：

- WebUI 的 `/mtproto-debug` 页面按需记录 MTProto 请求与响应，`/mtproto-statistics` 页面统计 RPC 耗时、流量和慢请求。
- `@mtproto-relay/debug-scripts` 把放入 `data/debug-scripts` 的 TypeScript 文件作为临时 cordis 插件加载，脚本发布的结果写入 `data/debug-results`。
- `yarn mtproto:e2e` 以 Telegram 客户端的身份连接 Crossgram 服务器并运行探测脚本。

cordis 的插件、服务与热重载机制见 [cordis 开发说明](docs/CORDIS.md)。设计文档：

- [IMPlatform 适配器实现规范](docs/IM_PLATFORM.zh.md)
- [Telegram 消息 ID 分配](docs/MESSAGE_ID_ALLOCATION.zh.md)

## License

MIT
