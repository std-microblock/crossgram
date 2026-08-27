# `messages.search` / QQ group-file listing event

Event ID: `2026-08-27T20:43:53Z-messages.search-group-files`

Date: 2026-08-27 UTC (2026-08-28 CST)

Status: root cause fixed, released, and installed as `qqnt-bridge v1.0.31`.
Post-deployment metric verification is blocked on a required QQ QR login after
both retained login snapshots were rejected. The event is **not resolved**
until QQNT is ready and a fresh production window passes.

## Detection and impact

The first monitoring window was `2026-08-27T20:43:53Z` through
`2026-08-27T20:44:22Z`:

| RPC | Count | Errors | Error rate | Avg | P90 | P99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `messages.search` | 6 | 6 | 100% | 7.83 ms | 13.06 ms | 13.06 ms |

The latency percentiles were below the performance thresholds, but the 100%
error rate was an explicit correctness event. Every failure had the same error:

```text
QQNT bridge 500: QQNT group file listing failed: undefined
```

A later read-only `mtprotoStatistics` probe covered
`2026-08-27T20:43:53.374Z` through `2026-08-27T20:59:28.188Z` and proved that
the issue persisted:

| RPC | Count | Errors | Error rate | Avg | P90 | P99 | Last seen |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `messages.search` | 150 | 150 | 100% | 11.26 ms | 30.23 ms | 30.23 ms | `2026-08-27T20:59:20.644Z` |

The collector retained exactly one failure reason for all 150 calls. This is
not a low-sample or transient spike and no reasonable-long-running exception
applies.

## Production evidence

Only metadata needed for this incident was retained; peer identifiers and
message content are intentionally omitted.

For the bounded journal window `2026-08-27T20:42:00Z` through
`2026-08-27T20:46:00Z`:

- Crossgram emitted 40 matching `messages.search` RPC errors.
- QQNT bridge completed the corresponding 40 `group-files` HTTP requests with
  status 500.
- Those HTTP failures took 0–1 ms (average 0.725 ms), showing that the bridge
  rejected the request before waiting for QQNT's asynchronous result.
- QQNT still emitted 40 `onGroupFileInfoUpdate` callbacks in the same window.
  The callback objects contained the expected result fields (`retCode`,
  `retMsg`, `clientWording`, `item`, `allFileCount`, `nextIndex`, and `reqId`).

The local QQNT API declaration was used only as a reference and was not copied
into committed source. It declares `getGroupFileList(...)` as returning a
number, not a promise of `{ result, errMsg }`. NapCat's client implementation
also treats the method as a dispatch call and waits for
`onGroupFileInfoUpdate` as the authoritative response.

## Root cause

`qqnt-bridge` had an incorrect handwritten type and wait chain:

1. `KernelRichMediaService.getGroupFileList` was declared as returning
   `Promise<{ result, errMsg, ... }>`.
2. `QQKernelBridge.getGroupFiles` awaited the call and then read
   `accepted.result`.
3. The real QQNT method synchronously returns a numeric dispatch token.
   Reading `.result` from that number produced `undefined`.
4. `undefined !== 0`, so the bridge immediately threw
   `QQNT group file listing failed: undefined` and cleared the pending request.
5. The valid QQNT callback arrived just afterwards, but there was no pending
   request left to resolve.

This explains both the 0–1 ms HTTP failures and the one-for-one valid native
callbacks. The problem was an incorrect response/lifecycle chain, not QQ
latency or missing group-file data.

## Fix

Repository: `qqnt-bridge`

Branch: `fix/rpc-messages-search`

Commit: `649f2d6 group-files: await native list callback`

Release commit: `12f1e4d release: bump version to 1.0.31`

Tag: `v1.0.31`

The fix:

- corrects the handwritten `getGroupFileList` return type to `number`;
- treats that number only as the synchronous dispatch token;
- keeps the pending query alive until `onGroupFileInfoUpdate` arrives;
- continues to use callback `retCode` and wording as the authoritative success
  or failure result;
- adds no cache, retry, timeout extension, or error suppression.

## Tests

The regression coverage includes:

1. a unit test where QQNT returns a positive numeric token and asynchronously
   sends a successful callback;
2. a unit test proving a callback error is still surfaced using its real
   wording rather than interpreting the numeric token as a status;
3. an HTTP E2E test proving `/group-files` remains open until the delayed
   native callback and then returns status 200.

Results on the maintenance workstation:

- targeted regression run: 3 passed, 210 skipped;
- `pnpm exec tsc --noEmit`: passed;
- native packet addon build: passed;
- full `pnpm exec vitest run`: 299 passed, 29 skipped.

An initial full test run before building the native addon had five unrelated
missing-artifact failures. After the documented local native build, the full
suite passed. No build or heavy analysis ran on the production server.

## Release and production deployment

GitHub Actions run `33116520537` completed successfully:

- Linux tests: passed;
- Windows tests: passed;
- Linux package: passed;
- Windows package: passed;
- release publication: passed.

The standard maintenance workstation command deployed the Actions-built
`v1.0.31` Linux release. The production server did not compile or test the
package.

During the controlled restart, QQ rejected both the preserved pre-update login
state and the installer's rollback snapshot. This is a known upstream QQ login
behavior that has also occurred during earlier bridge updates. The installer
left the new bridge running rather than silently claiming success:

- `qqnt-bridge.service`: active/running;
- systemd restart count: 0;
- protocol version: 31;
- QQNT kernel: not ready;
- login phase: waiting for QR scan.

A fresh QR was rendered to a local untracked maintenance file for the operator
and the remote temporary PNG was removed. No QR URL or login material was
written to this document or committed.

While QQNT is not ready, the production statistics window beginning
`2026-08-27T21:14:04Z` showed `messages.search` at 130/130 errors. Those new
errors are `503 kernel not ready`, not the original
`group file listing failed: undefined` failure. They cannot validate or refute
the code fix until the same QQ account is restored.

## Deployment and verification checklist

The fix cannot be called resolved until QQNT finishes the required QR login and
a post-login production window is collected.

After deployment:

1. confirm `qqnt-bridge.service` and `crossgram.service` are active with no
   restart increase;
2. issue a bounded group-file search probe without logging peer identifiers or
   file names;
3. confirm the bridge request waits for `onGroupFileInfoUpdate` and returns
   HTTP 200 (or a real callback error, if QQ rejects the request);
4. read the next production statistics window and record `messages.search`
   count, errors, error rate, avg, P90, and P99;
5. require the old `group file listing failed: undefined` reason to stop
   increasing;
6. only mark this event resolved after a fresh window has zero occurrences of
   that reason and the RPC remains within the latency thresholds.
