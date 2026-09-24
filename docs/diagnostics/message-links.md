# Message links copied from a chat did not open (2026-09-24)

## Symptom

A message link copied in a client, for example
`https://my.telegram.org/c/1681055558/1079187031`, "does not load": the click
leaves the client for a browser, where the URL means nothing (and from mainland
networks the host is not even reachable), instead of opening the message the
link points at.

## Root cause

`help.getConfig` advertised `me_url_prefix: https://my.telegram.org/`. That
value only decides how a client *writes* a link; whether a link is resolved
inside the client is decided by the internal-link grammar each client
hard-codes:

- Telegram Desktop builds links from `ConfigFields::internalLinksDomain`
  (`Session::createInternalLinkFull` → `ValidatedInternalLinksDomain`, which
  only checks for an `http(s)://` prefix and a trailing slash) and appends
  `c/<channel>/<post>` for a message in a private channel, but
  `Core::TryConvertUrlToLocal` converts only `t.me`, `telegram.me` and
  `telegram.dog` URLs (with optional `www.` and subdomain forms) back into
  `tg://privatepost?channel=…&post=…`.
- Telegram Android builds the same URL from `MessagesController.linkPrefix`
  (the same config field with the scheme stripped) and only treats
  `telegram.dog`, `telegram.me` and `t.me` hosts as internal in
  `Browser.isInternalUri`; every other host goes to the browser.

So each "copy link" URL the advertised prefix produced was guaranteed to leave
the client, while the rest of the relay had always hard-coded `t.me` for the
links it writes into message text (`packages/merged-forward/src/index.ts`,
`packages/bridge/client/bridge-model.ts`), and those resolve today.

The resolution itself was never broken: production answered
`channels.getChannels` with a zero access hash and `channels.getMessages` for
the linked post before the fix, so the advertised host was the only defect.

## Fix

`crossgram@0bc2498` — `packages/bridge/src/synthetic.ts` exports
`meUrlPrefix = 'https://t.me/'` and `makeConfig` advertises it, with the
constraint recorded next to the value.

## Verification

- `packages/bridge/src/synthetic.test.ts` pins the advertised prefix to the
  hosts the clients accept (`t.me`, `telegram.me`, `telegram.dog`) and to the
  trailing slash Telegram Desktop requires.
- `packages/test-suite/src/message-links.e2e.test.ts` boots the full stack
  (db + server + mtproto + bridge + static platform), logs an mtcute client in
  over a real socket, builds the copy link from the advertised prefix, resolves
  it with `client.getMessageByLink` and asserts the message and its chat come
  back. Each step is bounded so a stall names itself instead of only showing up
  as the test timeout.
- `packages/test-suite/src/login.e2e.test.ts` (37 tests) still passes after its
  harness moved to `packages/test-suite/src/harness.ts`; `packages/bridge/src`
  unit tests are 715 passed / 18 skipped.
- Production (`/opt/crossgram` fast-forwarded `0a7fc43` → `0bc2498` at
  18:16 CST, `crossgram.service` restarted, `NRestarts=0`, MTProto `41003` and
  WebUI `3140` listening, no error journal in the window): the probe
  `work/mtproto-e2e/message-link.ts` read `meUrlPrefix:
  "https://my.telegram.org/"` and `https://my.telegram.org/c/315066250/1188123943`
  before the update; after it the same probe reads `meUrlPrefix:
  "https://t.me/"`, builds `https://t.me/c/371852035/1117603735` and resolves it
  to message `1117603735` in channel `371852035` (`resolvedSameChat: true`).

## Remaining

- Links already copied with the old prefix
  (`my.telegram.org/c/<channel>/<post>`) stay dead, because the clients decide
  by host before any RPC; only a client-side patch could honour them. Copying the
  link again yields the working `t.me` shape.
- Clients adopt the new prefix when they next refresh `help.getConfig`
  (`expires` is one hour) or restart.
