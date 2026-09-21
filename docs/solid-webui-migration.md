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
Independent clients use the exported `buildClient()` helper from `cordis-webui-solidjs/build`. Solid, Solid store/web, the RPC SDK, shared Material You components, and the Schemastery editor are externalized and resolved through the shell's build-generated import map. This keeps one runtime/context across separately installed plugins. Register an entry with `client`, `manifest`, `baseUrl`, and `routes`; export a default `{ pages: [{ path, title, icon, component }] }` client module. Components receive `entryId` and `path`, and `useRpc(entryId)` releases its subscription on unmount.

A production browser regression independently builds a fixture extension, checks lazy JavaScript/CSS loading, updates both local Solid signals and backend Muon/RPC state, and verifies page/subscription/stylesheet disposal.

## Administration migration
Solid implementations now cover database browsing and typed cell updates; paged/filterable logs with pause/resume; safe notifier markup/actions; HTTP and WebSocket composition plus outbound history; incoming requests/routes; bounded deterministic service neighborhoods; marketplace/dependency/version management with confirmations; and SSO registration/login, identities, code/step-up challenges, OAuth return handling, and lazy WebAuthn. All page modules remain lazy and use the common Material You controls.

Server-side rolling histories are bounded even when the legacy instrumentation producer does not enforce its advertised limit. A new backend export, `cordis-webui-solidjs/server`, replaces the old server monitor: it observes early and late routes, records final response status and WebSocket lifetimes, attributes requests to the actual claiming handler rather than an outer SPA fallback, and cleans up listeners on disposal. It still needs to be selected in the final app configuration switch.

Verification: 49 focused tests pass, including phone Chromium workflows against real Cordis database/SQLite, logger, HTTP instrumentation, notifier, service graph, SSO password/code-factor/session/identity services, and real WebSocket echo. Package installation is tested against a controlled implementation of the inspected RPC contract so tests never install/remove real server dependencies. The package build and strict typecheck pass. A repository-wide typecheck was also run: it still reports the pre-existing bridge/projection errors, with no errors in the new package. Representative desktop/mobile screenshots were inspected; scrollable tables and logs keep pagination/actions reachable on phones.

## Cutover
The legacy WebUI is gone: \`@cordisjs/plugin-webui\`, \`@cordisjs/plugin-server-webui\`, \`@cordisjs/client\`, Vue, and the Vue build pipeline are no longer dependencies of any workspace, and no source file imports them. \`app.yml\` and \`deploy/app.production.yml\` select \`cordis-webui-solidjs\` plus \`cordis-webui-solidjs/server\`. The service declares its own \`webui\`/\`webui/connection\` Cordis module augmentation, so it is a drop-in kernel replacement.

Solid clients for the Crossgram plugins live in their owning packages (\`@mtproto-relay/bridge\`, \`@mtproto-relay/mtproto-debug\`, \`@mtproto-relay/mtproto-statistics\`) and declare pages in \`package.json\` under \`cordis.webui\`. \`yarn build:webui\` builds the shared shell plus every package that declares \`cordis.webui.framework: solid\` through the exported \`buildClient()\` helper, producing per-package manifests under \`dist/\`. \`yarn build\` runs the package build and that client build together, which is what \`deploy/update.sh\` invokes before restarting the service.

Configuration expression leaves (\`{ __jsExpr: ... }\`) are preserved verbatim when saving and evaluated only on the trusted server for validation, so deployments like the PostgreSQL password expression keep working. A running page compares its build id with the server's; when they differ it keeps the current page and offers an explicit reload instead of silently discarding unsaved edits. If the bundle is absent the service logs a warning and serves a diagnostic page rather than crash-looping.

## Verification
- \`yarn typecheck:webui:solid\`, \`yarn typecheck\` (only pre-existing bridge/merged-forward WIP errors remain), \`yarn test:unit:node\`, \`yarn build\`, \`yarn test:webui:solid\`.
- 76 Solid tests, including phone-sized Chromium runs against the real Cordis loader, real SQLite, the real capture backend, real collector events, real SSO services, a real generated QR image decoded in a worker, and a real Cordis CLI child process that loads \`cordis-webui-solidjs\` by name and discovers a separately built client manifest.
- \`packages/test-suite/src/production-webui-config.e2e.test.ts\` (loader-driven config editing and persistence) and \`packages/test-suite/src/webui-backpressure.e2e.test.ts\` (real socket overload) run against the new transport. Config-driven e2e suites register tsx through \`vitest.plugins-tsx.mts\`, matching the runtime's \`NODE_OPTIONS\`.
- \`deploy/deploy-files.test.ts\` asserts both application configs reference the Solid UI and no longer reference the old packages.

## Development workflow
\`yarn build:webui\` builds the shell and every Solid client, writing \`dist/\` next to the UI package and each plugin. \`yarn dev\` runs that build before starting Cordis, and \`deploy/update.sh\` runs \`yarn build\` before restarting the service. There is no Vite dev middleware in the server anymore: server-side HMR still refreshes entry manifests through \`hmr/change\`, and client changes require a rebuild plus reload. This keeps the production path identical to the development path instead of maintaining two module graphs.

## Known follow-ups
- \`deploy/app.production.yml\` keeps the previous plugin set; the optional Logs, Notifications, Service map, Plugin library, and account pages are enabled in \`app.yml\` and can be added to production deliberately.
- Repository-wide \`yarn vitest run\` still fails only in \`packages/bridge\` and \`packages/merged-forward\` tests that depend on the in-progress \`conversation-view\`/projection work already present in the checkout; the new package contributes no failures.
