# @mtproto-relay/platform-wechat

Native CrossGram adapter for the legacy Windows **ComWeChat** HTTP and TCP-callback API.

```yaml
- id: wechat
  name: '@mtproto-relay/platform-wechat'
  disabled: true
  config:
    endpoint: http://127.0.0.1:18888/api/
    callbackPort: 23456
    requestTimeoutMs: 30000
    maxCallbackBytes: 1048576
    maxCallbackConnections: 32
```

## Security

ComWeChat is an old local-control API with **no authentication**. Do not expose its
HTTP endpoint to the public internet. The callback listener is intentionally bound
to `127.0.0.1`, limits payload size, and only acknowledges a callback after
CrossGram has handled it. Loopback prevents remote callbacks, but it does not
protect against a malicious process on the same host. Deploy CrossGram under a
separate OS identity or namespace and use firewall rules to restrict local access.
The protocol provides no callback token or MAC, so the adapter does not pretend to
provide one.

## Capability boundary

The adapter supports login/account discovery, contacts as direct/group dialogs,
group-member listing, and real-time callback messages. It has no history or
read-state API. Sending, edits, deletes, forwarding, stickers, and media sending
are not supported.

ComWeChat callback attachment paths are deliberately not read. A callback could
otherwise make CrossGram read arbitrary local files. Images, files, voice messages,
videos, and animated stickers are therefore presented as text descriptions.
