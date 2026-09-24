# Merged forwards without avatars (2026-09-23)

## Symptom

Opening a QQ merged forward (the "查看聊天记录" card or its web page preview)
showed a transcript whose synthetic chat and senders had no avatars at all:
Telegram clients drew their own empty placeholders, and the card had no image
next to its title, although QQ keeps an avatar for every merged forward.

Reported with a live pair of links: the card message
`my.telegram.org/c/1670195612/1116310583` (group `479613101`, bundle
`qqnt-message-bundle:["479613101","7688695746422337380",""]`) and the transcript
it opens (`t.me/bridgebundle_1357462542/528646252`).

## What the archive actually contains

The relay used to receive the avatars and then drop them: `buildProjection`
rendered every bundle sender with `userProfilePhotoEmpty`, `makeChat`
answered `chatPhotoEmpty`, and `makePreview` built a web page without a photo.

A production probe (`work/probes/merged-forward-avatar-evidence.ts`,
`merged-forward-avatar-targets.ts`, `merged-forward-avatar-digests.ts`) read the
reported bundle through the live adapter:

- all 58 snapshots carry a sender avatar media
  (`avatar:user:qqnt-multi-forward-participant:<hash>:original-v1`);
- the record's own account is a placeholder: every snapshot repeats
  `senderUin` `1094950020`, so the bridge's qlogo fallback produced one
  byte-identical 971-byte default avatar (sha256 `f4da77884bee3c5c…`) for
  every author;
- the conversation the bundle belongs to ("橘橘橘子汁 | MicroBlock") and the
  relay account have real, distinct avatars (109114 / 59057 byte JPEGs).

QQ keeps the archived author elsewhere: `MsgRecord.multiTransInfo.fromFaceUrl`
carries the avatar of the author of that record ("发送者的头像"), which is the
per-author image the QQ client itself draws in a merged forward.  The bridge
had never read that field, because the identity helper deliberately ignored
the record's own sender account.

The chat an archive was taken from is a different story: the adapter can
resolve it (group avatar for a group history, contact avatar for a private
history), and that is the image QQ itself puts on the card.

## Fix

Relay (`packages/merged-forward`, `packages/bridge`,
`packages/platform-crossgram`):

- `IMMessageBundleProvider` gained an optional `avatar(session, locator)`
  lookup; the QQNT adapter answers it with the peer photo of the archived
  conversation and caches the mapped conversation.
- The projection now registers a peer photo per synthetic sender
  (`userProfilePhoto`) and per transcript chat (`chatPhoto`) from the avatar
  media it already received, plus a Telegram `photo` for the card thumbnail
  and the full-chat profile. All three share one photo id
  (`stableId('avatar:<media id>')`, the id the relay already uses for relayed
  users) and the data centre of the bridge plugin
  (`MtprotoBridgeService.dcId`), so clients fetch them from the same place as
  every other relayed avatar.
- `upload.getFile` forwards `inputPeerPhotoFileLocation` for bundle peers and
  `inputPhotoFileLocation` for bundle photos to
  `platform.downloadMedia`, sniffing the payload for the storage type. Requests
  this feature does not own keep falling through to the ordinary bridge file
  routes, and an unavailable adapter avatar is retried on the next request
  instead of being cached as "no avatar".

Bridge (`qqnt-bridge` 1.0.43, `multi-forward: show the avatar QQ archived
beside each record`):

- `MsgRecord.multiTransInfo` is now part of the kernel types, and
  `resolveMultiForwardParticipants` reads `fromFaceUrl` from it: the archived
  face URL joins the name and `avatarMeta` as the per-author identity
  evidence, so the same author keeps one participant while a namesake with
  another archived avatar becomes a separate one.
- `getMultiForwardMessages` attaches that URL as the participant avatar
  (`directAvatarMedia`, which the relay resolves without touching the bridge),
  falling back to the placeholder account's qlogo avatar only when a record
  carries no usable archived face URL.  A log line reports how many records of
  one transcript had an archived avatar.
- `packages/platform-crossgram` skips its legacy peer-avatar refresh for
  locators that already carry `avatarUrl`, so an archived avatar no longer
  costs a bridge round trip for the placeholder account.

Android patcher: `CrossgramMergedForward` only knew the pre-rewrite
`t.me/bridgechat_<id>` link, so `bridgebundle_<id>` links from the current
relay fell through to Telegram's generic handler. It now accepts both shapes
and resolves the username with the prefix it matched.

## Client behaviour

- Telegram Android draws a sender avatar next to every message of a basic chat
  (`needDrawAvatar()` with `isChat`), so the transcript now shows the archived
  avatar per message instead of an initials circle.
- Telegram Desktop draws per-sender avatars only in comment threads and
  monoforum bars, never for group messages, so there the visible result is the
  transcript's own photo in the top bar (and in the chat's profile), plus the
  card thumbnail.
- Both clients render a web page photo beside the title for a
  `telegram_message` preview; `WebPageData::computeDefaultSmallMedia`
  (Telegram Desktop) keeps it a small square for this type instead of a full
  width attachment.

## Verification

- `packages/merged-forward/src/avatars.test.ts` covers the sender photo, the
  chat photo, the card photo, session scoping, shared avatar media between two
  transcripts, unload cleanup and failing adapter lookups.
- `packages/merged-forward/src/projection-rpc.e2e.test.ts` drives the RPC
  surface: history users and chats carry the photos, `messages.getFullChat`
  mirrors the chat photo, and `upload.getFile` returns the adapter bytes for a
  user photo, a ranged chat photo and the card photo, while a location this
  feature does not own still reaches the following route.
- `packages/platform-crossgram/src/bundle-avatar.test.ts` covers the adapter
  lookup, its cache and its failure modes, and `platform.test.ts` covers both
  the legacy avatar refresh and the archived URL that skips it.
- `qqnt-bridge` `src/qq-kernel.test.ts` covers the archived avatar path: records
  that share a face URL stay one participant, a namesake with another archived
  avatar becomes its own, and a record without a usable URL keeps the
  placeholder avatar.
- `packages/test-suite/src/login.e2e.test.ts` repeats the avatar assertions
  over a real MTProto socket, including the card thumbnail served through
  `inputPhotoFileLocation`.
- `crossgram-android` `tests/merged-forward.test.ts` compiles both link shapes
  and the prefix-preserving username resolution.

## Live verification (2026-09-23)

The relay was fast-forwarded to `0a7fc43` and `crossgram.service` restarted
(`NRestarts=0`, MTProto 41003 and WebUI 3140 listening, no error-priority
journal). A real mtcute client (`yarn mtproto:e2e run
work/mtproto-e2e/merged-forward-avatars.ts --profile production`) then read the
reported pair: it opened the card message `1116310583` in the group
`1670195612` ("橘橘橘子汁 | MicroBlock"), which anchors
`https://t.me/bridgebundle_1357462542/528646252`, and asked the relay for the
transcript.

- `contacts.resolveUsername` answered `contacts.resolvedPeer` with
  `photo: chatPhoto`, and `messages.getHistory` returned 58 messages, 4
  senders, all 4 carrying `userProfilePhoto`, with the anchor message present
  and the transcript chat carrying `chatPhoto`.
- `upload.getFile` over the real socket returned the chat avatar
  (8192 bytes, JPEG), the card thumbnail (8192 bytes, JPEG) and a sender
  avatar (971 bytes, PNG — the bridge's placeholder fallback at the time).

Both avatar payloads arrive from the adapter, so the storage type is sniffed
from the first chunk: the placeholder avatar came back as PNG even while the
media claimed `image/jpeg`.

## Archived avatars after the bridge fix (2026-09-24)

`qqnt-bridge` v1.0.43 was released through GitHub Actions (Linux and Windows
packaging passed) and installed on the bridge host with
`update-qqnt-bridge.ps1 -Tag v1.0.43` (release asset SHA-256
`48dec705c338a7e8dbe69758d9ee7d8d8de7b0b0c2c7205ad32d2560745243f9`).  QQ came
back `ready=true` / `authenticated` on protocol 33 without a new scan, and the
bridge reported the new evidence for the reported bundle:

```text
native API merged-forward avatars conversation=479613101 root=7688695746422337380 records=58 archivedAvatars=58
```

The same mtcute probe then downloaded every sender avatar of that transcript
through `upload.getFile`; each one is a distinct real JPEG:

| sender | bytes | sha256 (first 12) |
| --- | --- | --- |
| Kokoni | 109118 | `11073ba6e1d2` |
| Velvet | 105669 | `7ca42e094978` |
| 。 | 34423 | `2be0e646561f` |
| AAA伤感酷头子 | 47371 | `9fa16f6362c9` |

Before the bridge release all four downloads were the same 971-byte default
avatar.  The archived face URL is also part of the participant fingerprint
now, so a transcript that gained real avatars hands out new photo ids and
clients do not keep showing the placeholder they cached earlier.

## Follow-ups

- QQ can still answer a record without `multiTransInfo.fromFaceUrl`
  (imported transcripts in some formats).  Those records keep the placeholder
  account avatar, which is the only identity their archive holds.
- Telegram Desktop still cannot draw per-sender avatars in a group history
  without a client patch; the relay already serves the photos it would need.
