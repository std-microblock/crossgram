---
name: cordis
description: Authoring plugins, services, and apps with cordis — the dependency-injection plugin framework (used by koishi). Use when writing/refactoring cordis plugins or services, wrapping an external library (koa, node http/ws, a DB pool, MQTT, etc.) as a cordis Service, setting up the loader/config-driven plugins, implementing HMR, or extending koishi. Triggers on: cordis, ctx.plugin, Service, @Inject, ctx.provide, ctx.isolate, ctx.effect, ctx.on/emit/serial/bail/waterfall, @cordisjs/plugin-loader, @cordisjs/plugin-hmr, @cordisjs/plugin-server, fiber, effect scope, koa wrapper, server service.
---

# cordis

A lightweight, **effect-based** dependency-injection framework for Node.js. Plugins
declare what they *need* (`inject`), cordis resolves dependencies and tears
everything down automatically when a dependency goes away. **koishi** is the
reference application that builds a whole bot framework on top of it.

Repo layout (monorepo, npm scope `@cordisjs`):
- `packages/core` — the framework (`cordis` on npm).
- `packages/loader` — `@cordisjs/plugin-loader`, config-driven plugin loading.
- `packages/hmr` — `@cordisjs/plugin-hmr`, hot-module-reload.
- `packages/include` — `@cordisjs/plugin-include`, watch & apply config files.
- `packages/timer`, `packages/group`, `packages/logger-console`, `packages/utils`, `packages/create`.

The public API is almost entirely on `Context` (via `ctx.*`). A `Context` is a
`Proxy`, so reading an unknown property (`ctx.foo`) triggers the inject/proxy
machinery — this is the heart of the design.

---

## Mental model (read this first)

1. **`Context` is a tree.** `new Context()` is the root. `ctx.extend(meta)`,
   `ctx.isolate()`, `ctx.intercept()` create **child contexts** that shadow fields
   but share the parent. Every plugin runs in its own fiber/context.
2. **Plugins are inert until their dependencies are active.** A plugin that
   `inject`s `['db']` will not run its body until something provides `db` and
   that provider's fiber becomes ACTIVE. If `db` is later disposed, every
   dependent fiber is automatically reloaded/unloaded. This is the whole value
   proposition — no manual wiring, automatic lifecycle.
3. **Everything is an effect.** A plugin's body returns an *effect*: a cleanup
   function, an iterable of them, a `Promise`/async-iterable of one. While the
   plugin is active, cordis tracks those disposers; on teardown it runs them.
   `ctx.on`, `ctx.provide`, `ctx.set`, `ctx.effect`, timers, etc. all register
   effects — they auto-dispose when the fiber dies.
4. **Services are injected properties.** A "service" is just a context property
   (`ctx.foo`) gated behind a provider. Accessing `ctx.foo` before it's
   provided throws (or is suspended, in the case of `inject`).

---

## Quick start

```ts
import { Context } from 'cordis'

const root = new Context()

// A plugin is a plain function (also: class constructor, or { apply } object)
root.plugin((ctx) => {
  ctx.on('ready', () => {
    ctx.logger.info('hello from plugin')
  })
  // returning a function = cleanup effect
  return () => ctx.logger.info('plugin disposed')
})

root.emit('ready')
```

`ctx.plugin(plugin, config?)` returns a **thenable Fiber wrapper** — you can
`await` it (`await root.plugin(...)`) and call `.dispose()` on it.

---

## Plugins

Three equivalent shapes (resolution in `registry.resolve`):

```ts
// 1. Function (most common, e.g. koishi plugins)
export function apply(ctx: Context, config: Config) { /* ... */ }
root.plugin(apply, config)

// 2. Class constructor — constructor body runs as the effect;
//    returned value / [Service.init] handled by fiber runner.
class MyPlugin {
  constructor(ctx: Context, config: Config) {}
}
root.plugin(MyPlugin, config)

// 3. Object with apply()
const plugin = { name: 'my', Config, inject: ['db'], apply(ctx, config) {} }
root.plugin(plugin)
```

### Plugin metadata
- `plugin.Config` — a **Standard Schema** (`@standard-schema/spec`). Config is
  **validated** before the fiber runs (`resolveConfig`); validation errors throw
  `ValidationError`. koishi uses `schemastery`/`@satorijs/core` `Schema` which
  implements this. Use it for loader config + `--help`/introspection.
- `plugin.name` — shown in logs / used as entry id (defaults to function name;
  `"apply"` is skipped).
- `plugin.inject` — array of service names (or `{ name: config }`) the plugin
  needs before it can run.
- `plugin.provide` — service name(s) the plugin provides.

### Dependency injection

```ts
// runtime-style: pass config that is merged into the service via intercept
root.plugin(somePlugin, { /* plugin config */ })

// declare deps inline
root.inject(['db', 'http'], (ctx) => {
  // body only runs once ctx.db AND ctx.http are active
  ctx.db.find(/* ... */)
})

// class-based injection (decorator + static)
import { Context, Inject, Service } from 'cordis'

@Inject('counter')
class Foo extends Service {
  constructor(ctx: Context) {
    super(ctx, 'foo')
  }
  get value() { return this.ctx.counter.value }
}
```
`@Inject(name, config?)` works on classes and class methods (method form wraps
the method in `ctx.inject` with a `this` bound to a sub-context). `plugin.inject`
and the `@Inject` static form are **merged** recursively across the prototype
chain (`Inject.resolve`).

A plugin injected with a *config* value marks that service as needed AND seeds
its `intercept` config (`fiber.ts`: injected configs are written into
`ctx[Context.intercept]`).

---

## Services

```ts
class Counter extends Service {
  public value = 0
  constructor(ctx: Context) {
    super(ctx, 'counter')   // name = 'counter' -> ctx.counter
  }
  increase() { this.value++ }
  [Service.init]() { /* optional async setup; blocks dependents */ }
  [Service.check]() { return this.value >= 0 } // gate active state
}
```

Service lifecycle symbols (all on `Service`, e.g. `Service.init`):
- `[Service.init]` — async generator or function. If present, dependents wait
  until it resolves before running. Return a dispose function / yield disposers.
- `[Service.check]` — must return truthy for the service's fiber to count as
  ACTIVE. If it returns false, dependents are suspended.
- `static config` / `Service.resolveConfig` — config is pulled from
  `ctx[Context.intercept][name]`, merged parent→child (deep via `Config.merge`
  if available, else `Object.assign`). Pass config with `ctx.intercept(name, c)`
  or `plugin.inject = { name: c }`.
- `[Service.invoke]` — if defined, the service instance becomes **callable**
  (`ctx.db(...)`). Used by `logger` so `ctx.logger('name')` returns a `Logger`.

### Registering context properties

```ts
// Provide a service/property (value optional). Throws if re-declared as a
// different kind (service vs accessor). Returns a dispose fn.
root.provide('counter')                 // declare, set later
root.set('counter', new Counter(root))  // set value
root.get('counter')                     // read (strict: only if active)

// Custom getter/setter without a Service subclass
root.accessor('now', {
  get(receiver, error) { return Date.now() },
  set(value, receiver, error) { /* return true on success */ },
})

// Expose a service's methods directly on ctx
root.mixin('timer', ['timeout', 'interval', 'debounce'])  // ctx.timeout(...)
```
`reflect.provide` / `reflect.set` / `reflect.get` are the lower-level,
non-effect versions (used inside `Service` constructor). `provide` registers an
**effect** so reverting it on teardown also reverts the service.

`ctx.set` requires the property to already be `provide`d in the same fiber;
setting an undeclared property throws `"cannot set property without provide"`.

---

## Context scoping — `extend` / `isolate` / `intercept`

These create child contexts that inherit everything but override specific bits.
This is how koishi does per-guild config and per-context filters.

```ts
// extend: generic shadowed child context
const child = ctx.extend({ /* own fields */ })

// isolate: the named service gets a SEPARATE instance in this branch.
// Dependents in this branch see this branch's instance, not the parent's.
const scoped = ctx.isolate('counter', Symbol('label') /* optional */)
// label ties multiple entries to the SAME isolated instance (global realm)

// intercept: seed/override a service's config in this branch
const configured = ctx.intercept('http', { timeout: 5000 })
```
`isolated`/`intercept` maps are **prototype-chained** from the parent, so a
branch only needs to declare the names it changes. The loader turns the
`isolated`/`intercept` entry options into these calls automatically.

---

## Events

Event names are arbitrary strings. Listeners are either **global** (fire on
every context) or **filtered** (only fire when the dispatching context passes
the listener's `ctx.filter`). `thisArg` form lets you dispatch against a
specific context's filter.

```ts
ctx.on('message',   (session) => {})          // sync listener
ctx.once('ready',   () => {})                 // auto-remove after first fire
ctx.emit('message', session)                   // sync dispatch, ignores return
await ctx.parallel('message', session)         // all run; Promise.allSettled
await ctx.serial('message', session)           // sequential; stops on truthy
ctx.bail('before-send', data)                 // first truthy return wins
ctx.waterfall('transform', value)              // each gets previous result
```
- `ctx.on(name, listener, options?)` — `options`: `{ prepend?: boolean,
  global?: boolean }` (or `true`/`false` shorthand for prepend).
- **Dispatch modes**: `emit` (sync, fire-and-forget), `parallel` (async,
  all), `serial` (async, bail on first truthy), `bail` (sync, first truthy),
  `waterfall` (sync, chain the value). See `DispatchMode` in `events.ts`.
- Listeners are **traceable** (`reflect.bind`): `this` / arguments are rebound
  to the dispatching context so `this.ctx`, `this.logger` resolve correctly
  inside a listener.
- `internal/*` events are framework hooks (`internal/plugin`, `internal/update`,
  `internal/service`, `internal/listener`, `internal/dispatch`,
  `internal/status`). Listen on them to observe lifecycle but don't name
  user events with the `internal/` prefix (they're skipped from dispatch logs).

---

## Wrapping external libraries (the koa/server pattern)

This is the single most useful cordis idiom: take an **external, event-emitting
resource** (koa, node `http`, a DB pool, a websocket, an MQTT client…) and
make it a first-class, lifecycle-managed, scope-aware cordis Service. The
reference implementation is `@cordisjs/plugin-server` (koishi's "koa wrapper" —
it actually wraps Node's `http` + `ws`, not koa). Study it; the shape
generalizes to any external lib.

### The five moves

**1. Subclass `Service` so the resource becomes `ctx.<name>`.**
```ts
class Server extends Service<Server.Intercept> {
  constructor(ctx: Context, config: Server.Config) {
    super(ctx, 'server')          // -> ctx.server
    this._http = http.createServer()   // hold the lib instance privately
  }
}
```

**2. Bridge the external lib's events into cordis events.** Attach
listeners inside the constructor (it runs inside an active fiber). Pipe them
through `ctx.waterfall/emit/parallel` with a `thisArg` so listeners filter
correctly:
```ts
this._http.on('request', async (_req, _res) => {
  const req = new Request(_req)        // wrap native objects (see move 5)
  const res = new Response(_res)
  await this.ctx.waterfall(this, 'server/request', req, res, async () => {})
})
```
Declare these events on the `Context`/`Events` interfaces so TS knows them:
```ts
declare module 'cordis' {
  interface Events {
    'server/request'(this: Server, req: Request, res: Response, next: () => Promise<void>): Promise<void>
  }
}
```

**3. Expose an API whose every call registers an *effect*.** Routes close
over the service and push into a `DisposableList`; the `ctx.effect` cleanup
auto-removes them when the calling plugin/fiber is disposed:
```ts
class HttpRoute extends Route {
  dispose: () => void
  constructor(server: Server, method: string, path: string | RegExp, cb: Middleware) {
    super(server, method, path, {})
    const self = this
    this.dispose = server.ctx.effect(function* () {
      yield server.httpRoutes.push(self)          // registered
    }, `ctx.server.${method}(${JSON.stringify(path)})`)
    // when the fiber dies, the DisposableList entry is auto-removed
  }
}
// and the Service method:
get(path, middleware, options?) { return new HttpRoute(this, 'get', path, middleware) }
```
So `ctx.server.get('/x', ...)` inside a plugin auto-unregisters when that
plugin unloads — even during HMR. Same for `use`, `ws`, middleware chains.

**4. Manage the resource's lifecycle in `[Service.init]`.** Because `init`
is async, dependents wait until the server is actually listening; the
`yield`ed disposers run on teardown:
```ts
async* [Service.init]() {
  this.port = await listen(this._http, this.config)
  yield () => new Promise<void>((resolve) =>
    this._http.close(() => resolve()))   // auto-close on dispose
  yield () => this.ctx.logger.info('server closing')
}
```

**5. Make wrapped native objects *traceable* with `Service.tracker`.**
When you pass a `Request`/`Response` into a cordis listener, you want
`this.ctx`, `ctx.logger`, etc. inside that listener to resolve against the
request's context. Tag the wrapper with a tracker:
```ts
class Request {
  constructor(public _req: IncomingMessage) {
    defineProperty(this, Service.tracker, { associate: 'server.request' })
    // ...
  }
}
```
`associate` lets listeners read `ctx['server.request.<prop>']` scoped to that
object. (This is the same mechanism `logger` uses via `noShadow`.)

### Putting it together (annotated, trimmed from `@cordisjs/plugin-server`)

```ts
export class Server extends Service<Server.Intercept> {
  public _http: http.Server
  public httpRoutes = new DisposableList<HttpRoute>()

  constructor(ctx: Context, config: Server.Config) {
    super(ctx, 'server')
    this._http = http.createServer()
    this._http.on('request', async (_req, _res) => {
      const req = new Request(_req)
      const res = new Response(_res)
      try {
        await ctx.waterfall(this, 'server/request', req, res, async () => {})
      } catch (e) { /* map ValidationError -> 422, else 500 */ }
      res._end()
    })
    ctx.on('server/request', async (req, res, next) => {
      // run matching HttpRoutes as a waterfall (route chaining)
      const response = await runRoute(0)
      if (response && !res.claimed) { res.body = response.body; res.status = response.status }
    })
  }

  async* [Service.init]() { /* listen() + yield close */ }

  // intercept config: path prefix + per-route overrides
  get baseUrl() { const intercept = this[Service.resolveConfig](); /* ... */ }

  use(mw) { return this.ctx.on('server/request', mw, { prepend: true }) }
  get(path, mw, opts?) { return new HttpRoute(this, 'get', path, mw) }
  ws(path, handle?, opts?) { return new WsRoute(this, path, handle) }
}
```

### Why this pattern is the point of cordis
Once the external lib is a Service, **everything cordis gives you applies for
free**: dependency ordering (plugins that `inject: ['server']` wait for the
port to be bound), automatic teardown (routes/listeners/server all dispose with
their owner fiber), HMR (re-importing a plugin re-registers its routes), and
scoping (`ctx.isolate('server')` / `ctx.intercept('server', { path: '/v2' })`
give a plugin group its own prefixed server without a second socket). You never
write `server.close()` by hand in user code.

### Checklist for wrapping any external lib
- [ ] `class X extends Service` → `ctx.x` holds the lib handle.
- [ ] Constructor attaches the lib's native listeners and re-dispatches them
      as cordis events (`ctx.emit/waterfall` with a `thisArg`).
- [ ] User-facing methods (`get`, `use`, `on`, `subscribe`…) wrap their
      registration in `ctx.effect` so they auto-dispose.
- [ ] Long-lived resources (listen, connect, open) live in `[Service.init]`
      with `yield`ed cleanup.
- [ ] Wrapped native objects get `Service.tracker` so they're traceable in
      listeners.
- [ ] Config + per-caller overrides come through `intercept`/`resolveConfig`.

---

## Effect lifecycle & Fiber states

A **Fiber** wraps one plugin instance + its `runtime`. States
(`FiberState`): `PENDING → LOADING → ACTIVE → (DISPOSED | FAILED | UNLOADING)`.

- A fiber stays **PENDING** until all injected services are ACTIVE.
- When deps flip active → `_reload()` runs the plugin body (capturing effects);
  deps go away → `_unload()` runs all captured disposers.
- `fiber.update(config, noSave?)` re-runs the plugin with new (validated)
  config. `fiber.dispose()` tears it down. `await fiber` waits for inertia.
- `ctx.effect(execute, label?)` — register a raw effect in the current fiber;
  returns a dispose fn (also `.then`-able). Used internally by `on`, `provide`,
  `set`, timers.
- Effects may be: a `() => void` disposer, an `Iterable` of disposers,
  a `Promise<disposer>`, or an `AsyncIterable` (async effects that can be
  cancelled mid-flight — used by `ctx.interval()` promise form).

**Gotcha:** creating effects outside an active context throws
`CordisError('INACTIVE_EFFECT')` (`cannot create effect on inactive context`).
Always register listeners/services from *within* a plugin body (or
`Service` constructor), never at module top-level.

---

## HMR (`@cordisjs/plugin-hmr`)

Hot reload for the dev loop. Requires running Node with **`--expose-internals`**
(it reaches into Node's internal `ModuleLoader` via `loader.internal`).

How it works (`packages/hmr/src/index.ts`):
1. **Watch** files with `chokidar` (config: `root`, `ignored`, `debounce`).
2. On change, classify each changed file:
   - **External** (reachable from the CLI main entry via `loadDependencies`) →
     triggers a **full process restart** (`loader.exit()`), not HMR.
   - **In ESM `loadCache`** → `stashed` for a partial reload.
   - A **loader config file** → `include.refresh()` re-reads config.
3. `analyzeChanges()` walks the dependency graph (via `job.linked`) to mark
   each file **accepted** (should reload) or **declined** (skipped). A file is
   accepted if directly changed or any dependent is accepted; declined if all
   dependents decline or it's an external.
4. **Clear module caches** for accepted files — both the ESM `loadCache`
   (`Map.prototype.delete` to work across Node 22–24) and CJS
   `require.cache`.
5. **Re-import** each plugin entry, `registry.delete(old)` then re-`plugin()`
   with the saved per-fiber config. Rolls back (restores caches, re-registers
   old plugins) if any re-import fails — reloads are **atomic**.

Use the `hmr` service config (`Hmr.Config`): `root: string[]`, `ignored`,
`debounce`, `base`.

---

## Loader & config-driven plugins (`@cordisjs/plugin-loader`)

Instead of calling `ctx.plugin` by hand, you declare plugins in a config file
(`cordis.yml` / `.json` / `.js`) and the loader imports + instantiates them.
This is how koishi apps are configured.

Concepts:
- **Entry** — one `{ id, name, config, group?, disabled?, inject?, isolate?,
  intercept? }` record. `name` is the plugin module specifier; `config` is
  passed to the plugin.
- **EntryGroup** — a plugin whose `config` is an array of child entries
  (nested plugin trees, e.g. koishi `group:` blocks).
- **EntryTree / Include** — read a config file, build the entry tree, watch for
  changes (`@cordisjs/plugin-include`), and apply `patches` (insert/override
  entries by id).
- `ctx.loader` — the service; `entries()`, `locate(fiber)`,
  `unwrapExports(module)` (handles `default` + `__esModule` interop).
- `isolated` / `intercept` entry options map directly to `ctx.isolate` /
  `ctx.intercept` — this is how you give a plugin group its own service
  instances or config overrides.

koishi's `Loader` (`@koishijs/loader`) extends this: `ns-require` resolution
(`koishi-plugin-*`, scoped `koishijs` packages), dotenv loading, `migrate()`
(auto-adds `http`/`server`/`proxy-agent` plugins from legacy config), and a
`fullReload()` that exits the worker so the daemon respawns the process.

**Config file example (cordis.yml):**
```yaml
plugins:
  - name: '@cordisjs/plugin-logger-console'
  - name: './my-plugin'
    config:
      token: 'xxx'
  - id: shard
    group: true
    isolate:
      counter: true          # own isolated `counter` instance
    intercept:
      http: { timeout: 1000 }
    config:
      - name: plugin-a
      - name: plugin-b
```

---

## koishi as the reference implementation

koishi's `Context` (in `@koishijs/core`) **extends** cordis's `Context` and
re-exports `cordis`. Plugins are ordinary cordis plugins:

```ts
import { Context, Schema } from 'koishi'

export const Config = Schema.object({ /* ... */ })
export function apply(ctx: Context, config: Config) {
  ctx.command('echo <text>').action(({ session }, text) => text)
  ctx.middleware((session, next) => next())
  ctx.on('message', (session) => { /* ... */ })
}
```

Built-in koishi services (all just cordis Services): `http`, `model` (database),
`i18n`, `permissions`, `schema`, `$commander` (`ctx.command`), `$processor`
(`ctx.middleware`), `$filter` (`ctx.guild()`, `ctx.user()`, `ctx.platform()`,
`ctx.intersect()`…), plus `bot`, `database`, `session` mixins from the `Koishi`
service. The **filter service** is the canonical use of `ctx.isolate`/`ctx.extend`
+ the `filter` symbol: `ctx.guild('123')` returns a child context whose events
only reach plugins scoped to that guild.

When extending koishi, you usually: (1) write a cordis plugin `apply(ctx, cfg)`,
(2) optionally subclass `Service` to add a `ctx.mything`, (3) declare a
`Config` schema for the loader.

---

## Common patterns & gotchas

- **Register inside the plugin body.** `ctx.on`, `ctx.provide`, `ctx.set`,
  `ctx.effect`, `ctx.command`, … must run within a plugin/Service, not at module
  top-level (else `INACTIVE_EFFECT`).
- **Provide before use, or inject.** Reading `ctx.foo` when nothing provides it
  throws `cannot get property "foo" without inject`. If you can't guarantee
  ordering, use `ctx.inject(['foo'], ...)` so your code waits for `foo`.
- **Always return a cleanup function** from a plugin body if you allocate
  resources (timers, listeners, native handles). cordis runs it on teardown.
- **Config validation is mandatory.** Whatever you pass as `plugin.Config`
  validates the config object; a mismatch throws `ValidationError` before the
  fiber activates (logged, not crashed).
- **Use `ctx.mixin` for ergonomic services.** Expose `timer.timeout` etc.
  directly on `ctx` rather than forcing `ctx.timer.timeout`.
- **Isolate vs intercept:** `isolate` = separate *instance*; `intercept` =
  separate *config* for the same instance. Pair them in loader `group` entries.
- **HMR needs `--expose-internals`** and only reloads files reachable from a
  plugin entry (in `loadCache`); framework files force a full restart.
- **Async effects:** return a `Promise<disposer>` or `AsyncIterable` for effects
  that need async cleanup or cancellation.
- **`await ctx.plugin(...)`** is the idiomatic way to wait for a plugin to
  finish loading (including its `Service.init`).

---

## Design philosophy (why it's built this way)

- **Declarative dependencies, automatic lifecycle.** You state *what you need*;
  the framework orders startup, handles hot-swapping deps, and guarantees
  cleanup — no manual init/teardown orchestration.
- **Context = capability scope.** A context is a tree of *what is available*.
  Scoping (`extend`/`isolate`/`intercept`/`filter`) is first-class, enabling
  per-guild bots, multi-tenant config, and safe plugin isolation.
- **Proxy-based injection.** Reading `ctx.foo` is the injection point; this
  keeps the API tiny (`ctx.plugin`, `ctx.provide`, `ctx.on`, `ctx.effect`) while
  staying powerful.
- **Everything is an effect, everything is disposable.** Uniform teardown means
  no leaks and clean HMR — the entire app can be rebuilt from a config file.
- **Config is data.** The loader turns a YAML/JSON file into a live plugin
  graph, so apps are configured, not coded.
