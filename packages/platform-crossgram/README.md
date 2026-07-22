# @mtproto-relay/platform-qqnt

`IMPlatform` adapter for the local server injected by `qqnt-bridge` into QQNT.

```yaml
- id: qqnt
  name: '@mtproto-relay/platform-qqnt'
  config:
    endpoint: http://127.0.0.1:18767/v1
    # token: optional-shared-secret
```

The transport uses JSON for metadata, SSE for ordered incoming events, a
chunked request body for uploads, and a ranged chunked response for downloads.
The adapter reads `IMMediaSource.stream()` directly and never constructs a
complete media `Buffer`.

QQNT's native API accepts local paths rather than byte streams. The injected QQ
process therefore writes the incoming request incrementally to a private
staging file, invokes the native API, and removes the staging file after QQ
confirms or rejects the message. Memory use remains bounded.

`dialogs` and `contacts` deliberately use different QQ data sources:

- dialogs come from QQ RecentContact;
- contacts come from the complete Buddy list;
- Buddy and Group list updates only enrich names/avatars and do not turn every
  entity into a recent dialog.

User and group avatars are exposed through the same ranged media stream.

Reactions are populated from QQ's downloaded cloud-control emoji config
(`getEmojiResourcePath(0)`). Unicode QQ emoji are mapped to Telegram emoji
reactions; QQ SysFace entries are exposed as custom emoji documents backed by
the downloaded `static/s{QSid}.png` resources. Existing counts/selections come
from `MsgRecord.emojiLikesList`, and writes use QQ `msgSeq` with
`setMsgEmojiLikes`.

## Tests

```sh
pnpm --filter @mtproto-relay/platform-qqnt test
```

Live E2E tests are opt-in:

```sh
QQNT_BRIDGE_E2E=1 pnpm --filter @mtproto-relay/platform-qqnt test:e2e
```

They hard-code the requested safety allowlist: direct messages only target
`MicroBlock (1715311957)`, while group messages only target `1058754719` or
`1084013940`. Set `QQNT_BRIDGE_E2E_FILE` to additionally test a streamed file
upload and ranged download.
