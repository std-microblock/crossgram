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
