<div align=center>
<h1>CrossGram</h1>
<div>Bring any chat platform to Telegram clients.</div>
<div>使用 Telegram 客户端在任何平台上聊天</div><br/>
<img src="https://github.com/user-attachments/assets/be1e04db-c621-4d37-9585-43c1fb6bd452" />
</div><br/>

CrossGram 是基于 [cordis](https://github.com/cordiverse/cordis) 与 [mtcute](https://github.com/mtcute/mtcute) 的第三方 Telegram 服务端，把 QQ、Discord、Matrix 等聊天平台桥接到 Telegram 客户端。

## 架构

插件与配置在 [app.yml](app.yml) 中声明，核心分三层：

- **MTProto 服务**（`@mtproto-relay/mtproto`）：处理 MTProto 传输、DH 握手与 Auth Key 存储。首次启动时在 `data/rsa-key.json` 生成服务器密钥对，并导出公钥 `data/rsa-key.json.pem` 供客户端配置。
- **Bridge**（`@mtproto-relay/bridge`）：实现 Telegram RPC、虚拟号登录、会话/消息投影、媒体收发、更新推送与 WebUI 管理页面。
- **平台适配器**（`@mtproto-relay/platform-*`）：对接具体 IM 平台，实现 [IMPlatform 接口](docs/IM_PLATFORM.zh.md)。`app.yml` 中的每个适配器实例对应一个平台账号和一个可登录的 Telegram 身份。

## 平台支持

| 平台 | 包名 | 连接目标 | 说明 |
|---|---|---|---|
| QQ | `@mtproto-relay/platform-qqnt` | 注入 QQNT 的 `qqnt-bridge` 本地服务 | 主力平台，见 `packages/platform-crossgram` |
| Discord | `@mtproto-relay/platform-discord` | Discord 用户账号（Userbot） | 支持私聊、群组、频道、子频道与回应 |
| Matrix | `@mtproto-relay/platform-matrix` | Matrix Client-Server API | 仅支持未加密房间 |
| Satori | `@mtproto-relay/platform-satori` | Satori 适配器 | 能力取决于底层 Satori adaptor |
| 微信 | `@mtproto-relay/platform-wechat` | Windows ComWeChat HTTP API | 仅接收文本消息与基础会话 |
| 飞书/Lark | `@mtproto-relay/platform-lark` | 开放平台自建应用（bot/user 双模式） | bot＝机器人收发（WS 事件）；user＝用户身份收发（OAuth+轮询） |
| Static | `@mtproto-relay/platform-static` | 内存模拟数据 | 测试与参考实现 |

> [!CAUTION]
> Discord 适配器使用普通用户 Token 自动操作，违反 Discord 服务条款，存在封号风险。

### 能力矩阵

| 能力 | QQ | Discord | Matrix | Static |
|---|:---:|:---:|:---:|:---:|
| 历史消息 | ✓ | ✓ | ✓ | ✓ |
| 已读同步 | 仅标记已读 | ✓ | ✓ | ✓ |
| 消息搜索 | ✓ | ✗ | ✗ | ✗ |
| 文字 / 图片 / 文件 / 图文混排 | ✓ | ✓ | ✓ | ✓ |
| 私聊与群聊 | ✓ | ✓ | ✓ | ✓ |
| 频道 / 子频道（话题） | ✗ | ✓ | Space | ✓ |
| 成员列表与管理员 | ✓ | ✓ | ✓ | ✓ |
| 设置管理员 | ✓ | ✗ | ✗ | ✓ |
| 禁言与踢人 | ✓ | ✗ | ✗ | ✗ |
| 好友与入群申请 | ✓ | ✗ | ✗ | ✗ |
| 撤回消息 | 120 秒内 | ✓ | ✓ | ✓ |
| 编辑消息 | 120 秒内撤回重发 | ✓ | 仅纯文本 | ✓ |
| 转发 | ✓ | ✓ | ✗ | ✓ |
| 合并转发 | ✓ | ✗ | ✗ | ✗ |
| 表情回应（Reaction） | ✓ | ✓ | ✗ | ✓ |
| 贴纸 / 收藏表情 | ✓ | 作为图片接收 | ✗ | ✓ |
| 系统提示（灰条） | ✓ | ✓ | ✗ | ✗ |
| 戳一戳 | ✓ | ✗ | ✗ | ✗ |
| 语音消息与转写 | ✓ | ✗ | ✗ | ✗ |
| 群文件 | ✓ | ✗ | ✗ | ✗ |
| 私聊语音通话 | 需 `voice-worker` | ✗ | ✗ | ✗ |
| 富文本 / 文章消息 | ✓ | ✓ | ✓ | ✓ |

详见各适配器文档：
- [QQ 适配器](packages/platform-crossgram/README.md) 与 [协议文档](packages/platform-crossgram/PROTOCOL.md)
- [Discord 适配器](packages/platform-discord/README.md)
- [Matrix 适配器](packages/platform-matrix/README.md)
- [微信适配器](packages/platform-wechat/README.md)
- [飞书/Lark 适配器](packages/platform-lark/README.md)

### Satori 接入

`@mtproto-relay/platform-satori` 可将任意 Satori adaptor 接入 Bridge：

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
    bot: discord:your-bot-id # 只有一个 Bot 时可省略
```

## 运行与部署

### 本地开发

需要 Node.js 24+ 与 Yarn 4（通过 `corepack enable` 启用）：

```bash
corepack enable
yarn install
yarn dev                  # 开发模式（热重载）
yarn build && yarn start  # 生产模式
```

首次启动会在 `data/` 下生成 RSA 密钥、Auth Key 文件和 SQLite 数据库 `cordis.db`。WebUI 默认地址为 `http://127.0.0.1:3140`。

普通运行不需要 Rust 或 C++ 工具链；仅语音通话使用的 [voice-worker](packages/voice-worker/README.md) 需要原生编译（可由 [flake.nix](flake.nix) 构建）。

### 核心配置

MTProto 服务的 `host`/`port` 是实际监听地址；Bridge 的 `serverHost`/`serverPort`/`altEndpoints` 是在 `help.getConfig` 中向客户端公布的连接地址（反代或 NAT 下两者可能不同）：

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

- id: qqnt
  name: '@mtproto-relay/platform-qqnt'
  config:
    endpoint: http://127.0.0.1:18767/v1
    token: your-qqnt-bridge-token # 省略时读取环境变量 QQNT_BRIDGE_TOKEN
```

### Linux 生产部署

```sh
curl -fsSL https://raw.githubusercontent.com/std-microblock/crossgram/main/deploy/install.sh \
  | sudo CROSSGRAM_PUBLIC_HOST=203.0.113.10 sh
```

完整步骤（PostgreSQL 初始化、环境变量与更新脚本）见 [deploy/README.md](deploy/README.md)。

也可以用容器部署同一套生产配置，部署机不需要源码或构建：

```sh
curl -fsSLO https://raw.githubusercontent.com/std-microblock/crossgram/main/deploy/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/std-microblock/crossgram/main/deploy/.env.example -o .env
# 填 CROSSGRAM_PUBLIC_HOST、CROSSGRAM_POSTGRES_PASSWORD、TELEGRAM_BOT_TOKEN_VERIFIER_SECRET
docker compose up -d
```

## 客户端与登录

### 客户端列表

官方客户端写死了 Telegram 官方服务器地址与公钥，必须使用打过补丁的客户端连接 CrossGram：

| 仓库 | 上游客户端 | 平台 |
|---|---|---|
| [crossgram-desktop](https://github.com/crossgram-project/crossgram-desktop) | Telegram Desktop、64Gram、AyuGram、materialgram | Windows、macOS、Linux |
| [crossgram-android](https://github.com/crossgram-project/crossgram-android) | Telegram、Nagram、Nnngram、Nullgram、Mercurygram、Forkgram | Android |
| [crossgram-unigram](https://github.com/crossgram-project/crossgram-unigram) | Unigram | Windows |
| [crossgram-telegram-x](https://github.com/crossgram-project/crossgram-telegram-x) | Telegram X | Android |
| [crossgram-mithka](https://github.com/crossgram-project/crossgram-mithka) | Mithka | Android、iOS、桌面 |

Unigram、Telegram X 与 Mithka 共用 [crossgram-tdlib](https://github.com/crossgram-project/crossgram-tdlib)。

### 服务器配置 JSON

在客户端登录页点击「服务器」，导入以下 JSON（可在 WebUI `/platform-accounts`、管理 Bot `/server` 命令或 `crossgram-client-config` 脚本获取）：

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

### 虚拟手机号与登录码

Bridge 为每个平台账号分配 `+888` 开头的虚拟手机号（QQ 账号为 `+888 <QQ号>`，其他平台为固定随机 12 位号码）。

登录码为每 30 秒轮换的 6 位 TOTP 码，可在以下位置查看：
- WebUI `/platform-accounts` 页面
- 已登录客户端中的 `@CrossGramAdminBot`（也可直接批准扫码登录）

若在 WebUI 为账号设置了两步验证密码，输入 `000000` 即可进入密码验证步骤。

## 扩展模块

可在 `app.yml` 中按需启用：

- **合并转发查看**（`@mtproto-relay/merged-forward`）：将 QQ 合并转发渲染为只读群聊链接，支持嵌套展开。
- **群文件 Mini App**（`bridge.groupFilesMiniApp`）：在群聊附件菜单提供群文件浏览、搜索与下载（需为移动端配置可访问的 HTTPS `publicUrl`）。
- **平台管理 Bot**（`@mtproto-relay/platform-admin-bot`）：提供 `@CrossGramAdminBot` 会话，详见 [文档](packages/platform-admin-bot/README.md)。
- **Telegram Bot API**（`@mtproto-relay/telegram-bot-api`）：提供本地 `/bot<token>/<method>` 接口与 `@BotFather`，需配置固定的 `verifierSecret`。
- **QQ 闪传**（`@mtproto-relay/qq-flash-transfer-bot`）：提供「QQ 闪传」Bot，转发已有 QQ 文件走秒传，直接发送新文件走流式上传，返回闪传分享链接。
- **贴纸包导入**（`@mtproto-relay/telegram-sticker-importer`）：配置 `TELEGRAM_STICKER_IMPORTER_BOT_TOKEN` 后，向 Bot 发送 `https://t.me/addstickers/<name>` 即可将官方贴纸包导入当前账号。
- **导出到 Satori**（`@mtproto-relay/satori-exporter`）：将已接入 Bridge 的平台账号重新暴露为 Satori Bot。
- **群满员自动踢人**（`@mtproto-relay/group-auto-kick`）：群人数达到上限时自动移出最久未发言成员，详见 [文档](packages/group-auto-kick/README.md)。

## 开发与测试

```bash
yarn typecheck   # 类型检查
yarn test:unit   # 单元测试
yarn test:e2e    # 端到端测试
```

调试工具：
- WebUI `/mtproto-debug`：按需抓取 MTProto 收发包
- WebUI `/mtproto-statistics`：统计 RPC 耗时、流量与慢请求
- `@mtproto-relay/debug-scripts`：热加载 `data/debug-scripts` 下的临时诊断脚本
- `yarn mtproto:e2e`：使用真实 MTProto 客户端连接服务执行探测脚本

架构与内部设计文档：
- [Cordis 框架参考](docs/CORDIS.md)
- [Cordis 管线与生命周期](docs/cordis-native-pipelines.md)
- [IMPlatform 适配器规范](docs/IM_PLATFORM.zh.md)
- [Telegram 消息 ID 分配](docs/MESSAGE_ID_ALLOCATION.zh.md)

## License

MIT
