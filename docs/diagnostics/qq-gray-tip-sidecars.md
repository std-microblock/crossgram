# QQ gray tips share the msgSeq of the message they accompany (2026-09-24)

## Symptom

Two client-visible defects were reported for QQ gray tips (poke notices, essence
notices, call records, revoke notices):

1. A reply that should point at a content message pointed at a nearby gray tip
   instead. Reported pair: `t.me/c/1322274431/1117851207` should reply to
   `t.me/c/1322274431/1117817143`.
2. Deleting a gray tip in a Telegram client also deleted the message next to it.

## Root cause

QQ gives a gray tip the `msgSeq` of the content message it follows; the tip is a
sidecar of that message's slot and never owns a sequence. Production QQ group
`550358997` (conversation `88`) shows the reuse directly: one content message and
six poke notices share `seq 46513`.

```text
id 1049625  src 7689041730164989900  seq 46513  tl 1117817143  "（嘻嘻 /models 是我测的"
id 1049648  src 7763258923973739795  seq 46513  tl 1117817751  "海豚捏了捏你的🍊"
...         six sidecars in total, all on seq 46513
id 1050620  src 7763267369130659866  seq 46513  tl 1117849207  "AfterDawn捏了捏你的🍊"
id 1050675  src 7689050869547399474  seq 46514  tl 1117851207  "@MicroBlock 强强"
```

The reply row `1050675` carries
`__mtprotoRelayReplyToId = 7763267369130659866` (the poke notice) next to
`qqReplyToMsgSeq = 46513` (the content message), so the relay resolved the reply
header to the sidecar even though the sidecar is only a rendering of the content
message's slot.

Deletion has the same shape, and production proved QQ resolves a recall of a
sidecar to that content message. In QQ group `280405790` (conversation `9`) the
essence notice `你的消息被设为了精华消息` (id `1007962`, src `7762810719824604063`,
seq `815110`) was deleted through a client:

```text
13:45:28 native API start name=recallMsg conversation=280405790 messages=7762810719824604063
13:45:28 native message delete chatType=2 peer=280405790 messages=7688593663187758584
```

`7688593663187758584` is the neighbouring content message (id `1007959`, "我草我是
debug 包"), which then carried `__mtprotoRelayRecalled: true` at `13:45:28.888`:
the Telegram delete reached QQ as a recall of a real message the user never
touched. Recalling a tip is not a QQ operation at all: QQ keys the delete by the
slot, and the slot's message is the content message.

## Fix

- `crossgram@cb18d1a` - `MessageStore.preferContentReplyTarget()` redirects a
  reply target that resolves to a service notice onto the content message that
  owns the same `nativeSequence`; `findReplyTarget()`, the dialogs read path
  (`_rememberReplyTargets`, which also re-resolves a sidecar that was cached
  earlier) and `UpdateManager`'s live reply resolution all use it. A notice whose
  sequence has no content sibling (or whose sibling is gone) stays the target,
  because the tip is then the only message QQ can mean.
- `crossgram@cb18d1a` - `DialogRpc.deleteMessages()` never forwards a service
  notice to the platform. Notices are removed through the durable local update
  pipeline instead (every session drops them and the deletion is journaled), and
  they are removable at any age because they are relay-side renderings rather
  than someone's message.

## Verification

- `packages/bridge/src/message-store.test.ts`: exact gray-tip target resolves to
  the content sibling, a notice owning its sequence stays, and a deleted sibling
  falls back to the tip.
- `packages/bridge/src/conversation-kinds.test.ts`: deleting a notice calls no
  platform delete, publishes a `message-delete` event with
  `deliveredViaRpc: true`, removes only the notice, and works for a member who
  may not delete old third-party messages; the history read renders the reply
  header against the content message.
- `packages/bridge/src/update-manager.test.ts`: the live update's `messageReplyHeader`
  points at the content message.
- `packages/platform-crossgram/src/message-order.e2e.test.ts`: real WebSocket
  bridge events (content + two sidecars on `46513` + a reply naming the newest
  sidecar) through `QQNTPlatform`, the store, `UpdateManager` and `DialogRpc`;
  asserts the live update and the history read both name the content message, and
  that deleting the sidecar removes it locally without calling the platform.

Workstation run with the fix: `yarn vitest run` 1546 passed / 40 skipped,
`packages/platform-crossgram/src` e2e 45 passed / 11 skipped,
`packages/bridge/src` e2e 56 passed with the pre-existing
`photo-send-reconciliation` photo-size failure (fails with the fix stashed as
well). `yarn typecheck` reports the same 22 pre-existing errors as before this
change, all in files this commit does not touch plus two line-shifted
`dialogs.ts` `inputPeer` narrowings.

Production is still on `0bc2498`; main also now carries the parallel
`platform-qqnt` store-face favourite work, so the next fast-forward ships both.
