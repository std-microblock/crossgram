# `@mtproto-relay/platform-discord`

Discord user-account (userbot/selfbot) adapter for CrossGram.

> [!CAUTION]
> Automating a normal user account violates the Discord Terms of Service and can result in account restriction or termination. Use this adapter only if you understand and accept that risk. A separate account is strongly recommended.

## Setup

Configure the plugin with the user account token:

```yaml
- id: discord
  name: '@mtproto-relay/platform-discord'
  config:
    token: YOUR_USER_TOKEN
    proxy: http://127.0.0.1:7890
```

`proxy` is optional and accepts `http://` or `https://` URLs, including authenticated forms such as `http://user:password@127.0.0.1:7890`. It is applied to Discord REST calls, the Gateway WebSocket, and CDN media downloads.

Private messages, group DMs, guild text/announcement channels, and threads visible to the account are exposed to Telegram. The adapter uses Discord's private user API to synchronize the account's read state.

Run the live adapter e2e against a disposable channel with:

```bash
DISCORD_USER_TOKEN=... DISCORD_E2E_CHANNEL_ID=... yarn workspace @mtproto-relay/platform-discord test:e2e
```
