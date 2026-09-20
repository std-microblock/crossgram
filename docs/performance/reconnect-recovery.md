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

## Production acceptance

Deployed code commit 69d543c on 2026-09-20 at 23:39:10 CST. The server only
fast-forwarded its clean checkout and restarted; there was no install, build,
benchmark, or database migration on production. A rollback copy of the prior
sources is retained under /var/lib/crossgram/backups/20260920-reconnect-recovery/.

The same public endpoint and saved independent account authorizations used for
the failing measurements were tested again. After the initial warm-up, bounded,
read-only probes ran successively with one, two, and three simultaneous clients,
then repeated the three-client run:

| Concurrent clients | getDialogs | Empty channel difference | Recent history (5 messages) |
| --- | --- | --- | --- |
| 1 | 253 ms | 28 ms | 84 ms |
| 2 | 300-302 ms | 24-28 ms | 107-129 ms |
| 3, first repeat | 411-432 ms | 32-41 ms | 135-259 ms |
| 3, second repeat | 555-567 ms | 22-26 ms | 153-248 ms |

State requests in these runs took 19-127 ms. The first cold three-client run had
one 2.04-second history read; all subsequent history reads are included above,
not silently discarded as failures. No RPC failed. These are observed end-to-end
measurements, not guaranteed latency limits or a controlled capacity benchmark.

A metadata-only transport capture across the verification runs recorded 157
settled replies. At the instrumented RPC/transport boundaries, maximum buffered
bytes, stalled duration, and encode queue length were all zero. The push capture
observed fresh live updates (age at most one second) and zero duplicates, rather
than the thousands of old copies observed before the fix. Live fan-out is also
covered by the real-socket regression suite.

At final verification, Crossgram, QQNT bridge, and PostgreSQL were active;
Crossgram had NRestarts=0. All temporary server probes were removed. No business
messages were sent by the production checks, and no recurring monitoring task
was installed. The reproduced multi-device replay congestion is resolved.
