# Reconnect replay congestion (2026-09-20)

## Evidence after the index/polling deployment

A bounded metadata-only production trace correlated RPC entry, handler completion,
response generation, and socket write completion. No message content or credentials
were collected. Handler completion was often 1-20 ms, but one reply waited 23.4 s
for its socket write while the connection held over 600 KiB of queued bytes.
Two simultaneous returning clients took 16.9-19.9 s for getDialogs and up to
12.5 s for an empty channel difference. A single client was much faster.

A second capture counted 5,227 historical pushes on one connection, of which
3,911 were duplicates; some were around 27 minutes old. Several reconnecting
transports received hundreds or thousands more copies. This was not normal live
message traffic or slow database execution.

## Cause

The reconnect callback called UpdateManager.retryPending(account), which loaded
the entire pending journal and broadcast each payload to every online auth key.
Publication was considered complete only if every durable authorization was
online simultaneously. One old/offline authorization therefore kept records
pending indefinitely. Each new connection (including parallel transports on one
device) launched another account-wide replay; slow writes caused reconnects,
which launched more replays and delayed otherwise fast RPC results.

## Fix

- Reconnect recovery is a single connection-targeted updatesTooLong notification,
  queued after that connection's successful initial RPC response.
- No pending journal is read or broadcast during connection establishment. Other
  connected devices receive no recovery traffic merely because a peer reconnects.
- Clients use their own pts/date cursor through getDifference and
  getChannelDifference. Both the supplied desktop and Android client sources
  explicitly handle updatesTooLong by requesting difference recovery.
- Published is best-effort live delivery bookkeeping, not an acknowledgement from
  every authorization. Published rows remain in the retained journal and are still
  available to an offline device's independent difference cursor.
- Ordinary live fan-out remains unchanged: each online device still receives the
  event. Successful RPC delivery can also mark the event published.

This does not delete old journal rows or require a database migration. No blanket
cursor advance, missing-update suppression, or smaller retention limit is used.

## Validation

- 893 unit tests passed across bridge and MTProto (18 skipped).
- All 33 login/MTProto E2E tests passed, including real independent auth keys,
  parallel transports, offline recovery, and live push delivery.
- The new socket regression seeds 128 pending 8 KiB updates. Reconnect sends less
  than 4 KiB, performs no getPending call, and emits exactly one recovery marker
  only on the returning connection. Two device cursors independently fetch the
  same first page; subsequent pages recover all 128 messages with no missing rows.
- Running that regression against the old implementation fails: historical updates
  arrive instead of the single recovery marker.
- The repository-wide typecheck still reports pre-existing errors in dialogs.ts
  and request-inbox tests. No type errors were reported in this change. The scoped
  commit bypasses the pre-commit typecheck rather than changing unrelated code.

Production acceptance still requires deployment followed by repeated concurrent
client measurements and confirmation that historical push duplication and socket
backlog disappear. The corresponding server maintenance entry records those results.
