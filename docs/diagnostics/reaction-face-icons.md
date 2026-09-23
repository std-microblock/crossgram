# Reaction cells rendered the message canvas (2026-09-23)

## Symptom

A QQ group message (`my.telegram.org/c/240565744/1114720887`, channel
`1103993684` / conversation `9436`, QQ message `7688602458463086004`, seq
483347) showed its reaction as the wide dragon-boat artwork. The face behind it,
`/中龙舟`, is the 小粽子 icon in QQ: the reaction pill has to render the square
icon, not the 大表情 canvas the same bundle carries.

## Root cause

QQ ships every system face twice inside one bundle: the square icon
`<id>/png/<id>.png` it draws inline, and the wide canvas
`<id>/png/<id>_0.png` it animates when the face is a message sticker. The
shipped `face_config.json` lists the canvas size only as `AniStickerWidth` /
`AniStickerHeight` (192x76 for `416`, 192x92 for the `419` train family), but
for the visible faces the catalog used the on-disk PNG size and therefore
published the icon geometry.

Faces the local config hides (or a newer QQ adds) are defined from the runtime
panel catalog instead, and that definition copied the panel geometry verbatim
into `resource.width` / `resource.height`. The reaction asset resolution then
used the definition geometry as its entry hint, so:

- `resolveReactionAssetImage` ranked the wide `<id>_0.png` entry first and the
  relay served the canvas artwork where a pill expects an icon;
- the definition advertised `192x76`, so clients laid the document out as the
  wide artwork instead of the square icon.

The same family face `415` (visible in `face_config.json`) kept serving its
square zongzi icon, and every other QQ face reaction in use resolved to a
128x128 icon, which is what the linked reaction was compared against.

## Evidence

- Production `mtproto_im_message_reaction` row for message `1008638`:
  `key: "1:416"`, `definition.resource = { size: 61366, version: 3342178892,
  width: 192, height: 76, mimeType: "image/png" }` — 61366 bytes is exactly
  `416/png/416_0.png`.
- The QQ CDN bundles for the face: `416_base_1717502894.zip` wraps
  `416/png/416.png` (16477 B, the 128x128 zongzi icon) and
  `416/png/416_0.png` (61366 B, the 480x190 canvas); `416_adv_1717502894.zip`
  adds the Lottie animation. `419` shows the same split: a clean 128x128 train
  icon next to the wide train cartoon.
- `GET /v1/reactions/catalog` served `1:415` with `128x128` (the icon) while
  `1:416`, `1:417`, `1:419` and `1:420` carried the canvas geometry, so the
  relay disagreed with itself inside one face family.
- The catalog's own entry comment already described the rule: the square entry
  is the inline face and the underscore suffix is the canvas variant.

## Fix

`qqnt-bridge` commit `3828c15`:

- Reaction resources resolve the canonical square entry: `reactionAssetTarget`
  only carries the face id, so the ranker prefers `<id>.png` and never picks the
  canvas. Message faces keep the wide entry through a separate
  `faceCanvasTarget` built from the catalog geometry.
- The catalog keeps both geometries apart: the canvas size a face advertises is
  remembered in `faceCanvasGeometry` for the sticker path, while a reaction
  definition publishes the icon size read from disk (128x128 when QQ has not
  downloaded the icon yet).
- Reaction asset metadata (`/v1/reactions/meta`) now reports the icon geometry
  for local files and bundle entries, so a client can size the document from the
  same metadata it uses for the byte length.
- The local face cache loop and the diagnostics face catalog use the icon
  target as well, so every inline reader describes the same file.

`platform-qqnt` adopts the reported geometry while hydrating a reaction
resource: `applyReactionResourceMeta` (and the background warmup) now correct
`width`/`height` together with `size`/`version`, which repairs the stored
definitions written while the relay still served the canvas under the wide
geometry.

## Verification

- `qqnt-bridge`: `vitest run src` passes 338 tests. The bundle case now asserts
  that `/v1/reactions/asset` for `1:416` serves the icon bytes and that
  `/v1/stickers/meta` for the same face still resolves the 480x190 canvas, and a
  new case pins the published icon geometry (128x128) for a runtime face whose
  panel advertises 192x76.
- `platform-qqnt`: `platform.test.ts` passes 113 tests, including
  `adopts the inline icon geometry the bridge reports for a wide face`, which
  fails without the geometry adoption.
- Production, 2026-09-23 15:40 CST (bridge `v1.0.42`, relay `0a9118e`):

  | request | result |
  | --- | --- |
  | `POST /v1/reactions/meta {"reactionKey":"1:416"}` | `16477`, `width: 128`, `height: 128`, `entry: "416/png/416.png"` |
  | `POST /v1/reactions/asset {"reactionKey":"1:416"}` | `200`, `content-length: 16477`, `84d4e1d2…` — the icon `1:415` already served |
  | `POST /v1/reactions/meta {"reactionKey":"1:419"}` | `15324`, `entry: "419/png/419.png"` |

  The relay restarted with the new bridge and its background catalog warmup
  re-resolved every CDN-backed definition; the bridge log shows
  `reaction meta key=1:416 size=16477 version=3301497631 source=payload` for
  that pass, so the published reaction document now carries the icon geometry.
  Clients only need to re-read the message: the document identity is derived
  from the key and the icon CRC-32, so the canvas document is left behind.

## Rollout

- `qqnt-bridge` `v1.0.42` was built by GitHub Actions, installed on the bridge
  host with the maintenance `update-qqnt-bridge.ps1` script, and QQ returned
  `ready=true` / `authenticated` without a QR scan.
- `platform-qqnt` was fast-forwarded on `/opt/crossgram` (commit `0a9118e`) and
  `crossgram.service` restarted; no build runs on the production host.
- Client documents are re-keyed automatically: the icon bytes carry a different
  CRC-32 than the canvas, so every cached reaction document is replaced once the
  catalog hydrates.
