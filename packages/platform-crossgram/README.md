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
    # Compact WebP previews are kept as binary rows in the database.
    generatePreviews: true
    previewMaxDimension: 320
```

The transport uses JSON for metadata, WebSocket for ordered incoming events, a
chunked request body for uploads, and HTTP byte-range responses for downloads.
The adapter reads `IMMediaSource.stream()` directly and never constructs a
complete media `Buffer`. `webSocketEndpoint` can point the event connection at a
different host or path without changing the HTTP API `endpoint`.

Bridge protocol v14 sends
`OidbSvcTrpcTcp.0x9067_202` through
QQNT, refreshes the private/group RKey in `originImageUrl`, and returns the QQ CDN
URL from `/files/direct-url`. Native videos use the same endpoint backed by
QQNT's `getVideoPlayUrl`. The platform requests either URL directly with standard
HTTP `Range` semantics; video documents keep `supports_streaming`, so seeking
transfers only the requested byte range. The bridge token is never forwarded to
the CDN. User and group avatar URLs are constructed in the platform from their
numeric QQ IDs and fetched directly from qlogo without involving the bridge.
Bridge-local resources such as cloud-control emoji files use the authenticated
`/files/download` route; this route is never used as a fallback for native QQ
message media. Resolver, RKey, and CDN errors for native media are returned to
the caller without a fallback. Protocol v13's native `/files/play-url` and
whole-file `200` responses remain supported during rolling upgrades.

Untouched media keeps its original format and streams from the native URL; it
is never duplicated in the platform cache. GIF/APNG images are converted to
WebM asynchronously: the original image is published first, then one message
edit switches the projection to a new, immutable WebM media ID. The original
media ID remains downloadable from QQ after the edit. PNG animation detection
uses bounded native URL range reads, and completed decisions and WebM assets are
reused by later history requests. When `generatePreviews` is enabled, compact
WebP preview bytes are stored in the database while transformed WebM, sticker,
and reaction assets remain on disk. A quality-20 stripped JPEG is stored beside
each preview and included inline as Telegram `photoStrippedSize`, so clients can
render a blurred placeholder before issuing a media request. An uncached image
in requested history is returned immediately as an empty-download placeholder
with the original byte size and dimensions. Preview generation runs in the
background and publishes a message edit that enables the original and preview
downloads without changing the logical message or media ID. Telegram range
reads for ready original media go directly to the QQ CDN.

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
upload and platform-side range download. To verify an existing native QQ image,
set `QQNT_BRIDGE_E2E_IMAGE_CONVERSATION` and optionally the exact message in
`QQNT_BRIDGE_E2E_IMAGE_MESSAGE`. To verify an existing native QQ video,
set `QQNT_BRIDGE_E2E_VIDEO_CONVERSATION` to its bridge conversation ID and,
optionally, `QQNT_BRIDGE_E2E_VIDEO_MESSAGE` to the exact message ID.
The file-upload and image/video cases all exercise the native direct-URL media
path.
