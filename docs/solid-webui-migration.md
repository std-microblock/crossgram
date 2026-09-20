# Solid WebUI migration

## Scope
Replace the Vue shell and every bundled page with a SolidJS Material You interface. Preserve Cordis scoped entry disposal, Muon delta cursors, RPC methods, backend plugin logic, and SSO protections. Never ship legacy Vue clients in the new shell.

## Delivery stages
1. Standalone cordis-webui-solidjs service, safe manifest assets, bounded transport, Solid client SDK, reconnect and lifecycle tests.
2. Material You shell and accessible Schemastery configuration editor with unit/browser tests.
3. Administration clients: loader, market, logger, notifier, database, HTTP, server, insight, SSO.
4. Crossgram clients: accounts/login/QR, bots, stickers, MTProto statistics and paged capture.
5. Switch configuration/build/dependencies; browser performance and mobile regressions; documentation.

## Constraints
Work directly in this checkout; do not touch unrelated bridge/voice edits. Temporary artifacts belong under work/. Completed stages are committed and pushed separately.

## Verified foundation
The new service is independent of the old WebUI runtime. Metadata-only discovery, reference-counted state subscriptions, compressed Muon cursors, bounded RPC/backpressure, manifest-only asset serving, scoped entry disposal, no-reload reconnect, and the responsive shell are implemented. Seventeen unit/integration/browser checks cover these contracts. The initial production shell is approximately 16.2 KiB gzip JavaScript and 3.3 KiB gzip CSS. Existing production configuration is deliberately unchanged until all page migrations are complete.

Commands: `yarn build:webui`, `yarn typecheck:webui:solid`, `yarn test:webui:solid`. Browser tests use Playwright Chromium, optionally selected by `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

## Configuration and plugin management
The lazy-loaded Solid plugin manager now supports real loader-backed creation, enable/disable, deletion, group organization, service scopes/interception, and config persistence. The Schemastery editor decodes uid/ref graphs without evaluating callbacks; supports primitives, secret/text roles, objects, arrays, dictionaries, tuples, bitsets, unions, intersections and transform input schemas; preserves hidden/unknown values; validates and detects conflicting server edits. Unrecognized custom types retain a JSON editor and server validation.

The phone browser test uses the real Cordis loader and writes an isolated YAML fixture under work/: it checks lazy code loading, validation, secret masking, hidden-value retention, draft stability through Muon updates, persistence, creation, enable and removal. Desktop/mobile screenshots were visually inspected. Thirty focused tests and the package strict typecheck pass. Appearance settings offer device-local light/dark/system modes and three tonal palettes. The existing app remains on the legacy UI pending the remaining page migrations.

## Third-party Solid clients
Independent clients use the exported `buildClient()` helper from `cordis-webui-solidjs/build`. Solid, Solid store/web, the RPC SDK, and the Schemastery editor are externalized and resolved through the shell's build-generated import map. This keeps one runtime/context across separately installed plugins. Register an entry with `client`, `manifest`, `baseUrl`, and `routes`; export a default `{ pages: [{ path, title, icon, component }] }` client module. Components receive `entryId` and `path`, and `useRpc(entryId)` releases its subscription on unmount.

A production browser regression independently builds a fixture extension, checks lazy JavaScript/CSS loading, updates both local Solid signals and backend Muon/RPC state, and verifies page/subscription/stylesheet disposal.
