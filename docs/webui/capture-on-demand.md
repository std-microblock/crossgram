# On-demand MTProto captures

## Failure and transport contract

The global Cordis entry snapshot previously included every retained decoded
MTProto event and its duplicated search text. Production snapshots reached about
7 MB; a public WebSocket probe opened but received no complete initial frame
before closing with code 1006. The 8 MiB slow-client guard must remain enabled.

Capture history now stays in the debug plugin closure, not in WebUI entry data.
Capturing traffic does not emit entry deltas. Global entries only expose the
capture endpoint, control state and start/pause/clear methods.

The debug page requests at most 100 metadata rows at a time from its configured
same-origin HTTP endpoint. Full payloads and search text are excluded from these
rows. Expanding a row fetches its full event by ID. Browsing older/newer pages
replaces the current page instead of accumulating the entire capture history.
Live mode polls every second while the page is mounted and the tab is visible;
requests have a ten-second timeout, obsolete requests are aborted, stale
responses are ignored, and unmount removes all timers and pending requests.
The client retains at most one page and details belonging to that page.

## HTTP query

- `summary=true&limit=100`: newest metadata page.
- `beforeId=N`: the preceding page, returned in ascending ID order.
- `afterId=N`: the **first** next page, not the tail of a burst.
- `id=N&limit=1`: full event details (or an empty page if evicted).
- Existing payload/time/connection filters run server-side before paging.
- `typeName` and `excludeName` are exact constructor-name filters.
- Responses include `hasOlder`, `hasNewer`, `oldestId`, and `newestId`.
- The default page size is 100; the maximum accepted limit is 500.
- Clearing capture keeps IDs monotonic. Polling removes evicted/cleared rows.

The existing same-origin authentication and no-store response policy are retained.
No new externally exposed endpoint or credential is introduced.

## Cordis reconnect patch

Both the source client and shipped production client invoke
`location.reload()` through a closure rather than passing an unbound native
method to Promise.then. Disconnect also cancels that socket's heartbeat timers.
The production client asset has a new name and manifest version so immutable
caches cannot retain the faulty handler after refreshing the page. Existing
server-side backpressure changes remain part of the WebUI Yarn patch.

## Verification

Run `yarn typecheck:webui`, `yarn vitest run packages/mtproto-debug/src packages/test-suite/src/webui-reconnect.test.ts packages/test-suite/src/webui-backpressure.test.ts`
and `yarn test:e2e:webui`. Install Chromium with
`yarn playwright install chromium` first, or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing test browser.
The dedicated CI WebUI job installs Chromium and runs the same browser tests.

The browser regression seeds more than 8 MiB of server-side capture history,
asserts ordinary pages receive no captures or capture deltas, verifies paged
metadata and expansion-only payload fetches, leaves the page to check cleanup,
and forces a socket disconnect to verify successful reload without page errors.

## Production rollout and test results

Deployed commit 46c4035 on 2026-09-20 at 17:05 UTC (2026-09-21 01:05 CST).
Only Crossgram was restarted. QQNT Bridge stayed running. The workstation built
and tested the client; production only fast-forwarded a verified Git bundle and
unpacked its matching assets. No production install, compilation or test load
was run. The existing untracked service.ts.orig file was preserved.

Rollback revision and assets are retained in
/var/lib/crossgram/backups/20260920T170553Z-webui-on-demand/; the Git rollback ref
is refs/rollback/webui-20260920T170553Z. Baseline: ad2ee1b2. The uploaded assets'
SHA-256 is 78fc1eb2822d323cbb44bca291c6084b05000aa8f47c155f5895a958acf82dbd.
The runtime dependency files match the committed Yarn patches, which preserve
the fixes on subsequent dependency installs.

Verification through the public authenticated HTTPS entry:

- The WebSocket received entry:init and remained connected for 15 seconds:
  42 messages, then a normal client-initiated close (1000), instead of receiving
  no initial frame and closing with 1006 before the fix.
- Chromium loaded the home, plugin manager, and capture pages without page errors.
  The home has no dashboard widgets configured and correctly displays Cordis.
- Ordinary pages made zero capture HTTP requests. Global entry snapshots contain
  no capture chunks/events, even with 1,988 events retained on the server.
- A capture page contained 100 summary rows, 30,426 bytes, and zero payloads.
  Backward paging succeeded; leaving the page stopped capture requests.
- Crossgram is active/running with NRestarts=0; QQNT Bridge remains active.
  There were no error-priority journal entries in the deployment window.

Local targeted verification: 41 unit tests, 15 E2E tests including Chromium,
and the scoped WebUI TypeScript check passed. CI run 35524723233 passed its
WebUI browser/typecheck job, and the affected unit tests passed on Windows and
Linux. The full CI remains red on the same three pre-existing tests as baseline
run 35523187874: RSA public-key export and two bridge schema expectations.
The local whole-repository typecheck is also blocked by unrelated existing
bridge/merged-forward errors; no unrelated working-tree changes were committed.
