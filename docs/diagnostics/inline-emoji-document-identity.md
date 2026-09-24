# Inline custom emoji documents published under an unresolvable id (2026-09-23)

## Symptom

A QQ face sent as a message (`my.telegram.org/c/398445207/1116042539`, group
`499314568` / conversation `6`, QQ message `7688624273000031293`, seq 525932)
rendered as an empty cell in Telegram clients. That message text is only the
face, so the whole bubble stayed blank; other faces received the same way
failed the same way.

## Root cause

Two defects on the same path, both in the live update projection
(`packages/bridge/src/update-manager.ts`):

1. `makeMessageEntities` computed the document id itself as
   `stableId(['reaction-resource', 1, platformSessionId, conversationId, key,
   version])`, while every reader of that id -- `messages.getCustomEmojiDocuments`,
   `upload.getFile`, and the id an outgoing message or reaction sends back --
   derives it from `customReactionDocumentId`
   (`['reaction-resource', CATALOG_VERSION (2), platformSessionId, key,
   version]`). The two shapes never match, so the relay published a document id
   it could not answer for.
2. The update path only computed ids; it never registered the definition. Only
   the history path registered documents (through
   `ReactionRpc.toTlReaction`), so a face that arrived as a live update could
   not be resolved until some device re-read that message through history.

A client that received such a message asked `messages.getCustomEmojiDocuments`
for the published id and got an empty vector, and `upload.getFile` answered
`FILE_ID_INVALID` for a document it had cached locally. Telegram renders a
custom emoji cell from the resolved document only, so the cell -- usually the
entire message -- stayed empty.

## Evidence

- Stored message (conversation `6`): `content.parts[0].entities[0]` is a
  `custom-emoji` definition for key `1:476` (不是吧), size 19831,
  `resource.version` 3437369837. That definition resolves:
  `messages.getCustomEmojiDocuments([1086821269])`
  (`1086821269 = customReactionDocumentId('1:476', 3437369837)`) returned one
  document of 19831 bytes / `image/png`, and `upload.getFile` returned exactly
  those bytes (`89504e470d0a1a0a…`). The asset pipeline and the stored data were
  fine; only the id published by the update was wrong.
- The `mtproto_update_delivery` payload of a live message (message `1013337`,
  16:10 CST) carried `messageEntityCustomEmoji.documentId = 2013349505`, which
  matches neither the canonical id for the stored definition (1304255077) nor
  the legacy shape -- an id the relay could not answer. The payload of a
  sibling message (`1013360`, key `1:317`) carried `1100860616`, the canonical
  id, because the delivery journal rebuilt that payload after the fix.
- The client's failures line up with the same path: at 15:12:20 CST the relay
  logged two `crossgram.getFileUrl` calls answered
  `400 MEDIA_DIRECT_URL_UNAVAILABLE` (the patched client's direct-download probe
  for bridge reaction references) followed by sixteen `upload.getFile` calls
  answered `400 FILE_ID_INVALID` -- the document ids of faces it had received
  through updates.
- The wrong identity was also why a relay restart appeared to "wipe" faces:
  nothing had registered the documents the updates advertised, so
  `messages.getCustomEmojiDocuments` answered `[]` for every id until some
  device re-read a message through history.

## Fix

`packages/bridge/src/update-manager.ts` and `packages/bridge/src/reaction-rpc.ts`
(commit `dc60350`):

- The update projection resolves inline custom emoji through
  `customReactionDocumentId` and registers the document while projecting, so the
  published id is the one every lookup uses. `UpdateManager` takes a
  `registerCustomEmoji` callback wired in `packages/bridge/src/index.ts` to
  `ReactionRpc.registerInlineCustomEmoji`.
- Both projection paths also register the retired per-conversation id
  (`legacyInlineCustomEmojiDocumentId`) as an alias of the same document, so a
  message a client cached while the update path still emitted that id keeps
  rendering: the alias answers `getCustomEmojiDocuments`, `getFile`,
  `getFileUrl`, `resolveCustomEmoji`, and the retired-id translation
  `resolveInput` already had. Aliases are not listed in the emoji sticker set,
  so the face is not duplicated.
- The history path (`packages/bridge/src/dialogs.ts`, `_messageEntities`) uses
  the same registration helper, which is what registers the alias when a client
  re-reads a cached message.

## Verification

- `packages/bridge/src/update-manager.test.ts` publishes a message with an
  inline custom emoji and asserts the update's entity carries the canonical id,
  that the document resolves, and that the retired id still answers with a
  document and bytes. The case fails on the previous revision (published
  873432429 instead of the canonical 1112414688).
- `packages/bridge/src/reaction-rpc.test.ts` covers the alias itself (document,
  bytes, `resolveCustomEmoji`, and that the emoji set lists the face once), and
  `packages/bridge/src/dialogs.test.ts` covers the history path's alias.
- `packages/test-suite/src/login.e2e.test.ts` drives a real socket: an emitted
  message's entity names the canonical id, `messages.getCustomEmojiDocuments`
  and `upload.getFile` return the asset for both the canonical and the retired
  id, and the retired id would answer `FILE_ID_INVALID` on the previous
  revision (in-test: 538545572 vs 830862445).
- `vitest run packages/bridge/src` passes 714 tests; the login e2e file passes
  37 tests. The repository typecheck reports the same 15 pre-existing errors in
  unrelated `request-inbox*` and `platform-crossgram` test files before and
  after the change.
- Production (`/opt/crossgram` at `dc60350`, `crossgram.service` restarted
  16:12 CST): the delivery journal payload of a message published afterwards
  carries the canonical id; over MTProto, `channels.getMessages` for the linked
  message registers the retired id, after which
  `messages.getCustomEmojiDocuments(1239155309)` answers one 19831-byte
  `image/png` document and `upload.getFile` streams the exact bytes; before
  that projection the same id answered `[]` and `FILE_ID_INVALID`.

## Remaining

- Document ids published before this fix cannot be translated back: the id is a
  hash over key and resource version, so the relay cannot recover the definition
  for an orphaned id. Clients that cached such messages keep the empty cell
  until they re-read the message (re-open the chat, or restart the client);
  every id published from now on stays resolvable through the alias table while
  the process lives.
- Unrelated but observed while following this link: the clients only treat
  `t.me`, `telegram.me` and `telegram.dog` hosts as internal links (Telegram
  Desktop `Core::TryConvertUrlToLocal`, Android `LinkManager.handleHttp`),
  while the relay advertised `me_url_prefix: https://my.telegram.org/` and the
  clients build "copy link" URLs from it. A `my.telegram.org/c/…` link therefore
  opened in a browser instead of resolving to the message. The relay now
  advertises `https://t.me/` (`0bc2498`); see
  [message links](message-links.md). Links copied before that change stay dead
  until the clients are patched to accept the configured prefix.