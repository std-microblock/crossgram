# Relayed QQ system faces in messages (2026-09-23)

## Symptom

A QQ group message (`my.telegram.org/c/240565744/1114008311`, channel
`1103993684` / conversation `9436`, QQ message `7688430191...` seq 482949)
rendered its `/捡到宝了` face as an empty sticker cell. Stickers of that class —
every QQ system face (`/流泪`, `/不是吧`, `/捡到宝了`, ...) sent as a message —
never rendered in Telegram clients, while market faces and QQ favorites worked.

## Root cause

Two defects on the same code path (`QQStickerProvider.openAsset` ->
`qqnt-bridge POST /v1/stickers/asset`):

1. QQ publishes system faces as ZIP bundles whose entries are
   `<id>/<format>/<id>.png` (plus a larger canvas variant and a Lottie JSON).
   The message sticker path relayed that archive verbatim under a declared
   `image/apng` content type. The bundle unwrapping helper added for reactions
   (`face-asset-bundle.ts`, `4d49cee`) was only wired into the reaction path, so
   every face sticker reached clients as an undecodable ZIP.
2. System faces never carried a byte size. The message mapping (`mapSticker`)
   and `stickerFromReference` leave `size` unset, so the projected Telegram
   document advertised `size: 0`. Telegram schedules sticker downloads from
   `Document.size`, so clients either never scheduled the download or treated it
   as complete.

A third gap made the linked face unreachable at all: face `506` is newer than
the catalog this headless QQ build reports (`0x9154_1` plus the runtime panel
catalog stop at `493`), so `getSysFace('506')` returned nothing and the asset
route answered `500 QQ system face resource is unavailable: 506`.

## Evidence

Production probes (2026-09-23 02:35 CST, bridge `v1.0.40`):

| request | result |
| --- | --- |
| `POST /v1/stickers/asset {"kind":"sysface","faceId":"5"}` | `200`, `504b0304…` (ZIP), 31902 B |
| `POST /v1/stickers/asset {"kind":"sysface","faceId":"424"}` | `200`, ZIP, 105047 B |
| `POST /v1/stickers/asset {"kind":"sysface","faceId":"476"}` | `200`, ZIP, 66293 B |
| `POST /v1/stickers/asset {"kind":"sysface","faceId":"506"}` | `500 QQ system face resource is unavailable: 506` |
| `POST /v1/reactions/asset {"reactionKey":"1:424"}` | `200`, `89504e47…` (PNG), 17065 B |
| `POST /v1/reactions/meta {"reactionKey":"1:424"}` | `{"size":17065,"version":1902483210,...}` |

`mtproto_im_message.id = 1003683` (tl id `1114008311`) stores
`content.parts[0].sticker = { stickerId: "sysface:506", mimeType: "image/apng",
format: "animated", locator: { kind: "sysface", faceId: "506", packId: "4",
stickerId: "108", faceType: 3, animated: true } }` with no `size`, which matches
the zero-size document. `mtproto_im_user`/`mtproto_im_conversation` resolved the
link id `240565744` as `stableId('peer:1103993684')`, the same mapping the
previous reaction investigation used.

QQ keeps the same face resources locally in two places, both of which the relay
now prefers over the CDN: the shipped
`global/nt_data/Emoji/emoji-resource/sysface_res/{apng,static}/s<id>.png` tree
(282 faces, up to `417`) and the account's downloaded
`nt_data/Emoji/BaseEmojiSyastems/EmojiSystermResource/<id>/{apng,png}/<id>.png`
cache (287 numeric faces, up to `493`).

## Fix

`qqnt-bridge`:

- New face resolver (`resolveFaceAssetEntry`) used by the sticker asset route and
  by a new `POST /v1/stickers/meta` endpoint. It prefers, in order: the shipped
  `sysface_res` tree, the account's `EmojiSystermResource` cache, the catalog
  bundle address (deriving the `_adv_` variant for animated faces), and finally
  the CDN addresses of the batches the account already knows, rebuilt as
  `<prefix>/<id>_{adv,base}_<ts>.zip`. Faces are never served as archives: the
  bundle entry that matches the advertised geometry and animation is unwrapped
  and sniffed, and its byte length plus CRC-32 identity are reported.
- `openSticker` for `sysface` now streams that resolved image (local file or
  unwrapped bytes) with the sniffed MIME type and exact size, so the relay can no
  longer hand out a ZIP or a wrong length.
- The reaction catalog merges the account's face cache, so faces newer than
  `face_config.json` (`485`, `486`, `489`, `493`, ...) are served from disk
  instead of from their CDN address, and the runtime panel parser now accepts the
  panel shapes QQ actually sends (nested `downloadBaseEmojiInfo`, alternate id
  and URL field names).
- `GET /v1/faces/catalog` reports every face the process can resolve today.

`platform-qqnt`:

- Messages now hydrate sticker sizes from `POST /v1/stickers/meta` before they
  are projected or persisted, mirroring the custom-emoji hydration. The sticker
  keeps its metadata when the bridge answers nothing, and no bytes are opened
  during projection.
- `face-asset-bundle` gained the `animated` target hint so an animated face is
  served from its `apng/` entry rather than the smaller static fallback.

No `STICKER_PROJECTION_VERSION` bump is required: the previous documents
advertised size zero, so clients had nothing cached to invalidate.

## Verification

- `qqnt-bridge`: `vitest run` passes 333 tests (1 pre-existing Windows-only
  transcript failure absent). New cases cover the local cache path, bundle
  unwrapping with the animated entry, the batch address probe for a face the
  catalog never listed, runtime panel merging, and the animated entry
  preference.
- `platform-qqnt`: `platform.test.ts` passes 111 tests, including the new
  "publishes the exact size and version of a relayed QQ face sticker" case,
  which fails without the hydration.
- Production (to be completed after rollout): `GET /v1/faces/catalog` lists the
  probe faces, `POST /v1/stickers/meta` and `/v1/stickers/asset` agree on size
  and MIME type for both a cached and a catalog face, and the linked message's
  `sysface:506` resolves to a real PNG/APNG whose length matches the document.
