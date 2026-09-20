import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeltaState, observe } from '@cordisjs/muon'
import type { Context } from 'cordis'
import type WebUI from './index.js'
import { boundHistory } from './history.js'
import { builtinClients } from './catalogue.js'
import type { EntryFiles, EntryMeta, Snapshot } from './protocol.js'

export interface Chunk {
  file: string
  isEntry?: boolean
  css?: string[]
  imports?: string[]
}
const packages = new Map<string, Promise<string>>()
async function packageName(url: string): Promise<string> {
  let directory = dirname(fileURLToPath(url))
  const cached = packages.get(directory)
  if (cached) return cached
  const task = (async () => {
    while (true) {
      try {
        const pkg = JSON.parse(
          await readFile(resolve(directory, 'package.json'), 'utf8'),
        )
        if (typeof pkg.name === 'string') return pkg.name
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const parent = dirname(directory)
      if (parent === directory)
        throw new Error('Cannot identify WebUI entry package: ' + url)
      directory = parent
    }
  })()
  packages.set(directory, task)
  return task
}

export class Entry<T extends object = any> {
  readonly id = randomUUID()
  readonly state = new DeltaState()
  readonly ready: Promise<void>
  readonly dispose: () => void
  module = ''
  manifest?: {
    url: string
    path: string
    chunks: Record<string, Chunk>
    assets?: string[]
  }
  private disposed = false
  private initialized = false
  constructor(
    readonly ctx: Context,
    readonly webui: WebUI,
    readonly files: EntryFiles,
    readonly data: T,
  ) {
    this.dispose = ctx.effect(
      () => () => {
        this.disposed = true
        if (!this.initialized) return
        delete webui.entries[this.id]
        for (const client of Object.values(webui.clients))
          client.subscriptions.delete(this.id)
        webui.broadcast('entry:init', {
          version: webui.version,
          entries: { [this.id]: null },
        })
      },
      'webui-solidjs.addEntry()',
    )
    this.ready = this.initialize().catch((error) => {
      ctx.logger.error(error)
    })
  }
  private async initialize() {
    const name = await packageName(this.files.baseUrl)
    this.module = this.files.client ?? builtinClients[name] ?? name
    boundHistory(this.module, this.data)
    if (!Object.values(builtinClients).includes(this.module)) {
      if (!this.files.client || !this.files.manifest)
        throw new Error(
          'A third-party WebUI entry must declare a Solid client and manifest: ' +
            name,
        )
      this.manifest = {
        url: new URL(this.files.manifest, this.files.baseUrl).href,
        path: this.id,
        chunks: {},
      }
      await this.refreshManifest(false)
    }
    if (this.disposed) return
    this.initialized = true
    this.webui.entries[this.id] = this
    this.webui.broadcast('entry:init', {
      version: this.webui.version,
      entries: { [this.id]: this.toJSON() },
    })
  }
  async refreshManifest(broadcast = true) {
    if (this.manifest) {
      const chunks = JSON.parse(
        await readFile(fileURLToPath(this.manifest.url), 'utf8'),
      )
      if (!chunks || typeof chunks !== 'object')
        throw new Error('Invalid Solid client manifest')
      for (const chunk of Object.values(chunks) as Chunk[]) {
        if (!chunk || typeof chunk.file !== 'string' || !safeAsset(chunk.file))
          throw new Error('Unsafe Solid client manifest asset')
        if (chunk.css?.some((file) => !safeAsset(file)))
          throw new Error('Unsafe Solid client stylesheet')
      }
      if (this.disposed) return
      this.manifest.chunks = chunks
      try {
        const assets: unknown = JSON.parse(
          await readFile(
            new URL('./public-assets.json', this.manifest.url),
            'utf8',
          ),
        )
        if (
          !Array.isArray(assets) ||
          assets.some(
            (file) =>
              typeof file !== 'string' ||
              !file.startsWith('assets/') ||
              !safeAsset(file),
          )
        )
          throw new Error('Unsafe extension asset allowlist')
        this.manifest.assets = assets
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (broadcast && this.initialized && !this.disposed)
      this.webui.broadcast('entry:init', {
        version: this.webui.version,
        entries: { [this.id]: this.toJSON() },
      })
  }
  mutate(fn: (data: T) => void) {
    if (this.disposed || !this.data) return
    const mutation = observe(this.data, (value) => {
      fn(value)
      boundHistory(this.module, value)
    })
    if (!mutation) return
    const delta = this.state.dump(mutation)
    if (this.initialized)
      this.webui.broadcast('entry:delta', { id: this.id, ...delta })
  }
  toJSON(): EntryMeta {
    return {
      module: this.module,
      routes: this.files.routes ?? [],
      files: this.webui.getEntryFiles(this),
      entryId: this.ctx.get('loader')?.locate(),
      methods: Object.keys(this.data ?? {}).filter(
        (key) =>
          typeof (this.data as Record<string, unknown>)[key] === 'function',
      ),
    }
  }
  snapshot(): Snapshot {
    return { id: this.id, data: this.data, cursor: this.state.snapshot() }
  }
}
export function safeAsset(file: string): boolean {
  return (
    !!file &&
    !file.startsWith('/') &&
    !file.includes('\\') &&
    !file.includes(':') &&
    !file.includes('?') &&
    !file.includes('#') &&
    file.split('/').every((part) => part !== '..' && part !== '.' && !!part)
  )
}
