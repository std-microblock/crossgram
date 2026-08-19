# CrossGram 平台管理 Bot

这是一个可独立启停的 Cordis 插件。启用后，它会在 CrossGram 客户端中创建本地系统会话
`@CrossGramAdminBot`，通过按钮或命令管理当前平台身份。

## 能力

- 查看进程运行时间、内存、MTProto 监听地址和连接数。
- 查看平台账号、身份、虚拟号码、轮换登录码和 Telegram 客户端会话。
- 输出与 WebUI 一致的 CrossGram 服务器 JSON。
- 刷新平台账号和表情包列表。
- 查看表情包，并为平台身份添加或取消关联。
- 批准 Telegram 二维码登录令牌。
- 可选提供跳转 WebUI 的 URL 按钮。

## 启用

插件已加入根目录 `app.yml`，默认关闭。在 WebUI 插件管理页面启用
`@mtproto-relay/platform-admin-bot`，或将配置项的 `disabled` 改为 `false`。

```yaml
- id: platform-admin-bot
  name: '@mtproto-relay/platform-admin-bot'
  disabled: false
  config:
    allowedPlatformSessionIds: []
    crossAccountAccess: false
    showLoginCodes: true
    webuiUrl: https://admin.example.com/
    pageSize: 6
```

安全默认值如下：

- `allowedPlatformSessionIds` 为空时，每个活跃平台身份都能看到 Bot，但只能管理自己。
- 设置 `allowedPlatformSessionIds` 后，只有列表中的身份会看到并使用 Bot。
- `crossAccountAccess` 默认为 `false`；只有明确开启后，获准身份才能查看和操作其他身份。
- `showLoginCodes` 可关闭登录码展示。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/start`、`/menu` | 打开按钮菜单 |
| `/help` | 查看完整帮助 |
| `/status` | 查看服务器状态 |
| `/accounts [页码]` | 查看平台账号 |
| `/identities [页码]` | 查看平台身份和登录信息 |
| `/sessions [页码]` | 查看 Telegram 客户端会话 |
| `/server`、`/server_json` | 输出服务器 JSON |
| `/stickers [页码]` | 查看并管理表情包关联 |
| `/refresh` | 刷新平台账号和表情包 |
| `/approve <平台ID> <登录令牌>` | 批准二维码登录 |
| `/sticker <providerId> <packId> <on\|off> [身份ID]` | 用命令修改表情包关联 |

也可以直接发送“状态”“平台账号”“身份列表”“客户端”“服务器 JSON”“表情包”“刷新”等中文文本。
