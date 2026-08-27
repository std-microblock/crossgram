# `messages.sendMedia` legacy video SHA-1 checkpoint incident

Event ID: `2026-08-27T20:43:53Z-messages.sendMedia-video-sha1-checkpoints`

Date: 2026-08-27 UTC (2026-08-28 CST)

Status: implementation and local verification complete; branch pushed; production
deployment and post-deployment verification pending.

## Threshold breach

The hourly reader reported this collector window:

- window: `2026-08-27T20:43:53Z` through `2026-08-27T20:44:22Z`;
- RPC: `messages.sendMedia`;
- samples: 1;
- average / P90 / P99: `828.55 ms / 828.55 ms / 828.55 ms`;
- errors: 1, error rate: 100%;
- reason: `QQNT bridge 500: video upload requires valid cumulative SHA-1 checkpoints`.

This exceeded the general average threshold of 500 ms and was also a correctness
event. It is not an allowed long-running semantic exception.

A second read-only `inspect-relay statistics` snapshot, after the Crossgram
restart at `2026-08-27T20:43:46Z`, covered approximately
`2026-08-27T20:43:53Z` through `2026-08-27T20:57:00Z` and showed that the issue
was sustained rather than a one-sample transient:

- samples: 12;
- average: `780.88 ms`;
- minimum / maximum: `723.32 ms / 930.72 ms`;
- P90 / P99: `930.72 ms / 930.72 ms`;
- errors: 12, error rate: 100%;
- all 12 failures had the same missing-checkpoint reason.

The collector was reset only because the service was restarted for the already
planned statistics-service deployment. Journald supplies the longer incident
history below.

## Production evidence and traffic classification

This was real Telegram Desktop traffic, not a synthetic or debug-scripts probe:

1. Crossgram journald contains 229 matching failures from
   `2026-08-27T16:55:52Z` through `2026-08-27T20:57:17Z`, approximately one
   retry every 65 seconds. The first failure predates both the statistics probe
   load and the `2026-08-27T20:43:46Z` Crossgram restart.
2. QQNT bridge journald contains the same 229 `/v1/uploads/prepare` attempts for
   one 759,580-byte playable video. The basename indicates a PixPin recording
   captured at `2026-08-28 00:55:20` CST; the first request followed at
   `00:55:52` CST. The target conversation and file name were constant across
   the retry series.
3. The active authorization row for the external client address identified the
   client as Telegram Desktop `7.0.9 x64` on Windows 11 (`B660 MB`). No auth key,
   platform-session ID, credential, message content, or raw client address is
   recorded in this document.
4. `debug-scripts` loaded the one-shot statistics reader at
   `2026-08-27T20:44:23Z` and unloaded it at `20:44:24Z`. The reader only called
   the read-only `mtprotoStatistics.read()` service. Failures were already
   continuous for almost four hours, and continued after that probe unloaded.

Monitoring classification: **real client correctness/performance event**. It
must stay in the production RPC population; no probe tag or RPC exemption is
appropriate. A future monitor may group the identical retry reason into one
incident while retaining every call in sample and error-rate calculations.

## Root cause

QQNT requires playable-video upload preparation to receive one cumulative SHA-1
digest for every 1 MiB prefix, with the final partial block represented by the
whole-file digest. Therefore a 759,580-byte video requires exactly one
checkpoint.

Crossgram had two relevant video paths:

- V2/V3 native preflight accepted client-supplied cumulative checkpoints and
  forwarded them correctly.
- Telegram Desktop's normal disk-backed/two-stage fallback later reopened the
  uploaded media in `QQNTClient.sendMessage()`. Its `hashMediaSource()` pass
  calculated MD5, only the final SHA-1, and the first-10-MiB MD5, but no
  cumulative SHA-1 checkpoints. The resulting `/uploads/prepare` request omitted
  `sha1Checkpoints`, so QQNT bridge rejected it before issuing a Highway plan.

The production request size, error, and repeated `/uploads/prepare` log entries
match this exact path. The failure is not caused by QQ latency, a lock, a cache
miss, or the statistics collector.

## Fix

`packages/platform-crossgram/src/client.ts` now:

1. detects playable video before hashing the legacy source;
2. computes cumulative SHA-1 checkpoints at exact 1 MiB boundaries while
   performing the existing single hash stream pass;
3. appends the final whole-file SHA-1 for a partial last block;
4. sends the checkpoints in both `/uploads/prepare` metadata and the final
   message manifest.

The fix does not add or consult a cache, does not buffer a complete video, and
does not add another source read. It derives the required metadata from the
same stream already used for MD5/SHA-1 validation.

## Tests

- `yarn workspace @mtproto-relay/platform-qqnt test`: 205 passed, 21 skipped.
  - Existing direct video transport coverage now requires the one-checkpoint
    value for a sub-1-MiB video.
  - New unit coverage streams a 1-MiB-plus-37-byte video across deliberately
    misaligned chunks and proves both cumulative prefix digests are exact.
- `yarn vitest run --config vitest.mtproto-e2e.config.mts packages/platform-crossgram/src/direct-video-upload.e2e.test.ts --maxWorkers=1`:
  1 passed.
  - The HTTP/Highway E2E verifies the real prepare request and final manifest
    both contain the required video checkpoint.
- `yarn typecheck`: passed.

## Commit, deployment, and regression status

- branch: `fix/rpc-send-media`;
- fix commit: `4e7a5c5` (`qqnt: send cumulative video SHA-1 checkpoints`);
- push: `origin/fix/rpc-send-media` updated successfully;
- production revision: pending;
- post-deployment `messages.sendMedia` result: pending.

Production verification must not mark the event resolved merely because code
was merged. After deployment, observe at least the next client retry or run a
bounded real video send through an approved client, then record:

1. whether `/v1/uploads/prepare` accepts the checkpoint-bearing request;
2. whether `messages.sendMedia` succeeds and the retry series stops;
3. the post-deployment sample count, average, P90, P99, errors, and error rate;
4. the deployed revision and exact verification window.
