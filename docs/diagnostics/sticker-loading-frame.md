# Sticker loading frames (2026-09-23)

## Symptom

Stickers without a downloaded asset stayed blank instead of showing a loading
frame. The sticker panel showed empty cells and chat history showed nothing at
all next to the message while the sticker was still loading; Telegram's own
servers make clients paint a moving-gradient silhouette for exactly that
window.

## Root cause

`telegramStickerPlaceholder()` (bridge `sticker-outline.ts`) encoded the
fallback frame with quadratic Bézier (`Q`) commands. Clients do not run a
general SVG engine over `photoPathSize`: they prepend the implicit move-to,
append the closing command, and then use a reduced parser.

- Telegram Desktop implements M/L/H/V/C/S/Z only
  (`Images::PathFromInlineBytes` in `lib_ui/ui/image/image_prepare.cpp`). Any
  other command logs `SVG Error: Receive invalid command` and returns an
  **empty** `QPainterPath`.
- `DocumentMedia::thumbnailPath()` then calls `clearInlineThumbnailBytes()`,
  and `ChatHelpers::PaintStickerThumbnailPath()` returns false without
  painting anything — no silhouette, no frame, no gradient.

Nothing in the repository fills `IMSticker.outline` (providers only ever
expose QR/QQ assets, and the tracer is not wired to a producer yet), so *every*
sticker document received that generated placeholder and every sticker lost its
frame.

## Evidence

A production probe (`work/mtproto-e2e/sticker-path.ts`, run with
`yarn mtproto:e2e run … --profile production`) fetched the live
`QQ 收藏表情` set through `messages.getStickerSet` and decoded each document's
`photoPathSize` bytes with a faithful port of the Desktop parser:

| document | image size | expanded path | Desktop parser |
| --- | --- | --- | --- |
| 215384492775788 | 289x346 | `M35,0H254Q289,0,289,35…` | `invalid command "Q" at 10` |
| 1374221261919354 | 1080x1080 | `M130,0H950Q1080,0,1080,130…` | `invalid command "Q" at 11` |
| 4417466922808089 | 600x338 | `M41,0H559Q600,0,600,41…` | `invalid command "Q" at 10` |

Every path was dropped, which is why no sticker had a loading frame.

## Fix

- `packages/bridge/src/sticker-outline.ts` builds the placeholder from cubic
  corners (`C`) and horizontal/vertical lines only, so it stays inside the
  command subset both Telegram Desktop and Android implement. The path spans
  the whole document box.
- The same module exposes `decodeTelegramStickerPath()`, a port of the client
  decoder (expansion plus the reduced command set), and
  `encodeTelegramStickerPath()`.
- `packages/bridge/src/sticker-rpc.ts` validates `sticker.outline` with that
  decoder before putting it in a document. Empty, malformed, or
  client-incompatible persisted outlines (including the quadratic paths shipped
  before this change) fall back to the generated frame.
- `STICKER_PROJECTION_VERSION` moves from 9 to 10. Clients persist sticker
  sets together with their documents, and `updateThumbnails()` never replaces
  already stored inline bytes, so rotated set/document ids are what makes
  clients discard the unusable paths they cached.
- Frame geometry continues to come from the document image size: Desktop reads
  `DocumentData::dimensions`, Android reads `documentAttributeImageSize` (or
  `documentAttributeVideo`) in `DocumentObject.getSvgThumb` and scales the path
  with it. The bridge already advertises the sticker dimensions there, so the
  frame now matches the sticker box instead of being absent.

## Verification

- `packages/bridge/src/sticker-outline.test.ts` asserts the encoded path
  decodes to a closed rounded frame covering exactly `0,0..width,height`, that
  only `H/V/C/L` commands are emitted, and that the quadratic payload shipped
  before this change is rejected.
- `packages/bridge/src/sticker-rpc.test.ts` asserts the projected document
  frame covers the advertised image size, that unusable persisted outlines fall
  back to the generated frame, and that decodable outlines are forwarded
  unchanged.
- `packages/platform-crossgram/src/sticker-object-contract.e2e.test.ts` and
  `packages/test-suite/src/login.e2e.test.ts` decode the path thumbnails of
  real RPC responses and compare the frame bounds with the document image size.
