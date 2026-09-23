# Merged-forward deep links opened at the last message (2026-09-23)

## Symptom

On the desktop client, opening a QQ merged forward (the "查看聊天记录" card or
its web page preview) landed on the **last** message of the transcript. Native
Telegram merged forwards open at their first message, and the relay had already
shipped that behaviour once, so the client was expected to start at the top.

## Root cause

Two independent defects; each of them alone is enough to open the view at the
newest message.

**1. The relay anchored the link at the newest snapshot.** `3960063`
("merged-forward: render message bundles without virtual dialogs") rewrote the
viewer around `IMMessageBundle`s and replaced the first-message anchor that
`d747801` had introduced with `newestSnapshot(...)`. Both the text link
(`https://t.me/bridgebundle_<chatId>/<messageId>`) and the preview card of the
same message pointed at the newest message, so every client that honours the
anchor scrolled to the end of the bundle.

**2. The client only knew the pre-rewrite username shape.** `e5ead89`
("merged-forward: hide synthetic desktop dialogs") taught the desktop client
about `bridgechat_<id>`, the shape the relay emitted before the bundle
rewrite. A `bridgebundle_<id>` link therefore never reached the merged-forward
branch. It fell through to the stock link path, which drops the anchor for
basic chats (`useRequestedMessageId = peer->isChannel()`) and opens the view at
the unread/end position — the newest message. The peer also stopped being
marked, so the client-side "keep the synthetic chat out of the chat list" hook
did not run for links in the current shape; only the relay-side
`messages.getPeerDialogs` guard still suppressed the dialog entry.

Both changes were verified against the client sources: for a non-channel peer
`showPeerByLinkResolved` substitutes `ShowAtUnreadMsgId` for `info.messageId`,
and `HistoryWidget::firstLoadMessages` only requests "around the anchor" when
`_showAtMsgId > 0`.

## Fix

- `crossgram@ad0c088` — `firstSnapshot()` anchors the link, the preview and the
  preview card at the message the projection displays first: the oldest
  snapshot, ties resolved by the projected message id, mirroring how
  `buildProjection` orders equal timestamps.
- `crossgram-desktop@a0dd42a` — `MergedForward::IsUsername` accepts
  `bridgebundle_<id>` as well as the legacy `bridgechat_<id>`. The accepted
  shapes now live in a Qt-free `merged_forward_core.h` that
  `merged_forward.cpp` maps the `QString` onto.

## Keeping already-cached cards correct

Clients cache message content in their local storage, and `History::createItem`
returns the stored item for an id it already has, so a card fetched before the
relay anchored links at the first message keeps its newest anchor and opens at
the end of the transcript no matter what the relay serves afterwards.

The patched desktop client therefore asks the relay where the transcript starts
instead of trusting the link.  Once the synthetic peer resolves it calls
`crossgram.getMergedForwardAnchor` (`peer:InputPeer = DataJSON`, constructor id
`f4a571c7`, the same value the desktop patcher writes into
`mtproto/scheme/api.tl`) and opens the history at the returned `messageId`.  An
older relay answers an unknown method with an error, an unknown peer answers
`0`, and both keep the anchor stored in the deep link, so the client degrades to
the previous behaviour.

The relay also answers a `messages.getHistory` request anchored at offset id 1
(`kFirstMessageOffsetId`, a value synthetic hashed message ids never take) with
the oldest messages of the bundle, which keeps the beginning reachable for
clients that can only send standard requests.

## Verification

Relay:

- `packages/merged-forward/src/index.test.ts` projects a bundle whose snapshots
  arrive out of order and asserts that the text link and the preview media
  anchor at the oldest one.
- `packages/merged-forward/src/projection-rpc.e2e.test.ts` drives the RPC
  surface with the request a desktop client sends when opening a link
  (`messages.getHistory` with the anchor as `offsetId` and `addOffset = -25`)
  and asserts the returned page contains the anchor plus the rest of the
  bundle, and that `messages.getMessages` resolves the anchor itself.
- `packages/test-suite/src/login.e2e.test.ts` covers two levels of nesting over
  real MTProto: the parent card's link equals the first message of the outer
  bundle, the nested card's link equals the first message of the inner bundle,
  and both desktop-shaped history requests return their anchor.
- The rest of the repository-wide unit suite is unchanged apart from the two
  pre-existing `deploy-files`/`config-schema` failures that main already has.

Desktop:

- `tests/merged-forward.e2e.test.ts` applies the patch twice (idempotent), and
  compiles the installed core header with `clang++` into a harness that checks
  `bridgebundle_<digits>`, the legacy `bridgechat_<digits>`, mixed case, and
  the rejected shapes (a missing or empty suffix, `bridgebundle_0`,
  non-digits, an overflowing id, other prefixes).
- The same fixture is patched against pristine upstream sources from every
  supported repository by `.github/workflows/check.yml`, which passed for all
  28 target/brand combinations of this commit (run 271).
- The new method is covered by the wire-contract decode test
  (`packages/mtproto/src/rpc/server-reader-map.test.ts`), by the RPC e2e
  (known, unknown and non-chat peers) and by the lifecycle e2e, which asserts
  the route belongs to the plugin fiber.
- The desktop patch e2e asserts the injected TL line, the request, the guarded
  callbacks, both `showPeerHistory` endings and the Qt JSON helper, and the
  patch still applies twice, byte-identically, to pristine upstream sources
  (checked locally against the reference checkout and by `check.yml`).
- Live relay: the `inspect-relay` probe
`work/probes/merged-forward-anchor.ts` projected a bundle through the running
production plugin and compared the link anchor with the id computed from the
documented key format: `anchorIsFirstMessage: true`,
`anchorIsNewestMessage: false` (`https://t.me/bridgebundle_1006709955/1558156099`).
The same probe also tries a real archived bundle first; that path returned
`QQNT bridge 503: QQNT kernel is not ready` because the QQ kernel was waiting
for a login scan at the time, so the production check used the synthetic bundle
and the real-data path stays available for a later run.

- `crossgram-desktop` release run 242 published `crossgram-242`
  ("Crossgram Desktop #242") from patcher commit `a0dd42a`: every runtime
  package for the four targets and three platforms was rebuilt, including
  `crossgram-ayugram-runtime-windows-v7.0.9.zip` (sha256
  `cee1d9d136a0d9e983e36f26c302a847f3f4e408d0c259abd1ba2fdd4b14f2f7`, binary
  sha256 `d8c579ac4b724ec9f8950519c2cba879a75c6ea27631d5b41fabc8113566984a`),
  which replaced the client binary used for the reports.
