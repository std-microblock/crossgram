# Store-face favorites could never load (2026-09-24)

## Symptom

The `QQ 收藏表情` set the relay publishes contained cells that never filled. In
production the pack listed 421 documents of which **9 had `size: 0`**, and
`upload.getFile` for those documents waited about half a minute and then
answered `404 QQ market sticker file is missing`.

## Root cause

Three layers agreed on the same unloadable document:

1. A favorite of a QQ **store face** (a market face) reaches the relay as
   `kind: 'market'` with a `favoriteResId` and local `Thumb`/`Ori` paths that
   QQ has usually already cleaned up. The bridge reports no size for it, so
   `QQStickerProvider.mapSticker` published the document with a zero size —
   and Telegram clients schedule sticker downloads from `Document.size`, so
   they never even asked for these (the same trap
   `sticker-face-assets.md` records for system faces).
2. The relay's file route forwards such a document to the bridge's market
   path, which needs QQ's single native download slot: `fetchMarketEmoticonAioImage`
   plus up to 300 × 100 ms of path polling, serialized by
   `marketStickerDownloadTail`. When the local file is gone the slot is waited
   out for nothing and the asset ends as `QQ market sticker file is missing`.
3. The face itself is still fine: QQ's expression CDN serves it at
   `https://p.qpic.cn/qq_expression/<uin>/<resId>/0` — the URL shape plain
   favorites already carry — and a two-byte range request answers
   `content-range: bytes 0-1/23235` with `content-type: image/png`.

## Fix

`crossgram@e7430e5` (`platform-qqnt: publish the favorite copy of a QQ store
face`), in `packages/platform-crossgram`:

- `QQNTClient.probeRemoteSticker(url)` measures an expression-CDN asset with a
  two-byte range request and returns its exact byte length and MIME type.
- `QQStickerProvider` publishes the **favorite copy** of a store face that is
  also a favorite — same image, served from the CDN the bridge already streams
  for plain favorites — together with the measured size and MIME type. The
  measurement is cached per res id, the native market reference stays in the
  send plan so tapping the sticker still sends the real market face, and a probe
  that finds nothing keeps the previous market reference.

## Verification

- `packages/platform-crossgram/src/sticker-provider.test.ts` covers the
  rewritten locator, the published size/MIME type, the send plan, the
  probe-failure fallback and the URL builder (10 tests in the file).
- `packages/platform-crossgram/src/sticker-provider.e2e.test.ts` streams a
  store-face favorite through the favorite reference and asserts a repeated pack
  read reuses the measurement (4 tests in the file).
- Production (`/opt/crossgram` fast-forwarded `0bc2498` → `e7430e5` at
  19:04 CST, `crossgram.service` restarted, `NRestarts=0`): the probe
  `work/mtproto-e2e/sticker-zero-size.ts` reported `zeroSized: 9` before the
  change and `zeroSized: 1` after it, and
  `work/mtproto-e2e/sticker-favorite-verify.ts` downloads the previously dead
  documents:

  | document | size | download |
  | --- | --- | --- |
  | 3337426728748742 | 23235 | 4096 bytes, PNG magic, 246 ms |
  | 3575639919283943 | 20000 | 4096 bytes, PNG magic, 114 ms |
  | 507014893639581 | 31122 | 4096 bytes, PNG magic, 76 ms |
  | 1625391344726337 | 5483 | 4096 bytes, PNG magic, 95 ms |

## Remaining

- One favorite
  (`1715311957_0_0_0_0FF0EE2C70DF19B083852CE510A83AE1_0_0`) is gone both from
  QQ's local cache and from the expression CDN (`404`), so there is nothing to
  serve; it keeps a zero size and stays a silhouette. Dropping it from the pack
  would hide a QQ favorite, so the relay keeps publishing it.
- Market faces that are **not** favorites have no res id to build an expression
  URL from and keep the bridge's market path. The bridge can already find the
  favorite res id for such a face (`findFavoriteResId`, used when removing a
  favorite), so the same fallback could later move into the bridge.
