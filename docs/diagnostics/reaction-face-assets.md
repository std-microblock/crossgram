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

## Remaining

- Only reaction definitions that a message references are measured, so the
  shared catalog entries behind the reaction picker and the emoji sticker set
  can still advertise a zero size until a message references them.
- After the QR restore, confirm that `/v1/reactions/asset` returns PNG bytes
  and that the reaction rows carry the PNG sizes instead of the archive size.
