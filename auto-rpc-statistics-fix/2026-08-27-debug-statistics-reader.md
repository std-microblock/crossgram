# Read-only MTProto statistics probe

Date: 2026-08-27 UTC (2026-08-28 CST)

Status: implementation and local verification complete; production deployment
and live probe verification pending.

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

## Production verification checklist

After deployment:

1. Confirm `crossgram.service` is active and has no restart.
2. Run `probe-relay.mjs doctor`.
3. Run `probe-relay.mjs statistics` and retain only the bounded structured
   output needed for the monitoring record.
4. Confirm the result contains per-RPC `averageMs`, `p90Ms`, `p99Ms`, `errors`,
   and `errorRate`.
5. Confirm the temporary probe is absent from `probe-relay.mjs list`.
6. Record the deployed revision and live verification result in this document.
