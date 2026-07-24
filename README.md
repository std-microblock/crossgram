<div align=center>
<h1>CrossGram</h1>
<div>Bring any chat platform to Telegram clients.</div>
<div>使用 Telegram 客户端在任何平台上聊天</div><br/>
<img src="https://github.com/user-attachments/assets/be1e04db-c621-4d37-9585-43c1fb6bd452" />
</div><br/>

CrossGram 是一个基于 [cordis](https://github.com/cordiverse/cordis) 和 [mtcute](https://github.com/mtcute/mtcute) 的 Telegram 服务器端实现。它将 Telegram 桥接到其它平台，以让你在 Telegram 客户端下获得远超原生客户端的聊天体验。

- 把 **Telegram 客户端** 作为 N 合 1 客户端：登录后所有会话来自被桥接的平台。
- 一个服务器可同时承载多个账户，每个账户按需路由到 **官方 Telegram（relay 透传）** 或 **某 IM 平台（bridge 桥接）**。

---

## 支持情况

### 平台实现

| 平台 | 包名 | 状态 |
|---|---|---|---|
| **QQ（QQNT）** | `@mtproto-relay/platform-qqnt` | ✅ |
| **参考实现（static）** | `@mtproto-relay/platform-static` | ✅ |
| **官方 Telegram 透传（relay）** | `@mtproto-relay/relay` | ✅ |
| 微信 / Discord / 其它 | — | 🚧 |

### 能力矩阵

> 符号：✅ 已支持 · ⚠️ 部分支持 · ❌ 不会支持 · 🗓️ 规划中

| 能力 | QQ | Demo 实现 (static) | Telegram |
|---|:---:|:---:|:---:|
| 发送: 文字 | ✅ | ✅ | ✅ |
| 发送: 图片 | ✅ | ✅ | ✅ |
| 发送: 文件 | ✅ | ✅ | ✅ |
| 接收: 历史记录 | ✅ | ✅ | ✅ |
| 接收: 平台消息灰字 | 🗓️ | 🗓️ | ✅ |
| 接收: 群公告 | 🗓️ | 🗓️ | ✅ |
| 私聊 (direct) | ✅ | ✅ | ✅ |
| 群聊 (group) | ✅ | ✅ | ✅ |
| 频道 (channel) | ❌ | ✅ | ✅ |
| 子频道 / 话题 (subchannel) | ❌ | ✅ | ✅ |
| 消息撤回 | ✅ | ✅ | ✅ |
| 编辑消息 | 撤回重发 | ✅ | ✅ |
| 转发 | ✅ | ✅ | ✅ |
| 合并转发 | ✅ | ❌ | ❌ |
| 成员列表 | ✅ | ✅ | ✅ |
| 头像 | ✅ | ✅ | ✅ |
| 管理员: 撤回消息 | ✅ | ✅ | ✅ |
| 管理员: 移除群成员 | 🗓️ | ❌ | ✅ |
| 管理员: 入群申请管理 | 🗓️ | ❌ | ✅ |
| 管理员: 管理群公告 | 🗓️ | ❌ | ✅ |
| 消息响应（reaction） | ✅ | ✅ | ✅ |
| 平台表情包: 查看 | ✅ | ✅ | ✅ |
| 平台表情包: 收藏管理 | ✅ | ✅ | ✅ |
| 平台表情包: 上传下载 | ❌ | ❌ | ✅ |
| 红包/转账 | ❌ | ❌ | ❌ |
| 小程序 | ❌ | ❌ | ✅ |
| 语音 / 视频通话 | ❌ | ❌ | ❌ |
| Secret Chat | ❌ | ❌ | ❌ |
| Stories / Premium 等 | ❌ | ❌ | ✅ |

----

## 开始使用

### 启动服务器

#### 方式 A：本地源码运行（开发）

```bash
yarn install
yarn dev
# 生产模式
yarn build && yarn start
```

#### 配置

服务器配置在 `app.yml`。首次启动会自动在 `data/rsa-key.json`（及 `data/rsa-key.json.pem`）生成 RSA 密钥对，无需手动准备。常用配置项：

```yaml
- id: mtproto01
  name: '@mtproto-relay/mtproto'
  config:
    port: 4430                       # 客户端补丁默认指向的端口
    host: 127.0.0.1                  # 监听地址，对外暴露时改为 0.0.0.0
    rsaKeyPath: ./data/rsa-key.json  # RSA 密钥，缺失则自动生成

- id: qqnt                          # QQ 平台（默认启用）
  name: '@mtproto-relay/platform-qqnt'
  config:
    endpoint: http://127.0.0.1:18767/v1
    mediaDownloadMode: auto

# 下面两个默认 disabled，按需启用：
- id: static                        # 参考平台（演示 / 测试）
  name: '@mtproto-relay/platform-static'
  disabled: true
- id: relay01                       # 官方 Telegram 透传
  name: '@mtproto-relay/relay'
  disabled: true
  config: { apiId: 0, apiHash: '' }
```

启动后打开 http://127.0.0.1:3140/platform-accounts
- 每个平台插件会展示其资料（昵称 / 头像）、自动分配的虚拟手机号（`+999…`）。
- 页面提供 30 秒轮换的六位登录码，用于客户端登录

### 将 Telegram 客户端配置为连接至本服务器

CrossGram 不是独立客户端，而是一个 Telegram 第三方服务器。你需要让一个 Telegram 客户端连接到它。我们现在通过二进制修补来实现将客户端连接至本服务器，以避免重新编译。你也可以重新编译并修改硬编码在客户端代码内的 DC IP，Special Endpoint 和 RSA Key 来将任意 Telegram 客户端连接至本服务器。

#### 支持修补的客户端

| 客户端 | 操作系统 | 状态 |
|---|---|---|
| Telegram Desktop 及其分支 | Windows / macOS / Linux | ✅ |
| 基于 TDLib 的客户端（Unigram 等） | Windows / Linux | ⚠️ |
| Telegram Android 及其分支 | Android | 🚧 |
| Telegram Web / WebK | 浏览器 | 🚧 |
| Telegram iOS | iOS | 🚧 |
| 官方 macOS 原生客户端 | macOS | ❌ |

#### 用补丁脚本重定向客户端

脚本位于 [`binary_patch/patch-tdesktop.cjs`](binary_patch/patch-tdesktop.cjs)，它会就地修改客户端二进制，完成三件事：

1. **替换 RSA 公钥**——让客户端信任本服务器，并拒绝官方 Special Config 回连 Telegram。
2. **重定向 DC 地址**——把所有内置 IPv4 / IPv6 地址改为 `--host`。
3. **重定向 DC 端口**——把所有生产 / 测试端口改为 `--port`。

支持 macOS（`.app` 包或裸二进制）、Linux（ELF）、Windows（PE / `.exe`）；兼容 Telegram Desktop、AyuGram、MaterialGram 及任意 TDLib 分支。

示例：
```bash
node binary_patch/patch-tdesktop.cjs /Applications/materialgram.app
node binary_patch/patch-tdesktop.cjs --port 4430 /usr/bin/telegram-desktop
node binary_patch/patch-tdesktop.cjs --host 192.168.1.10 --port 4430 --no-resign "Telegram.exe"
```

常用参数：

| 参数 | 说明 | 默认 |
|---|---|---|
| `--key <file>` | RSA 公钥 PEM（PKCS#1）。缺省自动寻找 `data/rsa-key.json.pem` | 自动 |
| `--host <ip>` | 重定向所有 DC 到的 IPv4 地址 | `127.0.0.1` |
| `--port <n>` | 重定向所有 DC 到的端口 | `4430` |
| `--no-resign` | 跳过 macOS 重签名（Linux/Windows 或非自动签名） | 关闭 |
| `--no-backup` | 跳过生成 `<binary>.original` 备份 | 关闭 |
| `--dry-run` | 只打印将要修改的位置，不写入 | 关闭 |

> 打补丁前客户端会自动备份为 `<binary>.original`。macOS 上补丁会执行 `codesign --force --deep --sign -` 重新签名并移除 quarantine，如遇权限问题可加 `sudo` 或 `--no-resign` 手动签名。

#### 登录

1. 启动服务器、打好客户端补丁后，打开（补丁后的）客户端。
2. 输入 `platform-accounts` 页面展示的 **虚拟手机号**（`+999…`）。
3. 输入页面当前显示的 **六位登录码**。
4. 进入主界面后即可看到被桥接平台的会话与消息。

## License

MIT
