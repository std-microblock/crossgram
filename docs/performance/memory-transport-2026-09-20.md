# Fix: lifetime-growing obfuscated receive buffers

## Requirement and acceptance

The target is approximately **30% lower whole-process memory under an equivalent
multi-device workload**, not a smaller isolated cache, fewer devices, a restart
comparison, or a one-off allocator trim. The benchmark gate requires at least 30%
reduction in both median peak RSS and median post-workload RSS over three runs per
variant, with every upload acknowledged, all devices still connected, and no more
than 25% slowdown.

## Root cause

ServerObfuscatedCodec appends decrypted TCP bytes to _decodeBuf and asks the inner
codec to consume frames. It previously never reclaimed the consumed prefix. The
Bytes write cursor and power-of-two capacity therefore grew with **cumulative
traffic over the connection lifetime** even when available was zero. Multiple
uploading devices multiply this retained allocation. Bytes.reclaim() itself has a
second edge case: it does not shrink an oversized buffer once completely drained.

A read-only production probe confirmed consumed bytes still retained behind the
write cursor on live connections. That snapshot had relatively small buffers;
it alone does not explain all idle production RSS. A repeatable real-network
workload established the severity during media transfer: eight devices uploading
32 MiB each left 512 MiB of obfuscation-buffer capacity with no unread bytes.

## Implementation

- Reclaim consumed plaintext before adding another encrypted TCP chunk.
- Reset empty decode buffers after draining a batch; compact incomplete suffixes
  when the inner codec needs more bytes.
- Do not shift the remaining suffix after each individual frame in a coalesced
  batch: this keeps batch decoding linear rather than quadratic.
- Copy a frame only if it aliases the buffer about to be reclaimed; ordinary
  owned frames remain zero-copy at this boundary. Async inner codecs are supported.
- Reuse drained allocations up to 1 MiB, but release larger drained allocations
  back to the initial buffer size. Apply the same policy to the outer TCP buffer.
- Reset releases the obfuscation buffer too. Incomplete packets are preserved;
  the 1 MiB threshold is a retention policy, not a new packet-size limit.

No artificial GC, malloc_trim, heap cap, connection-count reduction, protocol
change, or dropped RPC is used to achieve the savings.

## Whole-application Windows validation

The load generator and server run in separate Node processes. Only the server's
RSS is measured, including its loader workers. Full-application mode loads the
actual MTProto service, bridge, database update store, SQLite, HTTP/WebUI service,
merged-forward, Telegram resources, and the static reference platform. Eight
distinct restored auth keys bind to one account and hydrate dialogs before all
eight upload concurrently through the actual bridge's disk-backed upload handler.
All files live in a disposable directory under work/memory-profile.

Workload: eight devices, 64 parts/device, 512 KiB/part: **512 successful RPCs and
256 MiB uploaded per run**. Connections remain open for the post-workload sample.
The static backend is deterministic; this is not a replay of private QQ data.

Node v24.12.0, Windows workstation, three fresh server processes per variant:

| Metric (median of three runs) | Before | After | Change |
| --- | ---: | ---: | ---: |
| Post-workload process RSS | 596.71 MiB | 333.91 MiB | **44.04% lower** |
| Sampled peak process RSS | 635.77 MiB | 401.34 MiB | **36.87% lower** |
| Upload workload duration | 9.502 s | 8.875 s | 6.60% shorter |
| Drained decode-buffer capacity (all devices) | 512 MiB | 8 MiB | 98.44% lower |
| Successful upload RPCs | 512 | 512 | unchanged |
| Connected devices after workload | 8 | 8 | unchanged |

The before/after snapshots are in memory-transport-2026-09-20.windows.json.
These Windows runs used sampled peak RSS and preceded the separate WebUI asset
build; the WebUI service was loaded, but frontend route registration was not
verified in these measurement runs. Linux CI builds the assets before profiling. The checked-in harness additionally
uses the OS process high-water RSS where available (notably Linux).

This exceeds the requested target in a controlled **whole-application** workload,
not just a cache fixture. It does not establish a fixed percentage for every
production traffic mix; idle production still has allocator retention unrelated
to this buffer bug. The benchmarks did not touch production; the approved rollout is recorded below.

## Reproduction and Linux gate

~~~sh
PROFILE_FULL_APP=1 PROFILE_DEVICES=8 PROFILE_ROUNDS=64 PROFILE_PART_BYTES=524288 \
  node --import tsx --import @cordisjs/unyaml scripts/profile-mtproto-memory.mts
~~~

On PowerShell, set those variables through $env: before invoking Node. Without
PROFILE_FULL_APP=1 the harness runs a smaller protocol-only diagnostic, which the
30% acceptance checker deliberately rejects as whole-application evidence.

The manual memory-profile GitHub workflow uses a disposable Ubuntu checkout. It
runs three baselines with only the two transport implementations restored from
cc4c03a, then restores the candidate implementations and runs three optimized
profiles. All dependencies, benchmark code, account data, workload, and hardware
are shared. Raw JSON and the median comparison are uploaded as an artifact.

scripts/compare-mtproto-memory.mjs rejects incomplete transfers, lost connections,
mismatched workloads, fewer than three repetitions, invalid measurements, a
sub-30% reduction in either memory metric, and excessive slowdown.

## Regression checks

- 191 focused MTProto/comparison unit tests passed locally.
- 39 encrypted socket/PFS/memory E2E tests passed locally.
- New tests cover cumulative traffic for abridged/intermediate/padded transports,
  fragmented suffixes, borrowed-frame ownership, async codecs, coalesced batches,
  large drained allocations, reset, and real multi-device encrypted uploads.
- Clean-worktree typecheck including the harness and bridge declarations reports
  only the two pre-existing inputPeer/inputUser comparisons in dialogs.ts:1683.
- All 32 full bridge login E2Es passed in the clean worktree after building WebUI
  assets. An earlier run without assets could not register three WebUI routes;
  after building, one authentication timeout passed on targeted rerun and the
  complete 32-test suite then passed.
- Linux CI passed all 191 focused unit tests, all 39 encrypted socket tests, and
  the repeated whole-application 30% memory gate on Node v24.14.1.

The source checkout contains unrelated in-progress bridge edits. Those were not
changed or staged; full-app verification used a temporary clean worktree.


## Linux verification matching the production runtime

A fresh read-only probe confirmed production uses Node v24.14.1, with a
1,174,405,120-byte V8 heap limit. CI was pinned to that Node version and used the
same 1 GiB old-space ceiling for **both** variants; the heap setting was not an
optimization difference. WebUI assets were built before the full-app profiles.

Workflow run **35521963812**, source commit **014265c**, completed successfully.
The raw artifact was downloaded, its six profiles inspected, and the comparison
checker rerun locally. Matched workload: eight distinct devices on one account,
512 successful encrypted upload RPCs and 256 MiB transferred per run; all eight
connections remain open for the final sample. Three fresh processes per variant.

| Metric (median of three Linux runs) | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Post-workload process RSS | 760.75 MiB | 448.60 MiB | **41.03%** |
| Peak process RSS (including OS high-water mark) | 887.04 MiB | 449.34 MiB | **49.34%** |
| Workload duration | 8.405 s | 8.152 s | 3.02% faster |

Evidence: memory-transport-2026-09-20.linux.json. An additional Linux run on Node
v24.20.0 also passed (40.81% post-workload and 44.74% peak reductions). The first
Linux attempt hit the previously observed independent-RPC test timeout; bounded
phase diagnostics were added without removing or weakening concurrency assertions.
Both subsequent Linux runs passed the complete 39-test encrypted suite.

### Production rollout — approved and verified

The user approved deployment and one restart. At **2026-09-21 00:27:06 CST**,
production was fast-forwarded from 69d543c4 to **ad2ee1b** and crossgram.service was
restarted once. The exact tested commit was delivered using a locally generated
Git bundle with an expected-base/expected-target check and a clean-checkout guard.
No dependencies, database schema, or systemd configuration changed; no build,
load generation, forced GC, or further malloc trim ran on production.

Rollback reference: refs/rollback/memory-20260921 points to
69d543c4cbd630027f1fa7bae998f671264e0f4d. The uploaded bundle and deployment script
were removed after verification; the rollback ref remains.

Observed recovery and passive validation:

- By the first check, 18 seconds after application startup, all **nine authorized
  transport connections** were back and using the new _finishDecode implementation.
- Four further snapshots over two minutes retained all nine connections, with no
  queued sends or in-flight RPCs at the sampling instants.
- Since restart, **51 RPCs completed with zero errors** by the final snapshot;
  sent traffic rose from 555,900 to 1,093,348 bytes during the observation.
- Every sampled drained obfuscation buffer had written=0, available=0, and a
  16,384-byte allocation. Before deployment the same connection count retained
  consumed write cursors of roughly 111–190 KiB each.
- Crossgram stayed active/running with NRestarts=0; qqnt-bridge stayed active and
  was not restarted. The tracked production checkout is clean at ad2ee1b.
- RSS during the passive observation ranged from about **312 to 342 MiB**; the
  final value was 358,744,064 bytes. These post-restart readings are health data,
  **not** a controlled production percentage comparison. The attributed 41.03%
  reduction remains the matched full-application Linux A/B result above.

Raw rollout evidence: memory-transport-2026-09-21.production.json. The temporary
observer and all its timers were removed; the probe runner subsequently listed
no active probes. The local validation worktree was also removed, and unrelated
in-progress bridge edits remain untouched.
