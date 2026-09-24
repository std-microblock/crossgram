# Group join gray tips rendered as custom actions (2026-09-24)

## Symptom

Every QQ gray tip reached Telegram as `messageService` /
`messageActionCustomAction`, join notices included. Clients rendered them as
plain centered text: no link to the joined member, no way to open the profile,
and no `joined the group` semantics that a Telegram client understands.

## What the production data says

A read-only probe over the newest 8 000 rows of `mtproto_im_message` found
185 service messages (11 join notices); a second pass over 20 000 rows listed 18
join notices, with QQ's wording split as

- `<name>加入了群聊。` — 14 of 18, QQ's plain `otherAdd` member-add notice
- `<inviter>邀请<name>加入了群聊。` — 3 of 18, QQ's `otherInviteOther` notice
- `<inviter>邀请<name>加入了群聊，并附带了30条聊天记录。` — 1 of 18, the
  “share with chat history” notice

Member names resolved to QQ nicknames (CJK and latin), never to UINs, so the
wording comes from the structured `grayTipElement.groupElement`
(`groupElement.memberAdd`, QQ's `MemberAddShowType` variants) rather than from
the `genericGrayTipText` fallback or the legacy XML element path.

## Root cause

The bridge only ever published `{ type: 'custom', text }` service actions, and
`projectTlMessage` mapped that to `messageActionCustomAction`. Nothing in the
pipeline carried *which* members a notice names, so no layer could emit
Telegram's native join action, and no payload referenced the joined user for the
client to link.

Two bugs sat underneath that:

1. `groupGrayTipText` numbered `memberAdd.showType` by hand and had
   `showType === 1` as “你已经是群成员了”. QQ numbers the variants with
   `MemberAddShowType`: **1 is “you joined”** and **8 is “you are already a
   member”**, so the two variants produced each other's wording and variant 8
   fell through to the generic `otherAdd` branch.
2. The join notice's members were never persisted as Telegram users, so even a
   native join action could not have been projected: `_userId()` fails closed
   for a platform user without a stored row.

## Fix

`qqnt-bridge` (bridge protocol v34) — `src/qq-kernel.ts`:

- `groupGrayTipNotice()` replaces `groupGrayTipText()`: it keeps QQ's wording
  and, for `groupElement.memberAdd`, returns the structured participants
  (joiner/members, inviter, QR-code/link variant) next to it. The showType table
  now follows QQ's own enum, including the corrected 1/8 mapping.
- A join notice is attributed to the member QQ names (joiner for a plain join,
  inviter for an invite, the joiner for link joins), so the relay's `fromId`
  matches what Telegram shows. The gray tip's own placeholder sender fields
  (`senderUin`/`sendNickName` `0`) no longer leak onto that user.

`crossgram` — `packages/bridge`, `packages/platform-crossgram`:

- `IMMessageContent.serviceAction` gained
  `{ type: 'members-joined', text, members, actor?, viaInviteLink? }`; the QQ
  wire protocol (`WireServiceAction`, accepted bridge protocol range 19–34)
  exposes the same shape, documented in `packages/platform-crossgram/PROTOCOL.md`.
- `makeTlServiceAction()` projects it as `messageActionChatAddUser`
  (`messageActionChatJoinedByLink` with the inviter for link/QR joins) and
  falls back to `messageActionCustomAction` with QQ's wording when a member
  cannot be named.
- Members are materialized before projection: `UpdateManager` resolves the
  profile and adds the user to the update payload, `DialogRpc` persists the
  profile (`_resolveServiceMembers`) and includes every named member in the
  history/dialog response users, and `messageReferencedUserIds()` now counts
  them so dialog refresh paths keep the rows. A member that is already the
  message sender keeps the profile it arrived with.

## Verification

- `qqnt-bridge`: `qq-kernel.test.ts` covers all nine `MemberAddShowType`
  variants (names, actors, `viaInviteLink`, the unnamed-member fallback, the
  unknown-variant fallback and the placeholder sender), plus the existing poke,
  mute, announcement and XML gray-tip cases. Full suite: 349 tests pass.
- `crossgram` unit: `dialogs.test.ts` projects a join/invite/link triple into
  `messageActionChatAddUser` + `messageActionChatJoinedByLink` with the mapped
  member ids in `users`, and pins the wording fallback; `update-manager.test.ts`
  publishes a join notice for a member that never sent a message and asserts the
  update payload and the channel difference both carry the member;
  `platform.test.ts` maps the wire action through the QQNT adapter. Full unit
  suite: 1551 tests pass.
- `crossgram` e2e: `platform-crossgram/message-order.e2e.test.ts` pushes a QQ
  join gray tip over the bridge WebSocket and checks the published update and the
  history RPC; `test-suite/login.e2e.test.ts` drives a real MTProto client
  through login → `messages.getHistory` and checks the native action plus the
  member in the response `users`.

## Not covered

The “share with chat history” variant (`并附带了30条聊天记录`, 1 of 18 samples)
keeps QQ's wording as `messageActionCustomAction`: it announces a share rather
than a plain join, and Telegram's join action cannot express the attached
history.
