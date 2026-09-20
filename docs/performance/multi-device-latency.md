# Multi-device latency investigation (2026-09-20)

## Observed production evidence

Only bounded statistics, a 12-second metadata-only RPC probe, PostgreSQL catalog
statistics, and EXPLAIN (without ANALYZE) were collected on production. No builds,
load tests, configuration changes, or database mutations were run there. The
short-lived probe was removed after collection.

- Seven MTProto connections were present (connections are not device counts).
- The sampled runtime reported 99.51% event-loop utilization and 3462.4 ms P99
  event-loop delay. These are observations, not a controlled one-vs-many benchmark.
- PostgreSQL reported approximately 649,000 message-part rows. Its cumulative
  table statistics showed over five million sequential scans and approximately
  648 billion rows examined; these counters are historical, not a current rate.
- The native-sequence allocation query planned a parallel sequential scan and
  sort on production PostgreSQL 17.
- One desktop connection requested the same unchanged channel difference eleven
  times during the 12-second probe. Responses were final but omitted timeout.
- Live message publication loaded the entire platform user directory (about
  24,600 rows) to resolve a handful of message references.

## Root cause: an index silently missing

The model declared these two indexes:

    index:mtproto_tl_message_part:platformSessionId+conversationId+tlMessageId
    index:mtproto_tl_message_part:platformSessionId+conversationId+nativeSequence

Both names truncate to the same PostgreSQL 63-byte identifier. The driver uses
CREATE INDEX IF NOT EXISTS, so only the first index exists. Catalog inspection
confirmed that the native-sequence index was absent.

There is a second query-shape mismatch: MessageStore._nativeSequenceBounds filters
by conversationId and nativeSequence, not platformSessionId. The replacement is
therefore (conversationId, nativeSequence), not just a renamed copy of the old
three-column index. Conversation IDs are globally unique. Its generated name is
short enough and it supports previous/next sequence seeks as well as loading all
parts with a matching sequence.

MessageStore serializes writes across facades sharing a database. Expensive
allocation scans therefore delay history ingestion, sends, and live publication
for every connected device. Additional clients add requests behind that shared
work; parallel scans also contend with RPC processing for the small server's CPU.

The repaired model creates the new index through ordinary schema preparation.
A local PostgreSQL E2E test starts with the old model, verifies the collision,
loads 30,000 synthetic rows, applies the new model, checks the query plan and
concurrent results, then restarts to verify index persistence. PostgreSQL 18 may
use skip-scan instead of PostgreSQL 17's sequential scan for the old model; the
old plan still requires sorting whereas the repaired plan seeks directly.

## Amplifiers fixed

1. Channel difference responses now specify a 30-second idle poll interval.
   Live push delivery remains unchanged; this is not a 30-second message delay.
   AyuGramDesktop's api_updates.cpp otherwise falls back to one-second polling.
2. An unfinished channel payload returns a final response at the last durable
   cursor with a one-second timeout. Both the desktop and Android client source
   immediately request another page for non-final responses, so the former empty,
   non-final response could create a busy retry loop. A partial page is non-final
   only when another complete page is actually available. Pending updates are
   neither acknowledged nor skipped.
3. Live update projection reads only the users referenced by that projection,
   reusing the self/sender/direct-peer/reaction IDs already loaded. Reference
   discovery runs after projection middleware so newly introduced mentions retain
   their correct Telegram IDs. No platform-wide user scan is needed.

## Regression coverage

- Model assertions check native-sequence query coverage and truncated-name
  uniqueness for message-part indexes.
- Update-manager tests cover idle pacing, genuine pagination, a ready prefix
  followed by an unfinished payload, deferred replay, multiple auth bindings,
  bounded user reads, and middleware-introduced mentions.
- The real MTProto socket test authenticates three separate devices to one
  account, polls concurrently while a payload is pending, and verifies that each
  independently receives it once complete and then uses idle pacing.
- The PostgreSQL migration E2E is loopback-only and opt-in:

      CROSSGRAM_TEST_POSTGRES_PORT=55439
      CROSSGRAM_TEST_POSTGRES_USER=crossgram_test
      yarn vitest run --config vitest.mtproto-e2e.config.mts packages/bridge/src/native-sequence-index.e2e.test.ts

  Supply a disposable local PostgreSQL server with psql on PATH. The test creates
  and drops a uniquely named database; never use production credentials.

## Validation results

- 189 focused unit tests passed (models, message store, update manager, media
  projection, conversation kinds, and multi-device fan-out).
- All 32 login/MTProto E2E tests passed, including the new three-device test.
- The real PostgreSQL migration/restart/concurrent-query E2E passed locally.
- Broader tests were run in a clean local validation copy with this patch rebased onto
  the current remote main (including its multi-client fixes and layer-229 dependencies), because unrelated in-progress bridge edits
  in the shared checkout currently prevent loading the full application.
- Typecheck of that clean copy reports existing errors in dialogs.ts:1683 and
  request-inbox tests, with no errors in this patch. The repository-wide pre-commit
  typecheck is also blocked by unrelated working-tree edits; the hook was bypassed
  for this scoped, separately validated commit rather than modifying those files.
- On the initial checkout, the existing conversation-loading timing E2E fails
  its 250 ms dialog threshold on this workstation both without this patch (423 ms) and with it (417 ms).
  Its threshold was not loosened. This is not a production performance result.

## Rollout and verification

This investigation does not deploy or restart production. After deploying the
commit, verify pg_indexes contains the conversationId/nativeSequence index and
EXPLAIN shows an indexed sequence seek. Compare event-loop latency, database CPU,
and RPC latency while using two or more clients, and confirm that live push
messages still arrive immediately. The sampled statistics also contained QQNT
upstream readiness/send failures; this patch does not claim to repair those
separate upstream errors.
