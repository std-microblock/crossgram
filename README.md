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
| **参考实现（static）** | `@mtproto-relay/platform-static` | ✅ |
| **官方 Telegram 透传（relay）** | `@mtproto-relay/relay` | ✅ |
| 微信 / Discord / 其它 | — | 🚧 |

<details>
<summary>能力矩阵</summary>

> ✅ 已支持 · ⚠️ 部分支持 · ❌ 不会支持 · 🗓️ 在规划中

<details open>
<summary>历史记录 <code>history</code></summary>

| 能力 | QQ（QQNT） | 参考实现（static） | 官方 Telegram（relay） |
|---|:---:|:---:|:---:|
| 历史消息拉取 | ✅ | ✅ | ✅ |

</details>

<details open>
<summary>发送 <code>send</code></summary>

| 能力 | QQ（QQNT） | 参考实现（static） | 官方 Telegram（relay） |
|---|:---:|:---:|:---:|
| 文字 | ✅ | ✅ | ✅ |
| 图片 | ✅ | ✅ | ✅ |
| 文件 | ✅ | ✅ | ✅ |
| 图文混排 | ✅ | ✅ | ✅ |

</details>

<details open>
<summary>会话类型 <code>conversations</code></summary>

| 能力 | QQ（QQNT） | 参考实现（static） | 官方 Telegram（relay） |
|---|:---:|:---:|:---:|
| 私聊 (direct) | ✅ | ✅ | ✅ |
| 群聊 (group) | ✅ | ✅ | ✅ |
| 频道 (channel) | ❌ | ✅ | ✅ |
| 子频道 / 话题 (subchannel) | ❌ | ✅ | ✅ |
| 群公告（接收） | 🗓️ | 🗓️ | ✅ |

</details>

<details open>
<summary>成员与权限 <code>members</code></summary>

| 能力 | QQ（QQNT） | 参考实现（static） | 官方 Telegram（relay） |
|---|:---:|:---:|:---:|
| 成员列表 | ✅ | ✅ | ✅ |
| 管理员信息 | ✅ | ✅ | ✅ |
| 成员权限 | ❌ | ✅ | ✅ |
| 移除群成员 | 🗓️ | ❌ | ✅ |
| 入群申请管理 | 🗓️ | ❌ | ✅ |
| 管理群公告 | 🗓️ | ❌ | ✅ |

</details>

<details open>
<summary>消息操作 <code>messageActions</code></summary>

| 能力 | QQ（QQNT） | 参考实现（static） | 官方 Telegram（relay） |
|---|:---:|:---:|:---:|
| 撤回自己的消息 | ✅ | ✅ | ✅ |
| 撤回他人消息（管理员） | ✅ | ✅ | ✅ |
| 编辑消息 | 撤回重发 | ✅ | ✅ |
| 转发 | ✅ | ✅ | ✅ |
| 合并转发 | ✅ | ❌ | ❌ |

</details>

<details open>
<summary>消息响应 <code>reactions</code></summary>

| 能力 | QQ（QQNT） | 参考实现（static） | 官方 Telegram（relay） |
|---|:---:|:---:|:---:|
| 读取 | ✅ | ✅ | ✅ |
| 发送 | ✅ | ✅ | ✅ |
| 实时事件 | ✅ | ✅ | ✅ |
| 显示点赞者 | ✅ | ✅ | ✅ |

</details>

<details open>
<summary>头像 <code>avatars</code></summary>

| 能力 | QQ（QQNT） | 参考实现（static） | 官方 Telegram（relay） |
|---|:---:|:---:|:---:|
| 用户头像 | ✅ | ✅ | ✅ |
| 会话头像 | ✅ | ✅ | ✅ |

</details>

<details open>
<summary>表情包 <code>stickers</code></summary>

| 能力 | QQ（QQNT） | 参考实现（static） | 官方 Telegram（relay） |
|---|:---:|:---:|:---:|
| 查看 | ✅ | ✅ | ✅ |
| 收藏管理 | ✅ | ✅ | ✅ |
| 上传/下载 | ❌ | ❌ | ✅ |

</details>

<details open>
<summary>其它</summary>

| 能力 | QQ（QQNT） | 参考实现（static） | 官方 Telegram（relay） |
|---|:---:|:---:|:---:|
| 系统消息（灰字） | 🗓️ | 🗓️ | ✅ |
| 小程序（Web App） | ❌ | ❌ | ✅ |
| Stories / Premium 等 | ❌ | ❌ | ✅ |
| 语音 / 视频通话 | ❌ | ❌ | ❌ |
| Secret Chat | ❌ | ❌ | ❌ |
| 红包 / 转账 | ❌ | ❌ | ❌ |

</details>
</details>

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

- id: qqnt   # QQ 平台
  name: '@mtproto-relay/platform-qqnt'
  config:
    endpoint: http://127.0.0.1:18767/v1
    generatePreviews: true
    # 默认隐藏“XXX回应了你的消息：XX”灰条；设为 [] 可全部显示
    grayTipFilters:
      - 回应了你的消息
```
</details>

启动后浏览器打开 http://127.0.0.1:3140/platform-accounts  
页面上会显示桥接平台的资料、自动分配的虚拟手机号（`+999...`）以及每 30 秒轮换的 6 位登录码，这些就是客户端登录要用的。

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
2. 输入页面上显示的虚拟手机号（`+999...`）。
3. 输入当前显示的 6 位登录码。
4. 进入主界面后，就能看到桥接过来的会话和消息了。

## 设计文档

- [Telegram 消息 ID 分配](docs/MESSAGE_ID_ALLOCATION.zh.md)
- [跨平台 IM 接口](docs/IM_PLATFORM.zh.md)

## License

MIT
