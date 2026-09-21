# Runtime QQ face reactions (2026-09-21)

## Symptom

Two reactions on a QQ group message (`my.telegram.org/c/240565744/1111915079`,
QQ message `7687849275374030532` in group `1103993684`) never rendered in
Telegram clients. Both are QQ system faces: `/续标识` (a hand pressing a button)
and `/对的对的` (a smiling face holding a green check sign).

## Root cause

Two defects stacked on the same reaction:

1. `qqnt-bridge` relayed the QQ CDN payload verbatim. Faces that are not part of
   the local `emoji-resource` tree (QQ exposes newer system faces only through
   its runtime catalog) are downloaded as a ZIP bundle that wraps
   `<id>/png/<id>.png` next to a larger canvas variant. Clients received an
   archive under an `image/png` content type and dropped the face while
   decoding, leaving the reaction cell empty.
2. The reaction definitions of those faces carried no byte size. Telegram
   schedules custom-emoji downloads from `Document.size`, and the existing size
   hydration only walked inline `custom-emoji` entities, so reaction documents
   advertised a zero size even when the bytes were valid.

## Evidence

A production probe (deployed through `debug-scripts`, removed afterwards)
resolved the linked message through the live `platform-qqnt` adapter and
streamed every reaction asset:

| reaction | served bytes | first bytes | declared size |
| --- | --- | --- | --- |
| `1:424` | 105047 | `504b030414000800` (`PK\x03\x04`, ZIP) | 105047 |
| `1:478` | 67165 | `504b030414000800` (ZIP) | 67165 |

The `mtproto_im_message_reaction` rows for message `944933` stored the same
definitions without `presentation.resource.size`, which matched the second
defect. A first probe attempt through `messages.getHistory` did not reach the
message because it scrolled the newest page; the link path
(`platform.getMessage`) resolves the id directly.

## Fix

- qqnt-bridge commit `4d49cee` adds `src/face-asset-bundle.ts`: ZIP detection,
  a central-directory reader (QQ writes the real sizes there and puts data
  descriptors in the local headers) and a picker that prefers the entry whose
  aspect ratio matches the geometry the catalog advertises, so a wide face is
  not stretched into the inline square. `openReactionResource` unwraps and
  caches that image and reports the sniffed type.
- crossgram commit `3fa4b21` extends `hydrateReactionResourceSizes` to the
  custom definitions referenced by the message reaction context, and reuses
  already measured sizes for later messages instead of downloading again.

## Verification

- qqnt-bridge: `vitest run src` passes 314 tests, including a new
  `unwraps ZIP face bundles into the image a reaction advertises` case. The
  bundle module is covered for data-descriptor archives, stored entries, APNG
  detection and malformed payloads.
- crossgram: `packages/platform-crossgram/src/platform.test.ts` passes 109
  tests. `hydrates sizes for the reaction documents a message advertises` fails
  without the platform change.
- Production:
  - The bridge asset endpoint served ZIP payloads for both reactions before the
    fix (see the table above); the probe also confirmed the definitions reached
    the adapter without a size.
  - qqnt-bridge `v1.0.39` was installed on the production bridge at 15:38 CST
    (app.asar swapped; the deployed bundle contains the new unwrapping code).
    The recorder/relay account needs a QR scan after that update, so the
    post-install asset check is the first step once the account is back.
  - `platform-qqnt` was fast-forwarded to `3fa4b21` on `/opt/crossgram` and
    `crossgram.service` restarted; the service is active with no error-priority
    journal entries.
  - No reaction definition rows with the stale archive size were persisted
    (`version = 1` rows with a `size` key: 0), so the first client read after
    the login restores will record the PNG sizes.

## Follow-up: a stale size survived the first rollout

After the first fix a second message (group `1083447990`, QQ message
`7687945934278288398`) still showed an empty reaction cell. Its definition
advertised `size: 67165` — the length of the *archive* — while the relay now
served a 19787 byte PNG. Clients request `Document.size` bytes, so they never
finished the download.

Two things had to change:

1. Only definitions *without* a size were hydrated, so a measurement taken while
   the bridge still relayed archives stayed authoritative in the relay cache and
   in `mtproto_im_message_reaction.definition`.
2. Remote assets can change. The catalog hardcoded `version: 1` for CDN faces,
   and Telegram caches custom emoji by document id (which is derived from the
   version), so new bytes would have kept the old document identity.

### Resolving size and identity cheaply

QQ writes the entry size and CRC-32 in the bundle's central directory and only
uses data descriptors in the local headers, so the exact length of the served
image is available from the last ~96 KiB of the archive. `qqnt-bridge` now
exposes `POST /v1/reactions/meta`, which:

- issues one ranged request (`Range: bytes=-98304`) and parses the central
  directory, falling back to unwrapping the whole archive if the CDN ignores the
  range;
- picks the entry with the same rules that serve the bytes, so the announced
  size always matches the payload;
- reports the entry's CRC-32 as the resource version (a content identity, so a
  changed remote image re-keys the document) and re-resolves after a ten minute
  TTL;
- answers local faces from the file's size and modification time, which keeps
  their existing identity.

`platform-qqnt` asks for that metadata instead of streaming a face, replaces
stale sizes and versions (which also repairs rows written during the first
rollout), shares one in-flight lookup per face, and warms the published catalog
in the background so the reaction picker and emoji sticker set describe
documents the same way. Downloads remain the fallback when the metadata endpoint
is unavailable.

### Verification

- qqnt-bridge: `vitest run src` passes 319 tests, including a case that reads
  size, CRC-32 and entry name from an archive tail only, and one that asserts a
  changed bundle re-keys the asset and drops the cached payload.
- platform-qqnt: 109 tests pass. `corrects a stale reaction size and follows
  remote changes` fails without the change, and the metadata test asserts the
  face is not downloaded just to learn its length.
- Production probe on the second message after the relay change:
  `size: 19787`, served bytes `89504e47…` (PNG) with `length: 19787`, so the
  advertised size matches what clients receive.

### Rollout

- `platform-qqnt` was deployed to `/opt/crossgram` and `crossgram.service`
  restarted on commit `b95d6a9`.
- qqnt-bridge `v1.0.40` was installed on the bridge host (the deployed
  `app.asar` contains `/v1/reactions/meta`). As with earlier bridge updates,
  QQ refused the saved tickets and the recorder needs one QR scan before the
  catalog and the metadata endpoint come back.

## Remaining

- The background catalog warmup resolves CDN faces once per process, so a picker
  opened in the first seconds after a restart can still see zero-size entries
  until the warmup reaches that face.
- After the QR restore, confirm that `/v1/reactions/meta` reports the entry
  size and CRC-32, that `/v1/reactions/asset` still returns PNG bytes, and that
  the reaction rows carry the PNG size instead of the archive size.
