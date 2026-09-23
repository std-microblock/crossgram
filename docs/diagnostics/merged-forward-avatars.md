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
- every one of them resolves to the placeholder UIN `1094950020`, and the
  three distinct senders it downloaded produced byte-identical payloads
  (971 bytes, sha256 `f4da77884bee3c5c…`) — the QQ default avatar;
- the conversation the bundle belongs to ("橘橘橘子汁 | MicroBlock") and the
  relay account have real, distinct avatars (109114 / 59057 byte JPEGs).

So QQ's archived records do not retain a usable per-author identity: unlike
live messages, merged-forward records repeat a placeholder account and only
keep the author's name and an opaque `avatarMeta` (see
`resolveMultiForwardParticipants`). A transcript cannot invent an image the
archive never had, and the relay now shows exactly what the adapter reports —
the default avatar today — instead of replacing it with an empty one.

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
  lookup, its cache and its failure modes.
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
  (8192 bytes, JPEG), the sender avatar (971 bytes, PNG — the default avatar
  QQ keeps for the archive) and the card thumbnail (8192 bytes, JPEG) through
  `inputPeerPhotoFileLocation` / `inputPhotoFileLocation`.

Both avatar payloads arrive from the adapter, so the storage type is sniffed
from the first chunk: QQ serves the archived default avatar as PNG even while
the media claims `image/jpeg`.

## Follow-ups

- The placeholder avatars come from the bridge, which maps every archived
  author to `senderUin`/qlogo. If QQ ever retains a per-author `senderUid` for
  a bundle, the bridge should resolve that avatar through the kernel avatar
  service instead; the relay needs no change to pick it up.
- Telegram Desktop still cannot draw per-sender avatars in a group history
  without a client patch; the relay already serves the photos it would need.
