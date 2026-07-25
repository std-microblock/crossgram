# @mtproto-relay/platform-qqnt

`IMPlatform` adapter for the local server injected by `qqnt-bridge` into QQNT.

```yaml
- id: qqnt
  name: '@mtproto-relay/platform-qqnt'
  config:
    endpoint: http://127.0.0.1:18767/v1
    # Optional full WebSocket event-stream URL. By default this is derived
    # from endpoint as ws://127.0.0.1:18767/v1/events/ws.
    # webSocketEndpoint: ws://127.0.0.1:18767/v1/events/ws
    # token: optional-shared-secret
    # groupAlias (default) uses the current group's card when present.
    # nickname always uses the user's QQ profile nickname.
    memberName: groupAlias
    # on-demand downloads the untouched original only when Telegram asks.
    # auto downloads received images and small files immediately, caches them
    # by QQ's content hash, converts images to WebP, and extracts previews.
    mediaDownloadMode: auto
    autoDownloadFileSizeLimit: 10485760
    previewMaxDimension: 320
```

The transport uses JSON for metadata, WebSocket for ordered incoming events, a
chunked request body for uploads, and HTTP byte-range responses for downloads.
The adapter reads `IMMediaSource.stream()` directly and never constructs a
complete media `Buffer`. `webSocketEndpoint` can point the event connection at a
different host or path without changing the HTTP API `endpoint`.

For native videos, the platform asks the injected bridge to call QQNT's
`getVideoPlayUrl`, then requests the signed QQ CDN URL directly with standard
HTTP `Range` semantics. Native QQ video metadata is projected as a Telegram
video document with `supports_streaming`, so seeking transfers only the requested
byte range. The bridge token is never forwarded to the CDN. If the bridge is old,
the play URL is expired, or the CDN rejects the request, the platform falls back
to `/files/download`; that path uses `downloadRichMedia` once and serves ranges
from QQ's local file. A whole-file `200` response from an older bridge is sliced
locally during rolling upgrades.

In `auto` mode the adapter downloads
eligible media when a message event arrives, uses `sha3`/`sha`/`md5` as the
disk-cache identity, converts static images to WebP, converts GIF/APNG images
to WebM, and creates a WebP preview. A
cache hit is resolved before creating the QQNT request. Telegram range reads
then come from the local cached file. In `on-demand` mode (the default), Telegram
range requests stream directly from the bridge's QQ-managed local file; no
platform-side conversion or duplicate cache is required.

QQ picture elements other than native normal/QZone photos are exposed as
stickers. Animated expression pictures and animated sticker assets are
projected as Telegram video stickers (`video/webm`) rather than image/GIF
documents.

QQNT's native API accepts local paths rather than byte streams. The injected QQ
process therefore writes the incoming request incrementally to a private
staging file, invokes the native API, and removes the staging file after QQ
confirms or rejects the message. Memory use remains bounded.

`dialogs` and `contacts` deliberately use different QQ data sources:

- dialogs come from QQ RecentContact;
- contacts come from the complete Buddy list;
- Buddy and Group list updates only enrich names/avatars and do not turn every
  entity into a recent dialog.

The member API keeps the QQ profile nickname and conversation-scoped group
alias as separate fields. The adapter selects one with `memberName`, while
preserving both values in user metadata. User avatars use QQ's fixed qlogo
endpoint and group avatars continue to use QQNT's avatar service; both are
exposed through the same ranged media stream.

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
upload and platform-side range download. To verify an existing native QQ video,
set `QQNT_BRIDGE_E2E_VIDEO_CONVERSATION` to its bridge conversation ID and,
optionally, `QQNT_BRIDGE_E2E_VIDEO_MESSAGE` to the exact message ID.
