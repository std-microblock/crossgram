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
- `crossgram-desktop` release run 242 published `crossgram-242`
  ("Crossgram Desktop #242") from patcher commit `a0dd42a`: every runtime
  package for the four targets and three platforms was rebuilt, including
  `crossgram-ayugram-runtime-windows-v7.0.9.zip` (sha256
  `cee1d9d136a0d9e983e36f26c302a847f3f4e408d0c259abd1ba2fdd4b14f2f7`, binary
  sha256 `d8c579ac4b724ec9f8950519c2cba879a75c6ea27631d5b41fabc8113566984a`),
  which replaced the client binary used for the reports.
