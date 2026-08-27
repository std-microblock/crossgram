# Read-only MTProto statistics probe

Date: 2026-08-27 UTC (2026-08-28 CST)

Status: deployed and live probe verified.

## Motivation

`mtproto-statistics` keeps its collector state in the Crossgram process and
previously exposed it only through the WebUI entry. Hourly automation therefore
had no supported process-local, read-only path for collecting each RPC's count,
average, P90, P99, errors, and error rate. Reconstructing those distributions
from logs would be incomplete, while querying WebUI internals would couple the
monitor to an undocumented transport.

## Implementation

1. `@mtproto-relay/mtproto-statistics` now provides the Cordis service
   `mtprotoStatistics`.
2. `mtprotoStatistics.read()` returns a structured clone containing the current
   snapshot and series. It deliberately excludes the WebUI `reset()` method, so
   a production probe cannot clear or mutate collector state.
3. Optional non-negative limits for second, minute, and hour series make debug
   result size predictable without truncating the per-RPC snapshot.
4. The `inspect-relay` skill now includes the bundled
   `probes/mtproto-statistics.ts` probe and a one-shot command:

   ```sh
   node .agents/skills/inspect-relay/scripts/probe-relay.mjs statistics
   ```

5. The command uploads the probe through `debug-scripts`, waits for its
   structured result, prints the result value directly, and removes the probe.
   It reads the complete collector snapshot plus the latest 300 second points,
   180 minute points, and 48 hour points.
6. Probe unload removes the record from `debug-results/index.json` before
   persisting the final `unloaded` or `expired` status file. `list` therefore
   reflects active runner records instead of accumulating stale probes.

## Safety properties

- The service exposes only `read()`; it does not expose reset or mutation.
- Every returned object is cloned. Mutating probe output cannot mutate live
  collector state.
- Invalid or negative series limits fail explicitly.
- The probe uses the existing transactional, TTL-bounded `debug-scripts`
  runtime and is removed after a successful or failed one-shot command.
- No credential, auth key, token, database connection, or message content is
  read or published.
- No cache was added and no RPC path was changed.

## Tests

- `yarn skill:test`: 9 passed.
  - Includes CLI unit coverage and an E2E test proving the built-in command is
    deployed, its value is unwrapped, and its temporary probe is removed.
- `yarn vitest run --config vitest.mtproto-e2e.config.mts
  packages/mtproto-statistics/src/index.e2e.test.ts
  packages/debug-scripts/src/index.e2e.test.ts --maxWorkers=1`: 4 passed.
  - Verifies live collector values are visible through the service.
  - Verifies returned reports are cloned and reset is unavailable.
  - Executes the actual bundled probe through the real debug-scripts runtime
    against an injected statistics service.
- `yarn vitest run packages/mtproto-statistics/src/collector.test.ts
  packages/mtproto-statistics/src/histogram.test.ts
  packages/mtproto-statistics/src/runtime.test.ts
  packages/debug-scripts/src/index.test.ts --maxWorkers=1`: 12 passed.
- `yarn typecheck`: passed.

## Initial production verification

- Deployed Crossgram revision: `041174d`.
- Deployment used `yarn install --immutable --mode=skip-build`; no build or
  heavy analysis ran on the production server.
- `crossgram.service` became active at 2026-08-27 20:43:46 UTC
  (2026-08-28 04:43:46 CST), with `NRestarts=0` and no error-priority journal
  entries in the deployment window.
- `probe-relay.mjs statistics` returned a 32,315-byte structured result and the
  temporary script reached `unloaded` after collection.
- First post-restart window: 2026-08-27 20:43:53–20:44:22 UTC. It contained 40
  RPCs across 6 methods. Overall avg was 57.06 ms, P90 250 ms, P99 828.55 ms,
  and 7 errors (18%).
- Two events were opened immediately from this short validation window:
  - `messages.search`: 6/6 errors, all
    `QQNT group file listing failed: undefined`; dedicated root-cause/fix agent
    started.
  - `messages.sendMedia`: one 828.55 ms failed request with invalid cumulative
    SHA-1 checkpoints; dedicated agent started to determine whether it was a
    synthetic probe or real client traffic before deciding on a fix/exception.

## Repeatable production verification checklist

After deployment:

1. Confirm `crossgram.service` is active and has no restart.
2. Run `probe-relay.mjs doctor`.
3. Run `probe-relay.mjs statistics` and retain only the bounded structured
   output needed for the monitoring record.
4. Confirm the result contains per-RPC `averageMs`, `p90Ms`, `p99Ms`, `errors`,
   and `errorRate`.
5. Confirm the temporary probe is absent from `probe-relay.mjs list`.
6. Record the deployed revision and live verification result in this document.
