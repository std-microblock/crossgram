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
    # Hide gray-tip service messages containing any entry. Set [] to keep all.
    grayTipFilters:
      - 回应了你的消息
    # Optional. Generate Telegram's tiny inline photoStrippedSize after the
    # original history/live message has already been delivered.
    generatePreviews: false
    previewConcurrency: 2
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

Recorded QQ PTT with a readable local path is exposed as a Telegram voice message (`audio/ogg`); Telegram voice messages are sent as one native QQ PTT bubble. Ordinary audio documents remain non-voice files.

All ordinary message media keeps its original QQ format and locator. The relay
does not probe animation or transcode GIF/APNG/PNG into WebM. History and
live-event ingestion remain metadata-only, and patched clients call
`crossgram.getFileUrl` before fetching the original bytes directly from QQ's
CDN with HTTP Range. APNG files that QQ labels as ordinary `image/png` are left
for the client to detect from downloaded content. A startup migration strips
legacy transform locators from old rows so existing history returns to the raw
direct-download path.

QQ's native image download protocol defines original (`spec=0`) and thumbnail
tiers (`spec=198` / `spec=720`). The adapter publishes the 720 tier as Telegram's
`m` photo size while keeping the original as the largest sizes. Both are resolved
through `/files/direct-url` only to refresh the RKey, then fetched directly from
QQ's CDN; the relay never serves a QQ `Thumb` cache file as message media.

`generatePreviews` optionally adds Telegram's smallest inline
`photoStrippedSize`. The initial history/live message is always delivered first
without waiting for media I/O. A bounded background job reads QQ's remote 198
tier when available (otherwise the original), extracts a 40-pixel
low-quality JPEG, stores only the compact stripped payload in
`mtproto_qqnt_inline_preview`, and publishes a message edit that embeds those
bytes directly in the TL message. Cache lookup, decoding and failures therefore
stay outside `getHistory` and ordered live-event delivery.

QQ picture elements other than native normal/QZone photos are exposed as
stickers. QQ sticker and reaction bytes are also exposed unchanged as their
original PNG/GIF/APNG resources. The relay adds only Telegram document metadata
such as sticker/custom-emoji, image-size, and filename attributes;
format detection and decoding stay entirely on the client.

Bridge protocol v18 hashes each reopenable `IMMediaSource` in the relay, then
reopens it for the HTTP request. The injected process uses the supplied MD5,
SHA-1, and first-10-MiB MD5 to negotiate QQ image/file upload and sends the
request body directly as bounded 1 MiB Highway blocks. It does not create a
second full local file. A server-side fast-upload hit still drains and validates
the complete request body. The injected bridge retains a local-path fallback
only for older manifests without hashes during rolling upgrades.

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

Reaction gray tips are used as an immediate refresh signal by `qqnt-bridge`,
but the redundant “回应了你的消息” service message is hidden by the adapter's
default `grayTipFilters`. Replace the list to filter other gray-tip wording, or
set it to `[]` to show every gray tip.

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
