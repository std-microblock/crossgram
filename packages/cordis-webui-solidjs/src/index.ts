import { Service, type Context } from 'cordis'
import type {} from '@cordisjs/plugin-server'
import type {} from '@cordisjs/plugin-hmr'
import { readFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToRegexp } from 'path-to-regexp'
import z from 'schemastery'
import { sharedModules } from './imports.js'
import { Client, type Socket } from './client.js'
import { Entry, safeAsset } from './entry.js'
import { PROTOCOL_VERSION, type EntryFiles } from './protocol.js'

export { Entry, Client }
export type { EntryFiles } from './protocol.js'
const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
}
export interface Config {
  uiPath?: string
  apiPath?: string
  title?: string
  heartbeatInterval?: number
  heartbeatTimeout?: number
}
export default class SolidWebUI extends Service {
  static inject = ['server']
  static Config = z.object({
    uiPath: z.string().default(''),
    apiPath: z.string().default('/api'),
    title: z.string().default('Crossgram'),
    heartbeatInterval: z.natural().min(1000).default(30_000),
    heartbeatTimeout: z.natural().min(1000).default(15_000),
  })
  readonly version = PROTOCOL_VERSION
  readonly entries: Record<string, Entry> = Object.create(null)
  readonly clients: Record<string, Client> = Object.create(null)
  readonly config: Required<Config>
  readonly root = fileURLToPath(new URL('../dist/', import.meta.url))
  private assets = new Map<string, Buffer>()
  private shell = ''
  constructor(
    public ctx: Context,
    config: Config = {},
  ) {
    super(ctx, 'webui')
    this.config = {
      uiPath: '',
      apiPath: '/api',
      title: 'Crossgram',
      heartbeatInterval: 30_000,
      heartbeatTimeout: 15_000,
      ...config,
    }
    this.config.uiPath = normalizePath(this.config.uiPath, true)
    this.config.apiPath = normalizePath(this.config.apiPath)
    ctx.effect(
      () => () => {
        for (const client of Object.values(this.clients)) {
          client.dispose()
          client.socket.close(1001, 'Server stopping')
        }
        this.assets.clear()
      },
      'webui-solidjs.connections',
    )
    ctx.on('hmr/change', (url) => {
      for (const entry of Object.values(this.entries))
        if (entry.manifest?.url === url)
          void entry.refreshManifest().catch((error) => ctx.logger.error(error))
    })
  }
  async [Service.init]() {
    const manifest = JSON.parse(
      await readFile(resolve(this.root, '.vite/manifest.json'), 'utf8'),
    )
    const shell = manifest['index.html']
    if (!shell?.file)
      throw new Error(
        'Build cordis-webui-solidjs before starting it (yarn build:webui)',
      )
    // Only exact build-manifest assets are served. Never fall through into filesystem paths.
    for (const chunk of Object.values(manifest) as Array<{
      file: string
      css?: string[]
      assets?: string[]
    }>) {
      for (const file of [
        chunk.file,
        ...(chunk.css ?? []),
        ...(chunk.assets ?? []),
      ]) {
        if (!safeAsset(file))
          throw new Error('Unsafe application build manifest')
        this.assets.set(file, await readFile(resolve(this.root, file)))
      }
    }
    const publicFiles: unknown = JSON.parse(
      await readFile(resolve(this.root, 'public-assets.json'), 'utf8'),
    )
    if (
      !Array.isArray(publicFiles) ||
      publicFiles.some(
        (file) =>
          typeof file !== 'string' ||
          !file.startsWith('assets/') ||
          !safeAsset(file),
      )
    )
      throw new Error('Invalid public asset allowlist')
    for (const file of publicFiles)
      if (!this.assets.has(file))
        this.assets.set(file, await readFile(resolve(this.root, file)))
    const html = await readFile(resolve(this.root, 'index.html'), 'utf8')
    const config = escapeScriptJSON({
      ...this.config,
      endpoint: this.config.apiPath,
      version: this.version,
    })
    const imports = Object.fromEntries(
      Object.entries(sharedModules).map(([name, entry]) => {
        if (!manifest[entry]?.file)
          throw new Error('Missing shared Solid runtime build: ' + name)
        return [name, this.config.uiPath + '/' + manifest[entry].file]
      }),
    )
    this.shell = html
      .replaceAll('="./assets/', '="' + this.config.uiPath + '/assets/')
      .replace(
        '<!--app-config-->',
        '<script type="importmap">' +
          escapeScriptJSON({ imports }) +
          '</script><script>window.SOLID_WEBUI_CONFIG=' +
          config +
          '</script>',
      )
      .replace(
        '<title>Crossgram</title>',
        '<title>' + escapeHTML(this.config.title) + '</title>',
      )
    this.ctx.server.ws(this.config.apiPath, async (req, accept) => {
      // Browser WebSockets carry cookies, so reject cross-origin handshakes by default.
      // Authentication/ACL remains in the existing Cordis server route middleware.
      const origin = req.headers.get('origin')
      if (origin && new URL(origin).host !== req.headers.get('host')) return
      this.accept(await accept())
    })
    this.ctx.server.get('{/*path}', async (req, res, next) => {
      const prior = await next()
      if (prior || res.claimed) return prior
      const prefix = this.config.uiPath
      if (prefix && req.path !== prefix && !req.path.startsWith(prefix + '/'))
        return
      const route = req.path.slice(prefix.length) || '/'
      const name = route.slice(1)
      let content = this.assets.get(name)
      if (!content && name.startsWith('-/modules/')) {
        const [id, ...parts] = name.slice(10).split('/')
        const entry = this.entries[id]
        const file = parts.join('/')
        if (entry?.manifest && safeAsset(file)) {
          const allowed =
            entry.manifest.assets?.includes(file) ||
            Object.values(entry.manifest.chunks).some(
              (chunk) => chunk.file === file || chunk.css?.includes(file),
            )
          if (allowed)
            content = await readFile(
              resolve(dirname(fileURLToPath(entry.manifest.url)), file),
            )
        }
      }
      if (content) {
        res.headers.set(
          'content-type',
          (MIME[extname(name)] ?? 'application/octet-stream') +
            '; charset=utf-8',
        )
        res.headers.set(
          'cache-control',
          name.startsWith('assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        )
        res.headers.set('x-content-type-options', 'nosniff')
        res.body = new Uint8Array(content)
        return
      }
      if (
        name.startsWith('assets/') ||
        name.startsWith('-/') ||
        !req.accepts('text/html')
      ) {
        res.status = 404
        return
      }
      res.status = this.matchPath(route) ? 200 : 404
      res.headers.set('content-type', 'text/html; charset=utf-8')
      res.headers.set('cache-control', 'no-store')
      res.headers.set('x-content-type-options', 'nosniff')
      res.body = this.shell
    })
  }
  accept(socket: Socket) {
    const client = new Client(this, socket)
    if (socket.readyState === 1) this.clients[client.id] = client
    this.connectionChanged(client)
    return client
  }
  connectionChanged(client: Client) {
    const loader = this.ctx.get('loader')
    if (loader)
      loader.envData.clientCount = Object.keys(this.clients).length
      // Event name and calling convention match Cordis' WebUI server integration.
    ;(this.ctx.emit as Function)(this, 'webui/connection', client)
  }
  addEntry<T extends object = never>(files: EntryFiles, data?: T): Entry<T> {
    return new Entry<T>(this.ctx, this, files, data ?? ({} as T))
  }
  getEntryFiles(entry: Entry): string[] {
    if (!entry.manifest) return []
    return Object.values(entry.manifest.chunks)
      .filter((chunk) => chunk.isEntry)
      .flatMap((chunk) =>
        [chunk.file, ...(chunk.css ?? [])].map(
          (file) => this.config.uiPath + '/-/modules/' + entry.id + '/' + file,
        ),
      )
  }
  matchPath(path: string): boolean {
    if (['/', '/settings', '/notifications'].includes(path)) return true
    return Object.values(this.entries).some((entry) =>
      (entry.files.routes ?? []).some((pattern) =>
        pathToRegexp(pattern).regexp.test(path),
      ),
    )
  }
  broadcast(type: string, body: any) {
    const clients = Object.values(this.clients).filter(
      (client) => type !== 'entry:delta' || client.subscriptions.has(body.id),
    )
    if (!clients.length) return
    const payload = JSON.stringify({ type, body })
    for (const client of clients) client.sendRaw(payload)
  }
}
export function normalizePath(value: string, allowRoot = false): string {
  if (allowRoot && (!value || value === '/')) return ''
  if (
    !value.startsWith('/') ||
    /[?#\\<>"\s]/.test(value) ||
    value.split('/').some((part) => part === '..' || part === '.')
  )
    throw new Error('Expected an absolute URL path')
  return value.replace(/\/+$/, '') || '/'
}
export function escapeScriptJSON(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}
function escapeHTML(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
