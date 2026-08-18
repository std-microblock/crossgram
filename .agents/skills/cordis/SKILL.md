---
name: cordis
description: 编写/重构 Cordis 插件与 Service、把外部库（HTTP/WS/DB/MQTT 等）包装为 Cordis Service、使用 Loader/Include/Group/HMR 配置驱动应用、开发 WebUI 前端扩展、理解 Context/Fiber/Effect/Inject/isolate/intercept。触发词：cordis, ctx.plugin, ctx.effect, Service, @Inject, ctx.provide, ctx.isolate, ctx.on/emit/serial/bail/waterfall, @cordisjs/plugin-loader, @cordisjs/plugin-hmr, @cordisjs/plugin-webui, @cordisjs/client, fiber。
---


> 版本基线：
> - 核心 `cordis`：`4.0.0-rc.8`（cordiverse/cordis），API 仍在演进，官方 README 明确“尚未稳定”。
> - DeepSeek Harness vendor 形态：`@deepseek-ai/cordis` `4.0.1`，API 与 rc.8 同源，但 Loader 增加了 `internal/config` 插值、事务化 EntryGroup 更新、`!!js disabled` 语义等扩展。
> - 配套插件：`@cordisjs/plugin-loader` 1.0.0-rc.5、`plugin-include` 1.0.4、`plugin-group` 1.0.0、`plugin-hmr` 1.0.15、`plugin-timer` 1.1.2、`plugin-logger-console` 1.0.0。
> - 前端：`@cordisjs/plugin-webui` 0.8.2、`@cordisjs/client` 0.8.2（cordiverse/webui）。
> - 脚手架：`create-cordis` 0.3.0，默认模板 `@cordisjs/boilerplate` 0.6.1。
> - Koishi 仓库指向的是 Cordis **3.x**（`^3.18.1`），只作概念参考；其 `ctx.command`、`ctx.middleware`、`ctx.guild` 等是 Koishi 扩展，**不要**当成 Cordis 4 API。

D:\cordis 是 cordis 的源码，可以参考

---

## 1. 核心心智模型（先读）

1. **Context 是一棵作用域树。**
   `new Context()` 是根；`extend()` / `isolate()` / `intercept()` / `ctx.plugin()` 派生子上下文，原型继承父级、不修改父级。每个插件实例都运行在自己的 Context（及其 Fiber）中。

2. **插件在依赖未满足时是惰性的。**
   `inject: ['db']` 的插件在 `db` 服务出现且其 provider fiber ACTIVE 之前保持 PENDING；`db` 被卸载后依赖插件会自动卸载，`db` 恢复后再加载。启动顺序由依赖决定，不由配置列表顺序决定。

3. **一切注册都是 effect。**
   插件体返回清理函数、清理函数迭代器或 `Promise<清理函数>`；`ctx.on/provide/set/effect/plugin`、服务注册、HTTP 路由、工具注册等内部都调用 effect。所属 fiber 卸载时全部撤销。

4. **服务是注入的上下文属性。**
   服务占据稳定 key（`ctx.foo`）。读取 `ctx.foo` 经过 Context Proxy：未提供且未声明依赖会抛错；声明 `inject: ['foo']` 则等待其就绪。

5. **配置即数据。**
   `cordis.yml` / `.json` / `.js` 描述插件树；Loader 读入并热应用，应用是“配置出来的”，不是手写启动流程写出来的。

---

## 2. 快速上手

```ts
import { Context, Service } from 'cordis'

declare module 'cordis' {
  interface Context {
    counter: Counter
  }
  interface Events {
    'app/ready'(message: string): void
  }
}

class Counter extends Service {
  value = 0
  constructor(ctx: Context) {
    super(ctx, 'counter')          // -> ctx.counter
  }
  next() { return ++this.value }
}

const greeter = Object.assign((ctx: Context) => {
  ctx.on('app/ready', (message) => {
    ctx.logger.info('%s #%d', message, ctx.counter.next())
  })
}, {
  name: 'greeter',
  inject: ['counter'],
})

const root = new Context()
await root.plugin(Counter)          // 可 await Fiber，等待 Service.init 完成
await root.plugin(greeter)
root.emit('app/ready', 'started')
await root.fiber.dispose()          // 递归回收所有 effect / 子插件
```

Loader 版最小应用：

```yaml
# cordis.yml
- id: logger
  name: '@cordisjs/plugin-logger-console'
- id: hello
  name: './hello.ts'
```

```ts
// hello.ts
import type { Context } from 'cordis'
export const name = 'hello'
export function apply(ctx: Context) {
  ctx.logger.info('hello from plugin')
}
```

```sh
node --import tsx vendor/cordis/bin.js   # dsh vendor 启动器；等价于：
# root = new Context(); root.baseUrl = cwd/; await root.plugin(Loader)
# await ctx.loader.create({ name: include, config: { path: './cordis.yml' } })
```

---

## 3. 插件形态与元数据

### 3.1 三种插件形态

```ts
import { Context, Service } from 'cordis'

// 1. 函数插件（最常用）：Cordis 直接调用函数本身
export function apply(ctx: Context, config: Config) {}
export const name = 'my-plugin'
export const inject = ['db']
export const Config = ... // Standard Schema

// 2. 对象插件：必须带 apply 方法
export const plugin = {
  name: 'my-plugin',
  inject: ['db'],
  apply(ctx: Context, config: Config) {},
}

// 3. 类插件：Service 子类；构造器运行在 fiber LOADING 期间
export class MyService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'myService')  // 构造器内立即 provide
  }
}
```

### 3.2 插件元数据（`Plugin.Base`）

| 字段 | 含义 |
|---|---|
| `name?: string` | 诊断/日志显示名；默认取函数名（`apply` 会被忽略）；fiber 名可向祖先继承 |
| `Config?: StandardSchemaV1` | 配置校验器；`apply(ctx, config)` 前同步校验，默认值补齐；async 校验不支持 |
| `inject?: Inject` | 必需服务：字符串数组或 `{ 服务名: interceptConfig }` |
| `provide?: string \| string[]` | 声明该插件提供的服务名（供 Service 构造默认名与 loader/市场元数据使用） |
| `intercept?: Dict<boolean>` | 声明消费哪些服务的 intercept 配置 |

### 3.3 注册表语义

- `ctx.plugin(P, config?)` → 返回 **Fiber**（thenable，可 `await`；加载完成兑现、启动失败 reject）。
- 同一 callback（函数本身 / 对象 `.apply` / 类构造器）是注册表身份 key；多次 `ctx.plugin` 产生多个 Fiber，共享一个 `Plugin.Runtime`（`runtime.fibers`）。
- `ctx.registry.delete(plugin)` 会 dispose 该 runtime 的全部 fiber（HMR 用它整体替换）。
- `ctx.inject(deps, cb)` 等价于 `ctx.plugin({ inject, apply: cb, name: cb.name })`。
- 枚举：`ctx.registry.values()` 给 runtime；`runtime.fibers` 给所有 fiber（诊断 PENDING 用）。

### 3.4 `@Inject` 装饰器

```ts
import { Context, Inject, Service } from 'cordis'

@Inject('counter')                 // 类级：等价 static inject
class Foo extends Service {
  constructor(ctx: Context) { super(ctx, 'foo') }
}

class Api extends Service {
  constructor(ctx: Context) { super(ctx, 'api') }

  @Inject('db')                    // 方法级：依赖就绪后执行，
  async initDb(ctx: Context) { }   // this.ctx 会被替换为注入子上下文
}
```

- 数组/对象/原型链继承的 `inject` 通过 `Inject.resolve()` 归一化为 map。
- `inject: { name: config }` 既声明依赖，又把 config 写入该插件上下文的 intercept。

---

## 4. Context 与服务

### 4.1 Context 概览

`Context` 是 Proxy：普通属性读取进入服务解析器。保留字 `prototype`、`then`、数字字符串、`_` 前缀及 symbol 属性绕过注入。

| 成员 | 说明 |
|---|---|
| `new Context()` | 根上下文；内部自带 `events/logger/reflect/registry` 与根 Fiber |
| `ctx.root` | 应用根上下文（@experimental） |
| `ctx.baseUrl` | Loader 解析相对模块/配置路径的 base URL |
| `ctx.events` | 事件总线；其方法已 mixin 到 `ctx` |
| `ctx.logger` | 日志服务；`ctx.logger('name')` 生成具名 logger |
| `ctx.reflect` | Proxy 背后的反射层（`store/props`） |
| `ctx.registry` | 插件注册表；`plugin/inject` 已 mixin |
| `ctx.fiber` | 当前 Fiber |

Cordis 通过 `ctx.mixin` 把 `events.on/once/emit/parallel/serial/bail/waterfall`、`registry.plugin/inject`、`fiber.runtime/effect`、`reflect.get/set/provide/accessor/mixin` 暴露为 `ctx.*`。

### 4.2 作用域：extend / isolate / intercept

```ts
const child = ctx.extend({ own: 1 })          // 原型继承的子上下文，meta 自有属性遮蔽父级
const scoped = ctx.isolate('counter')         // 本分支拥有独立 counter 实例
const joined = ctx.isolate('counter', label)  // 相同 label 的两次 isolate 共享同一实例作用域
const configured = ctx.intercept('http', { timeout: 5000 }) // 本分支的 http 配置
```

- `isolate`：换**实例**；实现通过 `ctx[symbols.isolate]` 的 symbol key 隔离。
- `intercept`：同一实例换**配置**；`Service[resolveConfig]` 沿 intercept 原型链自祖先到后代合并（有 `Config.merge` 则深合并，否则 `Object.assign`）。
- Loader 条目把二者直接映射为 YAML 字段 `isolate` / `intercept`。

### 4.3 服务存储 API

```ts
ctx.provide('counter', new Counter(ctx))  // 注册为 effect；返回 disposer；重复 provide 抛错
ctx.set('counter', value)                 // 仅提供方 fiber 可写
ctx.get('counter')                        // 可选依赖探测；strict=true 只返回 provider ACTIVE 的值
ctx.accessor('now', {
  get(receiver, error) { return Date.now() },
  set(value, receiver, error) { return false },
})
ctx.mixin('timer', ['timeout', 'interval', 'debounce']) // -> ctx.timeout(...)
```

错误信息（可据此诊断）：
- 未注入就读取：`cannot get property "x" without inject`
- 已注入但 provider 非 ACTIVE：`cannot get required service "x" in inactive context`
- 未 provide 就 set：`cannot set property "x" without provide`
- 重复提供：`service "x" has been registered at <fiber-name>`

### 4.4 `Service` 基类

```ts
class Counter extends Service<Counter.Intercept> {
  declare [Service.config]: Counter.Intercept  // phantom 类型参数（可选）
  constructor(ctx: Context) { super(ctx, 'counter') }  // 注册属于 effect
  async *[Service.init]() {      // 可选；依赖方等待其完成
    yield () => this.close()     // 每个 yield 都是 disposer
  }
  [Service.check]() {            // 可选；返回 false 时依赖方认为服务不可用
    return this.ready
  }
  [Service.invoke](...args) {}   // 可选；使实例可调用，如 ctx.logger('name')
}
```

Service 静态符号：`Service.init / check / config / invoke / extend / tracker / resolveConfig`。
服务命名空间全应用扁平；自建服务加前缀/命名空间（不要占用 `loader/timer/logger/server/http/webui` 等）。

### 4.5 TypeScript 声明合并

```ts
declare module 'cordis' {
  interface Context { greeter: GreeterService }
  interface Events { 'greeter/hello'(name: string): void }
}
```

声明合并不生成运行时接线；消费者可用 `import type {} from './provider.ts'` 仅引入类型。

---

## 5. Fiber、生命周期与 Effect

### 5.1 状态机

```
PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED
                   ↘ FAILED
```

- `PENDING`：已声明但 `inject` 服务尚未满足。
- `LOADING/ACTIVE`：插件体执行中/完成。
- `FAILED`：配置校验或插件体抛错。
- `UNLOADING/DISPOSED`：清理中/全部拆除。
- 状态变化发 `internal/status`。

### 5.2 `ctx.effect`

```ts
ctx.effect(() => {
  const timer = setInterval(fn, 100)
  return () => clearInterval(timer)      // disposer
}, 'ctx.effect(timer)')
```

可返回的 effect 形状：
- `() => T`（disposer，可为 async）
- `Iterable<Disposable>` / `AsyncIterable<Disposable>`（逐个产生即注册；异步迭代可被卸载取消）
- `Promise<Disposable>`
- `null` / `undefined`（无副作用）

规则：
- effect 主体加载时立即执行；返回的 disposer 卸载时执行。
- **每个 effect 内部**的 disposer 按逆序串行执行；**多个 effect 之间**卸载并发启动（先逆序启动，异步 disposer 并发）。需要严格顺序时放进同一个 disposer 中依次 `await`。
- `ctx.on/once/plugin/provide/accessor/mixin`、服务注册、timer API、server 路由等都是 effect，会自动撤销。
- 在已 dispose 的上下文创建 effect：抛 `CordisError('INACTIVE_EFFECT')`。注册必须发生在插件体/Service 构造器内，不要在模块顶层。

### 5.3 Fiber API

| 成员 | 说明 |
|---|---|
| `fiber.uid` | registry 内唯一 id；根为 0，dispose 后 `null` |
| `fiber.ctx` | 插件运行子上下文 |
| `fiber.config` | 校验后的配置 |
| `fiber.state` | 生命周期状态 |
| `fiber.store` | 加载期间依赖服务快照；否则 `undefined` |
| `fiber.inertia` | 进行中的 load/unload Promise |
| `fiber.name` | 显示名，向最近具名祖先继承 |
| `fiber.dispose()` | 卸载并等待全部清理（含异步 disposer），递归卸载子插件 |
| `fiber.await()` | 等待稳定；启动错误会 rethrow |
| `fiber.restart()` | 用当前配置卸载后立即重载 |
| `fiber.update(config, noSave?)` | 校验新配置后走 `internal/update` waterfall 并重启 |
| `fiber.getEffects()` | 带标签的 EffectMeta 树（诊断） |
| `fiber.assertActive()` | 已 dispose 抛 `INACTIVE_EFFECT` |

配置错误：`ValidationError`（`invalid config:\n  - ... (at path)`）；插件启动异常被 logger 记录并进入 FAILED，`await fiber` 会 rethrow。

---

## 6. 事件系统

### 6.1 声明与监听

```ts
declare module 'cordis' {
  interface Events {
    'stats/report'(name: string, count: number): void
    'demo/transform'(input: string, next: () => Promise<string>): Promise<string>
  }
}

ctx.emit('stats/report', name, count)
const dispose = ctx.on('stats/report', (name, count) => {})  // effect 化，自动移除
ctx.once('ready', fn)
```

- 事件名任意字符串，惯例 `namespace/action`。
- `ctx.on(name, listener, options?)`，`options: { prepend?: boolean; global?: boolean }`；布尔值是 `prepend` 简写。返回 disposer。
- `prepend` 把监听器插到已有监听器之前。
- `global` 跳过上下文过滤器检查。
- 监听器经 `reflect.bind` 追踪：dispatch 传入 `thisArg` 时，监听器内 `this`、参数中可追踪对象会映射到分发上下文；过滤器取 `thisArg[Context.filter]`。

### 6.2 五种分发模式

| 模式 | 调用 | await？ | 顺序 | 返回值/短路 |
|---|---|---|---|---|
| `emit` | `ctx.emit(name, ...args)` | 否 | 注册顺序同步观察 | 忽略返回值和 Promise；同步异常向调用方抛出 |
| `parallel` | `await ctx.parallel(name, ...args)` | 是 | 全部并发 | 无返回值；任一 reject 则 `AggregateError` |
| `serial` | `await ctx.serial(name, ...args)` | 是 | 顺序执行并等待 | 第一个非 `null/false/undefined` 返回值胜出并停止 |
| `bail` | `ctx.bail(name, ...args)` | 否 | 同步顺序 | serial 的同步版 |
| `waterfall` | `ctx.waterfall(name, ...args, next)` | 分发本身不额外 await | 注册顺序环绕 | 最外层监听器返回值（可为 Promise） |

`waterfall` 语义：
- 监听器收到 `(原参数..., next)`；调用 `next()` 执行下游/内建逻辑，可包装其返回值；不调用 `next()` 直接返回 = **否决/短路**。
- 观察、标注、日志类监听器**必须调用 `next()`**；否则会静默吞掉下游默认行为。
- `prepend` 只用于确实需要先于普通注册运行的场景（如 Loader 保存配置的 `internal/update` 钩子）。

### 6.3 内部事件（不要用 `internal/` 前缀命名用户事件）

`internal/plugin(fiber)`、`internal/status(fiber, oldState)`、`internal/service(this, name, value)`、`internal/update(this, config, noSave, next)`、`internal/get(ctx, name, error, next)`、`internal/set(ctx, name, value, error, next)`、`internal/listener(this, name, listener, prepend)`、`internal/dispatch(mode, name, args, thisArg)`；dsh vendor 另有 `internal/config(this, config, next)`。

`internal/update` 特殊处理：当前 fiber 的监听器先于全局监听器执行（保存配置、日志 reload 都挂这里）。`internal/get` / `internal/set` 是拦截缺失属性读取/写入的扩展点。

---

## 7. Loader / Include / Group 与配置

### 7.1 配置条目

```yaml
- id: greeter              # 稳定身份；缺失则每次随机生成
  name: './greeter.ts'     # 模块说明符：相对路径 / npm 包名 / cordis:<builtin>
  config: {...}            # 传给插件，经 Config schema 校验
  disabled: true           # 保留条目但卸载；改回 false 重新加载
  group: true              # 该条目为嵌套组，config 必须是条目数组
  inject: ['tools']        # 额外注入
  isolate:                 # 服务隔离
    shell: true            # 本条目局部 realm
    db: shared-db          # 相同 label 的条目共享同一命名 realm
  intercept:               # 服务配置拦截
    http: { timeout: 5000 }
  label: Database          # WebUI 显示（loader-webui 扩展）
  collapse: false          # WebUI 分组折叠（loader-webui 扩展）
```

- 列表中条目**并发启动**；顺序不决定加载先后，依赖关系决定。
- 嵌套组作为一个单元加载/卸载；`disabled` 沿祖先生效；`group: true` 条目自身始终视为启用。
- `EntryTree.sep` 为 `:`，嵌套条目 id 以 `父id:子id` 表示。
- Loader 事件：`exit`、`loader/config-update`、`loader/entry-init`、`loader/partial-dispose`、`loader/patch-context`。

### 7.2 配置文件 Include

```ts
ctx.plugin(Loader, { baseUrl: import.meta.url })
await ctx.loader.create({
  name: '@cordisjs/plugin-include',
  config: {
    path: './cordis.yml',
    initial: [...],       // 文件不存在时写入的初始条目
    patches: [
      { id: 'inner', disabled: true },
      { id: 'group', insert: [{ name: './extra-plugin' }] },
      { id: 'timer', name: '@cordisjs/plugin-timer', config: {...} },
    ],
    enableLogs: true,
  },
})
```

- 支持 `.yml` / `.yaml` / `.json`（及 JS 模块默认导出）；写入采用 `.tmp` + rename；不可写自动转只读。
- Patch 规则：`insert` 无 `id` 插到根组末尾、有 `id` 插到目标组；非 insert 必须给 `id`；`name` 存在且不匹配则跳过并 warn；补丁按顺序应用（dsh vendor 会对输入 `structuredClone`，且后一个补丁可定位前一个补丁插入的行）。
- `Include.refresh()` 在内容变化时重读并 diff 更新；文件写入触发 `loader/config-update`。

### 7.3 `!!js` 表达式与 Loader 插值

（DeepSeek Harness primer + dsh vendor 行为）

- `@deepseek-ai/cordis-plugin-include` 的 YAML schema 把 `!!js expr` 解析为 `{ __jsExpr }` 表达式节点。
- Loader 在**声明的 inject 激活后、插件 fiber 上下文**（`ctx.<serviceName>`）上对条目 `config` 递归插值（通过 `internal/config` waterfall）。
- `disabled: !!js ...` 在**每次挂载决策时、loader 上下文**上求值，用于按环境/平台门控条目。
- Group/Include 是“树载体”，其自身条目和 patch 列表保持字面量；**嵌套行的表达式延迟到目标行激活时**才求值。
- 其他元数据（`name/id/inject` 等）保持字面值。
- 按环境选插件时使用 overlay/patch，不要直接改主配置。

```yaml
- id: shell
  name: '@my-app/shell'
  disabled: !!js process.env.NO_SHELL === '1'
  config:
    token: !!js process.env.TOKEN ?? 'default'
```

### 7.4 Loader 服务 API

`ctx.loader` 提供：`create/update/remove/resolve/resolveGroup/entries/await/getTasks/locate/unwrapExports/builtins/internal/envData/showLog/exit`。
- `Loader.Config { baseUrl? }`；`Loader.Intercept { await?: boolean }`——`ctx.inject({ loader: { await: true } }, ...)` 可等待所有 loader 条目 settle 后再启动（CLI 命令执行用此模式）。
- `locate(fiber)` 返回拥有该 fiber 的条目 id。
- `unwrapExports` 处理 `default` 与 `__esModule` interop。
- 模块解析失败：upstream 版本经 logger 报告、条目静默不加载；dsh 新 transactional Loader 会把 import/apply 失败包装为 `failed to import/apply loader entry...` 并上抛。**两者在不同快照中都存在，写健壮启动器时应捕获或先拼写检查。**

---

## 8. HMR（@cordisjs/plugin-hmr）

最小组合：

```yaml
- id: logger
  name: '@cordisjs/plugin-logger-console'
- id: timer
  name: '@cordisjs/plugin-timer'
- id: hmr
  name: '@cordisjs/plugin-hmr'
  config:
    root: ['.', 'packages', 'external', 'app.yml']
    ignored: ['**/node_modules', '**/.*', 'cache', 'data']
    debounce: 100
```

- `Hmr.Config`：`base`（显示路径根，默认 cwd）、`root: string[]`、`ignored: string[]`（picomatch glob）、`debounce: number(ms)`；其余 ChokidarOptions 透传。
- 依赖：`inject: ['loader', 'timer']`；缺少 timer 会永远 PENDING 且无提示。
- 读取 Node ESM 内部 loader：需要 `--expose-internals`，或安装可选依赖 `node-addon-require-builtin`；兼容 Node 22/23（v1）与 Node 24+（v2）内部接口。`@cordisjs/plugin-cli-cordis` 的 worker 自动带 `--expose-internals`。
- 变化分类：
  1. CLI 主入口可达的**外部/框架文件** → `loader.exit()` 请求整进程重启（daemon 会拉起）。
  2. ESM `loadCache` 中的模块 → 依赖图分析后**部分重载**。
  3. Include 配置文件 → `include.refresh()`，按 id diff 增删改条目。
- 部分重载：分析 `job.linked` 依赖图，标记 accepted/declined；清 ESM loadCache 与 CJS `require.cache`；重新 import 每个插件入口；`registry.delete(old)` 后按各 fiber 原 config 重新 `plugin()`；任何失败**回滚缓存并恢复旧插件**，整批原子。
- 事件：`hmr/change(url)`、`hmr/reload(reloads: Map<Plugin, Reload>)`。
- 插件模块应把所有外部资源写成 effect；否则 HMR 泄漏。

---

## 9. 日志、计时器与工具

### 9.1 Logger

- `ctx.logger.error/warn/info/debug(...)` 直接记录；`ctx.logger('name')` 返回具名 Logger。
- 内置环形 buffer（1000 条）始终可用；控制台输出通过 exporter 插件添加。
- `ctx.logger.exporter(exporter)` 是 effect。
- 拦截配置：`ctx.intercept('logger', { name: 'foo', level: LoggerLevel.DEBUG })`。
- `@cordisjs/plugin-logger-console`：
  - 导出 `ConsoleExporter`（类插件，直接 `ctx.plugin(ConsoleExporter, config)`）。
  - 配置：`colors`、`maxLength`、`levels`（按 logger 名/default 过滤）、`showDiff`、`showTime`、`label {width,margin,align}`。
  - 包 exports 按 node/browser 分别取 `util.inspect` 或 console 原生输出。

### 9.2 Timer（@cordisjs/plugin-timer）

```ts
ctx.timeout(fn, ms)        // 返回 disposer；到期前先自动 dispose 再执行
ctx.timeout(ms)            // Promise；上下文 dispose 时 reject
ctx.interval(fn, ms)       // 返回 disposer
ctx.interval(ms)           // AsyncIterable；上下文 dispose 时 throw
ctx.throttle(fn, ms)       // 返回带 .dispose() 的包装函数
ctx.debounce(fn, ms)
```

全部 effect 化；`ctx.timer` 服务与 `ctx.timeout` 等 mixin 同时存在。`setTimeout/setInterval` 同名旧方法已废弃。

### 9.3 其他

- `DisposableList<T>`：弱引用可迭代列表，`push` 返回删除函数，`clear()` 逆序返回并清空；常用于路由/连接注册表。
- `symbols`：导出 `cordis.*` 全局 symbol（effect/filter/isolate/intercept/shadow/caller/receiver/init/check/config/invoke/tracker 等）。
- `Context.is(value)`：跨 realm/多副本判断 Cordis 上下文。

---

## 10. 工程化：create-cordis 与 boilerplate

### 10.1 `create-cordis`

- Node >= 22；默认模板 `@cordisjs/boilerplate`（可 `-t` 覆盖）。
- 用法：`create-cordis [项目名]`，交互式询问；npm 包方式 `npm create cordis@latest`。
- 常用 flag：
  - `-r, --ref <tag>`：模板 dist-tag，默认 `latest`
  - `-f, --forced`：非空目录直接清空重建
  - `-g, --git`：初始化 git
  - `-p, --prod`：删 `devDependencies` 与 `workspaces`
  - `-t, --template <pkg>`：替换模板包
  - `-y, --yes`：跳过确认/安装启动
- 流程：探测 registry → 拉取模板 tarball → 改 package name → 可选 stage Yarn Berry → 可选 `install && start`。

### 10.2 boilerplate 结构

```
cordis.yml    # 外层启动配置
app.yml       # 实际应用条目树（带稳定 id）
package.json  # workspaces: external/*, packages/*；scripts: dev/build/start
```

外层：

```yaml
- name: '@cordisjs/plugin-cli'
  config: { name: cordis }
- name: '@cordisjs/plugin-cli-cordis'
  config:
    path: ./app.yml
    daemon: { enabled: true }
    prelude:
      - name: '@cordisjs/plugin-env'
      - name: '@cordisjs/plugin-logger-console'
```

- `cordis run` 启动应用；daemon 模式 fork worker、自动重启、heartbeat 检测。
- 开发模式：`NODE_OPTIONS="--import tsx --import @cordisjs/unyaml" cordis run`，配合 `@cordisjs/plugin-hmr`。
- app.yml 是典型的“分组应用”：`timer → http/server → group(Database) → group(SSO) → group(WebUI) → group(Development/HMR)`；WebUI 组即前端插件宿主。
- 自建工作区放在 `packages/*` 或 `external/*`，并声明 `@cordisjs/client` 依赖来参与前端构建。

---

## 11. 前端插件化（WebUI + @cordisjs/client）

这是 Cordis 前端扩展的完整机制：**浏览器端同样运行一个 Cordis Context**，前端扩展也是插件；服务端与客户端通过 WebSocket 上的 entry/数据/RPC 三类消息连接。

### 11.1 总体架构

```
服务端 Cordis Context
  └─ ctx.webui（@cordisjs/plugin-webui，Service，inject server）
       ├─ entries: Dict<Entry>          // 每个前端扩展一个 Entry
       ├─ listeners: Dict<fn>           // 消息类型 → 处理器
       ├─ clients: Dict<Client>         // 已连接浏览器
       └─ addEntry(files, data) → Entry // effect 注册

浏览器端 Cordis Context（createClient）
  └─ ctx.client（ClientService）
       ├─ action / loader / router / setting / theme / rpc
       ├─ socket: Ref<WebSocket>
       └─ ctx.$entry / ctx.$loader（前端 loader）
```

- 服务端 shell 由 `@cordisjs/client/app` 构建；开发模式 Vite middleware，生产模式读 manifest.json。
- 每个前端扩展包同时有：服务端入口 `src/index.ts`（Cordis 插件，调用 `ctx.webui.addEntry`）和客户端入口 `client/index.ts`（也是 Cordis 插件，默认导出 `(ctx, data) => void`）。

### 11.2 服务端扩展 API

```ts
import type {} from '@cordisjs/plugin-webui'
import type {} from '@cordisjs/plugin-loader'

export const inject = ['webui']  // 或 @Inject('webui')

export function apply(ctx: Context) {
  const entry = ctx.webui.addEntry({
    baseUrl: import.meta.url,          // 解析 source/manifest 的基址
    source: '../client/index.ts',      // 开发模式入口
    manifest: '../dist/manifest.json', // 生产模式 Vite manifest
    modulePath: undefined,             // 缺省时由 package.json name + 相对目录推导
    routes: ['/plugins{/*id}'],        // SPA fallback 状态码/加载占位路由
  }, {
    // 可序列化数据（JSON + Muon delta）
    count: 0,
    items: [],
    // 顶层函数不会序列化，而是提取为 RPC 方法
    async update(id, value) { return ... },
    async list() { return [...] },
  })

  // 数据变更：observable diff → broadcast 'entry:delta'
  entry.mutate((data) => { data.count++ })

  // 主动广播任意消息给所有客户端
  ctx.webui.broadcast('custom/message', { ok: true })

  // 连接管理
  ctx.on('webui/connection', function (this: WebUI, client) { ... })
}
```

`addEntry` 是 effect：所属 fiber 卸载时删除 entry 并广播 `entries[id] = null`。
`Entry` 关键成员：`id`、`files`、`data`、`state(DeltaState)`、`manifest`、`mutate(fn)`、`refreshManifest()`、`toJSON()`、`dispose`。

#### 11.2.1 私有/按用户状态不能直接放 Entry（重要）

截至 `@cordisjs/plugin-webui@0.8.2`，`Entry` 数据是**全局广播面**，不是鉴权数据面：

- 服务端 `Client` 构造时会立即把所有 `entry.toJSON()` 组成 `entry:init` 发给新 socket；这发生在应用自定义的登录握手之前。
- `entry.mutate()` 产生的 `entry:delta` 通过 `webui.broadcast()` 发给所有已连接客户端。
- `protectRpc` / RPC scope 只保护 `rpc:request`，不会过滤 `entry:init` 或 `entry:delta`。
- 0.8.2 没有“按 socket / principal 执行 `entry.mutate`”的官方 API；`Client.send()` 才是定向发送原语。

因此账号、凭证视图、按用户任务/流水、管理后台快照等敏感状态，**禁止**直接塞进普通 Entry，即使客户端路由有权限控制也会泄漏。正确分层：

1. 公共配置/目录：直接放 Entry，用 `entry.mutate` + 内置 Muon delta。
2. 私有状态：认证后按 principal 建立独立状态副本，服务端用 `@cordisjs/muon` 的 `observe + DeltaState.dump` 生成 delta，再用目标 `Client.send` 发送；客户端用独立 `DeltaState.load + apply` 原位更新 Vue ref。
3. 重新认证、退出或 socket close 时必须立即取消该客户端订阅，不能只依赖页面隐藏。
4. 不要退化成“Entry 只广播 `revision++`，客户端 watch 后 RPC 全量 list”：这虽然不泄密，但会制造持续全量 RPC、整页 loading 闪烁和数组整体替换。

Nexstore 的可复用实现位于 `packages/shell/src/scopedData.ts` 与 `packages/shell/client/scopedData.ts`，协议使用 `scoped:subscribe/init/delta/error`；其他项目可以采用同样的 scope-filtered Muon channel 模式。

`@cordisjs/plugin-webui`（NodeWebUI）配置：
- `uiPath`（默认 `''`）、`apiPath`（默认 `/api`）、`selfUrl`、`open`、`head`（注入 HTML head 标签）、`heartbeat { interval: 30s, timeout: 1min }`、`devMode`（按 `NODE_ENV`）、`cacheDir`、`dev`。
- 依赖 `server` 服务；`ctx.server.ws(apiPath)` 建立 WebSocket；同时服务静态资源与 SPA fallback。
- 生产模式通过 `manifest.resolve` 把扩展中的 `vue`、`@cordisjs/client` 等 import 重写为 shell vendor URL，确保依赖去重。

### 11.3 前后端通信协议

| 消息 | 方向 | 作用 |
|---|---|---|
| `entry:init` | S→C | 全量：`{ entries: Record<id, EntryData>, version }` |
| `entry:delta` | S→C | 增量：`{ id, ...Muon Delta }` |
| `rpc:request` | C→S | `{ sn, entryId, method, args }` |
| `rpc:response` | S→C | `{ sn, ok, value? , message? }` |
| `ping` / `pong` | C→S / S→C | heartbeat |

`EntryData = { files: string[], entryId?, data?, cursor?, methods? }`。
客户端断线 1s 后重连并 `location.reload`；RPC pending 在断线时全部 reject。

### 11.4 客户端 Context 与加载管线

```ts
import { createClient, connect, global } from '@cordisjs/client'
const root = createClient()
if (!global.static) connect(root, () => new WebSocket(endpoint))
root.client.mount('#app')
```

- `createClient()`：`new Context()` → `ctx.client = new ClientService(root)`；随后可以 `root.plugin(扩展)`。
- `ClientService` 构造 Vue app 并创建 `action/loader/router/setting/theme/rpc` 子服务。
- 收到 `entry:init` 后，`LoaderService`：
  - 版本不同直接 `location.reload()`；
  - 每个 entry 的 `files` 与现有 fiber 按 URL diff（新增 import、消失 dispose）；
  - 为 entry 建立 `ctx.extend({ $entry })` 子上下文；
  - `.js` 模块 import 后 `ctx.plugin(unwrapExports(module), entryData)`——**序列化数据成为前端插件 config**；
  - `.css` 通过插件把 `<link>` 注册为 effect；
  - 顶层 data 方法以不可枚举属性注入为 RPC 闭包。
- Muon delta 到达时 `DeltaState.load` + `apply` 更新 Vue ref；根对象 replace 时重新绑定 RPC 方法。

### 11.5 客户端六大扩展点

#### 1) 页面/活动（router.page）

```ts
ctx.client.router.page({
  id: 'plugins',
  path: '/plugins{/*id}',      // path-to-regexp v8；{/*name} 可选通配
  name: '插件管理',
  icon: 'activity:loader',     // 字符串图标或 Vue 组件
  order: 800,                  // 数值越大越靠前
  position: 'top',             // 'top' | 'bottom'
  authority: 4,
  disabled: () => false,
  component: Page,
})
```

- 每个 page 是 effect；卸载自动删路由/页面。
- `ctx.bail('activity', activity)` 返回真值可动态禁用页面。
- 路由守卫：`router.router.beforeEach/afterEach`；导航 API `push/replace/resolve`。
- `useRoute()` / `useRouter()` 供 Vue setup 使用。

#### 2) 插槽（router.slot）

```ts
ctx.client.router.slot({
  type: 'global' | 'layout' | 'status' | 'status-right' | 'plugin-details' | 'loader-intercept' | ...,
  component: Dialog,
  order: 0,
  disabled: () => false,
})
```

- shell 提供 `<k-slot name="..."/>`；内置 `k-layout/k-status` 组件等价于相应具名插槽。
- 页面内部也可用 `<k-slot>` 与 `<k-slot-item order="...">` 组合本地/全局贡献；`order` 大者优先，`single` 只渲染最高优先级。
- 跨插件 UI 组合主要靠“约定 slot type”，不靠组件 import 对方包。

#### 3) 动作/菜单（action）

```ts
ctx.client.action.action('config.save', {
  shortcut: 'ctrl+s',
  hidden: (scope) => !scope['config.tree'],
  disabled: (scope) => ...,
  action: (scope) => { ... },
})
ctx.client.action.menu('config.tree', [
  { id: 'toggle', label: ({ config }) => ..., icon: ..., order: 0 },
])
ctx.client.action.define('config.tree', value)   // 为 scope 注入数据
// Vue 中：const open = useMenu('config.tree') → open(event, value)
```

- `ActionContext` 支持点分层扁平化：`'config.tree'` 可作 `scope.config.tree`。
- 全部注册都是 effect。

#### 4) 设置（setting）

```ts
ctx.client.setting.settings({
  id: 'appearance', title: '外观', order: 900,
  schema: Schema.object({ ... }),
})
ctx.client.setting.schema({ type: 'string', role: 'theme', component: ThemePicker })
// Vue：useConfig()；非 setup：ctx.client.setting.original / .resolved
```

- 配置存 `localStorage['cordis.webui.config']`，可版本化。
- schema 扩展点用于给既有配置类型增加自定义 UI 组件。

#### 5) 主题（theme）

```ts
ctx.client.theme.theme({
  id: 'default-dark',
  name: '默认暗色',
  components: { 'app': ThemeApp },   // 按类型替换组件
})
// useColorMode() / ctx.client.theme.colorMode
```

#### 6) 图标 / 全局事件 / Vue 集成

```ts
icons.register('activity:network', IconNetwork)
ctx.on('notifier/message', (payload) => { ... })  // 客户端 Cordis 事件
ctx.client.addEventListener('keydown', handler)    // DOM 监听也 effect 化
ctx.client.wrapComponent(Component)                // 注入 kContext 与 fiber 错误边界
```

Vue composables：
- `useContext()`：为当前 setup 创建空 fiber，`onScopeDispose` 时 dispose；其中的注册随组件作用域自动撤销。
- `useInject(name)`：响应式服务引用。
- `useRpc<T>()`：当前 `$entry.data`。
- `provideStorage(factory)`：替换本地存储实现（WebUI 测试/SSR）。

### 11.6 前端插件包结构

```
my-webui-plugin/
├─ package.json
├─ src/index.ts        # 服务端 Cordis 插件：addEntry + 数据/RPC
├─ client/index.ts     # 默认导出 (ctx, dataRef) => void
└─ dist/manifest.json  # yakumo client 构建产物
```

`package.json` 关键内容：

```jsonc
{
  "dependencies": {
    "@cordisjs/client": "0.8.2",
    "cordis": "^4.0.0-rc.6"
  },
  "cordis": {
    "browser": true,
    "description": { "zh": "示例前端扩展", "en": "Example frontend extension" },
    "service": {
      "required": ["webui"],
      "implements": ["webui"]
    },
    "ecosystem": {
      "pattern": ["@myorg/plugin-*"],
      "keywords": ["myorg"]
    }
  }
}
```

构建：
- `@cordisjs/client` 的 yakumo 扩展 `yakumo client`：扫描 workspace 中依赖 `@cordisjs/client`（或声明 `yakumo.client`）的包，对每个 `client/index.ts` 跑 Vite build，输出 `dist/` 与 `manifest.json`。
- 也可 `cordis-webui build [root]`。
- Vite 外部化 `vue` 和 `@cordisjs/client`，生产运行由 WebUI 服务端重写为 shell vendor。
- 开发模式 `source` 直接交给 WebUI 的 Vite dev server；`@cordisjs/plugin-hmr` 监听 manifest 变化时调用 `entry.refreshManifest()`。

### 11.7 前端插件交互方式总结

| 交互场景 | 机制 |
|---|---|
| 服务端插件 ↔ 服务端插件 | Cordis Service（`ctx.provide/inject`）与事件（`emit/serial/waterfall`） |
| 客户端插件 ↔ 客户端插件 | 同一浏览器 Cordis Context：`inject`、`ctx.on`、`ctx.client.*` 扩展点、Vue provide/inject（kContext） |
| 服务端 → 客户端全量状态 | 连接时 `entry:init` |
| 服务端 → 客户端增量状态 | `entry.mutate` + Muon `entry:delta` |
| 客户端 → 服务端调用 | entry data 顶层方法自动提取为 RPC |
| 服务端主动通知 | `ctx.webui.broadcast(type, body)` + 客户端 `ctx.on(type)` |
| 跨包 UI 组合 | 命名 slot（`k-slot`/`router.slot`）+ 活动页 + 菜单/快捷键 |
| 依赖去重 | 生产 manifest `resolve` → `/-/vendors/` 重写 |

参考实现：`@cordisjs/plugin-loader-webui`。其服务端 `@Inject('webui')` 后 `addEntry`，data 里暴露 `entries/packages/services` 及 `listConfig/createConfig/updateConfig/removeConfig/evalConfig/listDependencies/listPackages/getPackageRuntime/getPackageReadme/listServices` RPC；客户端 `Manager extends Service` 消费这些 RPC，再用 page/slot/action/subroute 渲染插件配置界面。

---

## 12. 把外部库包装为 Cordis Service（最常用 idiom）

以 `@cordisjs/plugin-server` 为范本（包装 Node `http` + `ws`）：

1. **`class X extends Service`**，`super(ctx, name)` 使资源句柄成为 `ctx.<name>`。
2. **构造器里把原生事件桥接为 Cordis 事件**，并显式传 `thisArg` 以保留过滤/trace：
   ```ts
   this._http.on('request', async (_req, _res) => {
     await this.ctx.waterfall(this, 'server/request', req, res, async () => {})
   })
   ```
3. **每个用户 API 调用都注册 effect**：`ctx.server.get(path, mw)` 内部 `ctx.effect(function* () { yield routes.push(self) })`；所属插件卸载/HMR 时路由自动移除。
4. **长生命周期资源放 `[Service.init]`**：
   ```ts
   async *[Service.init]() {
     this.port = await listen(this._http, this.config)
     yield () => new Promise(resolve => this._http.close(resolve))
     this.ctx.logger.info('server listening...')
     yield () => this.ctx.logger.info('server closing...')
   }
   ```
5. **包装对象加 `Service.tracker`** 以便监听器内 `this.ctx/ctx.logger` 正确解析：
   ```ts
   defineProperty(this, Service.tracker, { associate: 'server.request' })
   ```

Server 服务暴露：`ctx.server.get/post/put/delete/patch/all/head(path|RegExp, middleware, options?)`、`use(mw)`（prepend 到 `server/request`）、`ws(path, handler?, options?)`；事件 `server/request`、`server/route-request`、`server/upgrade`、`server/route-check`；拦截配置 `{ path?: string, routes?: Dict<Route.Options> }`。这样 `ctx.isolate('server')` 或 `ctx.intercept('server', { path: '/v2' })` 可以不改代码获得隔离实例或路径前缀。

---

## 13. 最佳实践与检查清单

### 13.1 架构选择

- 把可复用行为封装为**插件**；把可替换能力封装为 **Service**（定义/提供者/消费者三角色）。
- “拦截、策略、可观察性”优先用**事件**（尤其 waterfall/serial）；“确定性的直接能力调用”优先用**服务方法**。
- 消费者只 `inject: ['name']`，不 import 具体实现；配置决定 provider。
- 服务名用前缀/命名空间；事件名 `namespace/action`；避免 `internal/` 前缀。

### 13.2 生命周期

- 每个注册都要有 disposer：优先 `ctx.on/plugin/provide/effect/timer/route` 等自动 effect；裸资源用 `ctx.effect` 包起来。
- 拆除顺序有要求时放同一个 effect/disposer 内串行 `await`。
- 插件体/Service 构造器内注册；模块顶层通常没有活跃 fiber。
- 异步初始化的正确位置是 `[Service.init]`，而不是 `ctx.on('ready')` hack。

### 13.3 事件纪律

- waterfall 观察者必须 `next()`；只有拥有决策权时才短路。
- `serial/bail` 用于“谁先给答案谁赢”；`parallel` 用于扇出后汇总/副作用；`emit` 只用于 fire-and-forget。
- 监听器要幂等：依赖消失/恢复会触发重复卸载加载。

### 13.4 配置与组合

- 所有可配置插件导出同名 `Config`（Schemastery / 任何 Standard Schema）；不要导出普通对象冒充 schema。
- Loader 条目显式 `id`；无 id 的条目在配置文件任何变化时都会被重建。
- 环境差异用 `disabled: !!js ...`、patch/overlay 或 `intercept/isolate`，不要复制整份配置。
- 大分组用 `group: true`；同一逻辑实例不同配置用 `intercept`；要完全独立实例用 `isolate: true`；多个条目共享一个独立实例用同一 `isolate` label。

### 13.5 调试

- 插件无输出先查 fiber 状态：
  ```ts
  for (const runtime of ctx.registry.values())
    for (const fiber of runtime.fibers)
      if (fiber.state === FiberState.PENDING) console.log(fiber.name, 'PENDING')
  ```
- 配置错看 `ValidationError` 的 `at path`；依赖缺失看 PENDING；服务名冲突/未 provide 看 Context 的规范错误。
- `await fiber` / `await ctx.plugin(...)` 会让启动错误显式化。

### 13.6 前端专项

- 前端扩展的服务端部分与客户端部分都是 Cordis 插件，都用 effect 注册，不要手动清路由/插槽。
- 公共大对象状态用 `entry.mutate` + Muon delta，不要频繁全量广播；私有大对象使用鉴权后的定向 Muon channel，不能放普通 Entry。
- 不要用 `revision++ → watch → RPC 全量 list` 模拟响应式状态；它只传播失效信号，实际仍是全量请求与整体替换。
- 前端插件依赖另一个前端插件：`inject: ['manager']` 或用 `ctx.inject`；不要在组件里直接 import 对方模块。
- 组件通过 `ctx.client.wrapComponent` 绑定 kContext；setup 内注册用 `useContext()` 绑定组件生命周期。
- 给 UI 注册路由时声明 `routes`，否则 SPA fallback 返回 404/加载判断不正确。
- 客户端可序列化 data 中不要放函数（函数应作为顶层 RPC 方法）；RPC 方法要幂等、可被重连后重新调用。

---

## 14. 核心 API 速查表

### Context / 服务

```ts
Context.is(value: any): value is Context
new Context(): Context

ctx.extend(meta?: object): this
ctx.isolate(name: string, label?: symbol): this
ctx.intercept(name: string, config: any): this

ctx.get<K>(name: K, strict?: boolean): this[K] | undefined
ctx.set<K>(name: K, value: this[K]): void
ctx.provide<K>(name: K, value?: this[K]): () => void
ctx.accessor(name: string, options: { get: ...; set?: ... }): void
ctx.mixin(source: object | string, mixins: string[] | Dict<string>): void

ctx.effect(execute: () => Effect, label?: string): disposer
ctx.plugin<P extends Plugin>(plugin: P, ...config: any[]): Fiber & PromiseLike<Fiber>
ctx.inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>
```

### 事件

```ts
ctx.on(name, listener, options?: boolean | EventOptions): () => boolean
ctx.once(name, listener, options?): () => boolean
ctx.emit(name | thisArg, ...args): void
ctx.parallel(name | thisArg, ...args): Promise<void>
ctx.serial(name | thisArg, ...args): Promise<ReturnType | undefined>
ctx.bail(name | thisArg, ...args): ReturnType | undefined
ctx.waterfall(name | thisArg, ...args, next): ReturnType

interface EventOptions { prepend?: boolean; global?: boolean }
type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'
```

### Fiber

```ts
fiber.uid / fiber.ctx / fiber.config / fiber.state / fiber.store / fiber.inertia / fiber.name
fiber.dispose(): Promise<void>
fiber.await(): Promise<this>
fiber.restart(): Promise<void>
fiber.update(config: any, noSave?: boolean): any
fiber.getEffects(): EffectMeta[]
fiber.effect(execute, label?): disposer
```

### 插件类型

```ts
type Plugin<T> =
  | { (ctx: Context, config: T): any; name?; Config?; inject?; provide?; intercept? }
  | { new(ctx: Context, config: T): any; ... }
  | { apply(ctx: Context, config: T): any; ... }

type Inject = (keyof Context)[] | { [name]?: any }
class ValidationError extends TypeError {}
class CordisError extends Error { code: CordisError.Code }
enum FiberState { PENDING, LOADING, ACTIVE, FAILED, DISPOSED, UNLOADING }
```

### Loader 条目

```ts
interface EntryOptions {
  id: string
  name: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: Inject | null
  intercept?: Dict | null
  isolate?: Dict<true | string> | null
}
// loader-webui 扩展：label?, collapse?
```

### WebUI 核心

```ts
ctx.webui.addEntry(files: Entry.Files, data?: T): Entry<T>
ctx.webui.broadcast(type: string, body: any): void
entry.mutate(fn: (data: T) => void): void
ctx.client.router.page(options): () => void
ctx.client.router.slot(options): () => void
ctx.client.action.action(id, options | fn): () => void
ctx.client.action.menu(id, items): () => void
ctx.client.setting.settings(options): () => void
ctx.client.setting.schema(extension): () => void
ctx.client.theme.theme(options): () => void
ctx.client.addEventListener(type, listener, options?): () => void
ctx.client.wrapComponent(component): DefineComponent
```

---

## 15. 官方包地图

| 包 | 作用 |
|---|---|
| `cordis` | Context/Fiber/事件/Service/日志核心 |
| `@cordisjs/plugin-loader` | 配置驱动插件树、`ctx.loader` |
| `@cordisjs/plugin-include` | YAML/JSON 配置读取、patch、写回 |
| `@cordisjs/plugin-group` | 嵌套分组 |
| `@cordisjs/plugin-hmr` | 热重载 |
| `@cordisjs/plugin-timer` | effect 化计时 |
| `@cordisjs/plugin-logger-console` | 控制台日志 exporter |
| `@cordisjs/plugin-cli` / `plugin-cli-cordis` | CLI 命令服务 / `cordis run` daemon |
| `@cordisjs/plugin-env` | dotenv → `ctx.env` |
| `@cordisjs/plugin-http` | 可拦截、可配置的 HTTP 客户端服务 |
| `@cordisjs/plugin-server` | HTTP/WS 服务 Service（外部资源包装范本） |
| `@cordisjs/plugin-webui` | WebUI 服务端、entry 协议 |
| `@cordisjs/client` | 浏览器端 Cordis Context、扩展点、构建器 |
| `@cordisjs/components` | 前端基础组件 |
| `@cordisjs/plugin-loader-webui` | 插件/分组管理界面（前端扩展范本） |
| `create-cordis` / `@cordisjs/boilerplate` | 脚手架 / 默认模板 |

DeepSeek Harness 以 vendor 方式使用同一套代码（`@deepseek-ai/cordis`、`@deepseek-ai/cordis-plugin-*`），其 `ctx.tools`、`ctx.llm`、`ctx.agents` 等只是 Cordis Service 的宿主示例，不是 Cordis 核心 API；编写通用 Cordis 插件时不要依赖这些 harness 专属服务名。

---

## 16. 兼容性红线（Koishi 旧版等）

- Koishi 当前仓库基于 `cordis ^3.18.1`：旧版的 `Context/Service` 导出、`ctx.scope/using/accept` 等命名与 4.x 可能不同；除非明确要写老版 Koishi 插件，否则一律以 Cordis 4 签名与本文为准。
- Cordis 4 是 ESM-first；`create-cordis` 要求 Node ≥ 22；HMR 的 Node 内部 loader 接口在 22/23 与 24+ 有差异（插件已做兼容，但自己封装 `loader.internal` 时要注意 `v1/v2`）。
- Cordis 上游标注 API 未稳定；升级 rc 版本时重点核对：Fiber 状态枚举、`internal/*` 事件、Loader 插值时机、entry update 的事务行为。