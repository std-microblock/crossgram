import { watch, type FSWatcher } from 'chokidar'
import { Context, type Fiber, type Plugin, Service } from 'cordis'
import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import z from 'schemastery'
import { tsImport } from 'tsx/esm/api'

export const name = 'debug-scripts'

export interface Config {
  root?: string
  results?: string
  debounce?: number
  ttl?: number
  maxFiles?: number
  maxFileBytes?: number
  maxResults?: number
  maxResultBytes?: number
}

export const Config: z<Config> = z.object({
  root: z.string().default('./data/debug-scripts'),
  results: z.string().default('./data/debug-results'),
  debounce: z.natural().role('ms').default(150),
  ttl: z
    .natural()
    .role('ms')
    .default(30 * 60 * 1000),
  maxFiles: z.natural().default(32),
  maxFileBytes: z.natural().default(256 * 1024),
  maxResults: z.natural().default(100),
  maxResultBytes: z.natural().default(1024 * 1024),
})

export interface DebugScriptResult {
  id: number
  timestamp: number
  value: unknown
}

export type DebugScriptState =
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloaded'
  | 'expired'

export interface DebugScriptStatus {
  script: string
  state: DebugScriptState
  generation: number
  activeGeneration?: number
  updatedAt: number
  loadedAt?: number
  expiresAt?: number
  error?: string
  results: DebugScriptResult[]
}

export interface DebugScriptSession {
  readonly name: string
  readonly generation: number
  publish(value: unknown): Promise<void>
}

declare module 'cordis' {
  interface Context {
    debugScripts: DebugScripts
    debugScript: DebugScriptSession
  }
}

interface LoadedScript {
  module: Plugin
  fiber: Fiber
  generation: number
}

interface ScriptRecord {
  status: DebugScriptStatus
  loaded?: LoadedScript
  timer?: NodeJS.Timeout
}

type ImportScript = (filename: string) => Promise<Record<string, unknown>>

const defaultImport: ImportScript = async (filename) => {
  const temporary = resolve(
    dirname(filename),
    `.${basename(filename)}.${randomUUID()}.mts`,
  )
  try {
    await writeFile(temporary, await readFile(filename), { mode: 0o600 })
    return (await tsImport(
      pathToFileURL(temporary).href,
      import.meta.url,
    )) as Record<string, unknown>
  } finally {
    await rm(temporary, { force: true })
  }
}

export function resolveConfiguredPath(
  baseUrl: string | undefined,
  value: string,
): string {
  if (isAbsolute(value)) return resolve(value)
  if (baseUrl) return fileURLToPath(new URL(value, baseUrl))
  return resolve(value)
}

export function normalizeScriptName(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (
    !normalized.endsWith('.ts') ||
    normalized.endsWith('.d.ts') ||
    normalized.startsWith('/') ||
    normalized.includes('\0')
  ) {
    throw new Error(`Invalid debug script path: ${value}`)
  }
  const parts = normalized.split('/')
  if (
    parts.some(
      (part) => !part || part === '.' || part === '..' || part.startsWith('.'),
    )
  ) {
    throw new Error(`Invalid debug script path: ${value}`)
  }
  return normalized
}

export function serializeResult(value: unknown, maxBytes: number): unknown {
  const seen = new WeakSet<object>()
  const json = JSON.stringify(value, (_key, current) => {
    if (typeof current === 'bigint') return `${current}n`
    if (current instanceof Error) {
      return {
        name: current.name,
        message: current.message,
        stack: current.stack,
      }
    }
    if (current instanceof Uint8Array) {
      return {
        type: 'bytes',
        length: current.length,
        base64: Buffer.from(current).toString('base64'),
      }
    }
    if (current && typeof current === 'object') {
      if (seen.has(current)) return '[Circular]'
      seen.add(current)
    }
    return current
  })
  if (json === undefined) return null
  if (Buffer.byteLength(json) > maxBytes) {
    throw new Error(`Debug script result exceeds ${maxBytes} bytes`)
  }
  return JSON.parse(json)
}

export class DebugScripts extends Service {
  public readonly root: string
  public readonly resultsRoot: string
  private readonly config: Required<Config>
  private readonly records = new Map<string, ScriptRecord>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly importScript: ImportScript
  private watcher?: FSWatcher
  private writeQueue = Promise.resolve()

  constructor(
    ctx: Context,
    config: Config = {},
    importScript: ImportScript = defaultImport,
  ) {
    super(ctx, 'debugScripts')
    this.config = {
      root: config.root ?? './data/debug-scripts',
      results: config.results ?? './data/debug-results',
      debounce: config.debounce ?? 150,
      ttl: config.ttl ?? 30 * 60 * 1000,
      maxFiles: config.maxFiles ?? 32,
      maxFileBytes: config.maxFileBytes ?? 256 * 1024,
      maxResults: config.maxResults ?? 100,
      maxResultBytes: config.maxResultBytes ?? 1024 * 1024,
    }
    this.root = resolveConfiguredPath(ctx.baseUrl, this.config.root)
    this.resultsRoot = resolveConfiguredPath(ctx.baseUrl, this.config.results)
    this.importScript = importScript
  }

  async start(): Promise<() => Promise<void>> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await mkdir(this.resultsRoot, { recursive: true, mode: 0o700 })
    this.watcher = watch('.', {
      cwd: this.root,
      ignoreInitial: false,
      followSymlinks: false,
      awaitWriteFinish: {
        stabilityThreshold: this.config.debounce,
        pollInterval: Math.max(25, Math.min(this.config.debounce, 100)),
      },
    })
    this.watcher.on('add', (path) => this.enqueue(path, () => this.load(path)))
    this.watcher.on('change', (path) =>
      this.enqueue(path, () => this.load(path)),
    )
    this.watcher.on('unlink', (path) =>
      this.enqueue(path, () => this.unload(path, 'unloaded')),
    )
    this.watcher.on('error', (error) =>
      this.ctx.logger('debug-scripts').warn(error),
    )
    await new Promise<void>((resolveReady, reject) => {
      this.watcher!.once('ready', resolveReady)
      this.watcher!.once('error', reject)
    })

    return async () => {
      await this.watcher?.close()
      await Promise.allSettled([...this.queues.values()])
      await Promise.allSettled(
        [...this.records.keys()].map((path) => this.unload(path, 'unloaded')),
      )
    }
  }

  list(): DebugScriptStatus[] {
    return [...this.records.values()].map((record) =>
      structuredClone(record.status),
    )
  }

  get(name: string): DebugScriptStatus | undefined {
    const record = this.records.get(normalizeScriptName(name))
    return record && structuredClone(record.status)
  }

  private enqueue(path: string, task: () => Promise<void>): void {
    let name: string
    try {
      name = normalizeScriptName(path)
    } catch {
      return
    }
    const previous = this.queues.get(name) ?? Promise.resolve()
    const next = previous
      .then(task, task)
      .catch((error) => {
        this.ctx.logger('debug-scripts').warn(error)
      })
      .finally(() => {
        if (this.queues.get(name) === next) this.queues.delete(name)
      })
    this.queues.set(name, next)
  }

  private async verifyFile(name: string): Promise<string> {
    const filename = resolve(this.root, ...name.split('/'))
    const rootPrefix = this.root.endsWith(sep)
      ? this.root
      : `${this.root}${sep}`
    if (!filename.startsWith(rootPrefix))
      throw new Error(`Debug script escapes root: ${name}`)
    const info = await lstat(filename)
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Debug script is not a regular file: ${name}`)
    if (info.size > this.config.maxFileBytes) {
      throw new Error(
        `Debug script ${name} exceeds ${this.config.maxFileBytes} bytes`,
      )
    }
    const actual = await realpath(filename)
    const actualRoot = await realpath(this.root)
    if (actual !== actualRoot && !actual.startsWith(`${actualRoot}${sep}`)) {
      throw new Error(`Debug script escapes root: ${name}`)
    }
    return filename
  }

  private record(name: string): ScriptRecord {
    let record = this.records.get(name)
    if (record) return record
    if (this.records.size >= this.config.maxFiles) {
      throw new Error(`Debug script limit reached (${this.config.maxFiles})`)
    }
    record = {
      status: {
        script: name,
        state: 'loading',
        generation: 0,
        updatedAt: Date.now(),
        results: [],
      },
    }
    this.records.set(name, record)
    return record
  }

  private async load(path: string): Promise<void> {
    const name = normalizeScriptName(path)
    const record = this.record(name)
    const generation = ++record.status.generation
    record.status.state = 'loading'
    record.status.updatedAt = Date.now()
    record.status.error = undefined
    await this.persist(record)

    let candidate: Plugin
    try {
      const filename = await this.verifyFile(name)
      const exports = await this.importScript(filename)
      const unwrapped =
        exports.default && typeof exports.default === 'object'
          ? (exports.default as Record<string, unknown>)
          : exports
      if (typeof unwrapped.apply !== 'function')
        throw new Error(`${name} must export function apply(ctx)`)
      candidate = unwrapped as unknown as Plugin
    } catch (error) {
      await this.fail(record, error)
      return
    }

    const previous = record.loaded
    const previousResults = structuredClone(record.status.results)
    if (previous) await previous.fiber.dispose()

    const session: DebugScriptSession = {
      name,
      generation,
      publish: (value) => this.publish(record, generation, value),
    }
    const scope = this.ctx.extend({ debugScript: session })
    let fiber: Fiber | undefined
    try {
      fiber = scope.plugin(candidate)
      await fiber
      record.loaded = { module: candidate, fiber, generation }
      record.status.state = 'active'
      record.status.activeGeneration = generation
      record.status.loadedAt = Date.now()
      record.status.updatedAt = record.status.loadedAt
      record.status.results = record.status.results.filter(
        (result) => result.id >= generation * 1_000_000,
      )
      this.armExpiry(name, record)
      await this.persist(record)
      this.ctx
        .logger('debug-scripts')
        .info('loaded %s generation %d', name, generation)
    } catch (error) {
      await fiber?.dispose().catch(() => {})
      record.loaded = undefined
      record.status.results = previousResults
      if (previous) {
        try {
          const rollbackSession: DebugScriptSession = {
            name,
            generation: previous.generation,
            publish: (value) =>
              this.publish(record, previous.generation, value),
          }
          const rollback = this.ctx
            .extend({ debugScript: rollbackSession })
            .plugin(previous.module)
          await rollback
          record.loaded = { ...previous, fiber: rollback }
          record.status.state = 'active'
          record.status.activeGeneration = previous.generation
        } catch (rollbackError) {
          record.status.state = 'failed'
          record.status.error = `${formatError(error)}\nRollback failed: ${formatError(rollbackError)}`
          await this.persist(record)
          return
        }
      }
      await this.fail(record, error)
    }
  }

  private async publish(
    record: ScriptRecord,
    generation: number,
    value: unknown,
  ): Promise<void> {
    const normalized = serializeResult(value, this.config.maxResultBytes)
    const generationBase = generation * 1_000_000
    const ordinal =
      record.status.results.filter((result) => result.id >= generationBase)
        .length + 1
    record.status.results.push({
      id: generationBase + ordinal,
      timestamp: Date.now(),
      value: normalized,
    })
    record.status.results = record.status.results.slice(-this.config.maxResults)
    record.status.updatedAt = Date.now()
    await this.persist(record)
  }

  private async fail(record: ScriptRecord, error: unknown): Promise<void> {
    record.status.state = record.loaded ? 'active' : 'failed'
    record.status.error = formatError(error)
    record.status.updatedAt = Date.now()
    await this.persist(record)
    this.ctx
      .logger('debug-scripts')
      .warn(
        '%s generation %d failed: %s',
        record.status.script,
        record.status.generation,
        record.status.error,
      )
  }

  private armExpiry(name: string, record: ScriptRecord): void {
    if (record.timer) clearTimeout(record.timer)
    if (!this.config.ttl) {
      record.status.expiresAt = undefined
      return
    }
    record.status.expiresAt = Date.now() + this.config.ttl
    record.timer = setTimeout(
      () => this.enqueue(name, () => this.unload(name, 'expired')),
      this.config.ttl,
    )
    record.timer.unref()
  }

  private async unload(
    path: string,
    state: 'unloaded' | 'expired',
  ): Promise<void> {
    const name = normalizeScriptName(path)
    const record = this.records.get(name)
    if (!record) return
    if (record.timer) clearTimeout(record.timer)
    record.timer = undefined
    await record.loaded?.fiber.dispose()
    record.loaded = undefined
    record.status.state = state
    record.status.updatedAt = Date.now()
    record.status.expiresAt = undefined
    await this.persist(record)
    this.records.delete(name)
    this.ctx.logger('debug-scripts').info('%s %s', state, name)
  }

  private persist(record: ScriptRecord): Promise<void> {
    const status = structuredClone(record.status)
    const filename = resolve(
      this.resultsRoot,
      ...`${status.script}.json`.split('/'),
    )
    const index = this.list().map((item) => ({
      script: item.script,
      state: item.state,
      generation: item.generation,
      activeGeneration: item.activeGeneration,
      updatedAt: item.updatedAt,
      loadedAt: item.loadedAt,
      expiresAt: item.expiresAt,
      error: item.error,
      resultCount: item.results.length,
    }))
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await atomicJson(filename, status)
        await atomicJson(resolve(this.resultsRoot, 'index.json'), index)
      })
    return this.writeQueue
  }
}

async function atomicJson(filename: string, value: unknown): Promise<void> {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporary, filename)
  } finally {
    await rm(temporary, { force: true })
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message
  return String(error)
}

export async function apply(
  ctx: Context,
  config: Config = {},
): Promise<() => Promise<void>> {
  const runner = new DebugScripts(ctx, config)
  return runner.start()
}
