# Unread mention ("@") jump latency (2026-09-21)

## Symptom

On the production relay, pressing the desktop "@" button (unread mentions) to
jump to an older message took several seconds, and the whole chat list refresh
felt slow.

## Measured production latencies

| RPC | before | after |
| --- | --- | --- |
| `messages.getUnreadMentions` | 1641-3742ms (4 calls) | see stage numbers below |
| `messages.getHistory` | 208-2570ms, avg 962ms | 100/142/197ms (live client samples) |
| `messages.getDialogs` | 1295-5427ms, avg 2125ms | loadMs 550-700ms |

Process-local probes (removed afterwards) showed the stage split for the
unread-mention window:

| stage | before | after |
| --- | --- | --- |
| upstream `getHistory` (QQNT) | 79-461ms | 58-195ms |
| message-store ingest of ~100 messages | 464-1090ms | 57-96ms |
| projection read + unread list + counts | ~40-60ms | ~40-60ms |
| `messages.getDialogs` page load (2 pages) | ~2.5-3.5s | 520ms |

## Root cause

PostgreSQL returns `jsonb` keys in its own order (length first, then
bytewise). Every change check compared a freshly built payload with a stored
row through `JSON.stringify`, so `{"parts":[{"type":"text","text":"x"}]}`
never matched the stored `{"parts":[{"text":"x","type":"text"}]}`. Re-ingesting
the same upstream page therefore reported **100 of 100 messages as changed**
and rewrote the message row, aliases, media, Telegram projection parts, and
reaction rows on every read.

The same pattern applied to dialog previews (`dialogNeedsPersistence`),
conversations, requests, reactions, and user profiles. Durable rows also
carried store-owned fields the ingestion path never computes (for example
`reactionMaxSelected` from reaction persistence), which made even an
unchanged payload look modified and caused the rewrite to erase that state.

## Fix

`packages/bridge/src/stable-json.ts` adds key-order-insensitive helpers:

- `canonicalJson` / `jsonEquals`: structural equality that ignores JSON key
  order and matches `JSON.stringify` semantics for undefined fields.
- `jsonContains`: the expected payload is a subset of the stored payload, so
  store-owned fields neither trigger a rewrite nor get dropped.

Commits `72bec15` and `4190486` use them for message content/metadata,
conversation metadata, dialog previews, requests, reactions, and user profiles,
merge store-owned metadata on write, and sync reactions independently of the
message payload so a new reaction summary still updates an unchanged message.

## Verification

- 675 bridge unit tests pass; new coverage in `stable-json.test.ts`,
  `message-store.test.ts`, `platform-manager.test.ts`, and the
  `unread-mentions.e2e.test.ts` "@" flow. Each new test fails without the fix.
- Live probes after deployment report `changed: 0` and ~90ms of write work for
  a repeated 100-message page, and dialog pages are no longer re-persisted.
- Deployed to production by fast-forwarding `/opt/crossgram` and restarting
  `crossgram.service`.

## Remaining

- `messages.getDialogs` still spends ~0.6-1.2s because a QQ folder-scoped
  request enumerates the whole dialog list (two upstream pages plus local
  dialog enumeration); the ingest cost is no longer part of it.
- The desktop dialog-loading defect tracked in
  `docs/diagnostics/desktop-dialog-loading.md` (newest-only reply keyboard
  constructors sent to layer-228 clients) is separate and was fixed afterwards;
  a client that fails to decode a response retries, which also looks like slow
  loading.
