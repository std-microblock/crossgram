import { Service, type Context } from 'cordis'
import type {} from '@cordisjs/plugin-server'
import type {} from '@cordisjs/plugin-hmr'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToRegexp } from 'path-to-regexp'
import z from 'schemastery'
import { sharedModules } from './imports.js'
import { Client, type Socket } from './client.js'
import { Entry, safeAsset } from './entry.js'
import { PROTOCOL_VERSION, type EntryFiles } from './protocol.js'

declare module 'cordis' {
  interface Context {
    webui: SolidWebUI
  }
  interface EnvData {
    clientCount?: number
  }
  interface Events {
    'webui/connection'(this: SolidWebUI, client: Client): void
  }
}
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
const MISSING_BUILD_SHELL = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Crossgram WebUI not built</title></head><body style="margin:0;font-family:system-ui;background:#f8f9f1;color:#20241c"><main style="max-width:40rem;margin:12vh auto;padding:2rem"><h1 style="font-weight:500">The WebUI bundle is missing</h1><p>This server was started without its Solid WebUI build. Run <code>yarn build:webui</code> in the Crossgram checkout and restart the service.</p><p>All relay and platform services are unaffected; only this interface is unavailable.</p></main></body></html>`
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
  buildId = ''
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
    // A missing build must not crash-loop the whole application: serve a diagnosable page instead.
    let manifest: Record<
      string,
      { file: string; css?: string[]; assets?: string[] }
    >
    try {
      manifest = JSON.parse(
        await readFile(resolve(this.root, '.vite/manifest.json'), 'utf8'),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.ctx.logger.warn(
        'WebUI assets are missing from %C; run "yarn build:webui" before starting',
        this.root,
      )
      this.shell = MISSING_BUILD_SHELL
      this.serveRoutes()
      return
    }
    // Only exact build-manifest assets are served. Never fall through into filesystem paths.
    for (const chunk of Object.values(manifest)) {
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
    this.buildId = createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex')
      .slice(0, 16)
    const config = escapeScriptJSON({
      buildId: this.buildId,
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
    this.serveRoutes()
  }

  private serveRoutes() {
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
    const chunks = entry.manifest.chunks
    // Vite hoists shared code and its stylesheet into a separate chunk, so walk the static
    // import graph from the entry instead of trusting the entry chunk's own css list.
    const files: string[] = []
    const seen = new Set<string>()
    const visit = (key: string, includeScript: boolean) => {
      if (seen.has(key)) return
      seen.add(key)
      const chunk = chunks[key]
      if (!chunk) return
      if (includeScript) files.push(chunk.file)
      for (const css of chunk.css ?? [])
        if (!files.includes(css)) files.push(css)
      for (const imported of chunk.imports ?? []) visit(imported, false)
    }
    for (const [key, chunk] of Object.entries(chunks))
      if (chunk.isEntry) visit(key, true)
    return files.map(
      (file) => this.config.uiPath + '/-/modules/' + entry.id + '/' + file,
    )
  }
  matchPath(path: string): boolean {
    if (['/', '/settings', '/notifications'].includes(path)) return true
    return Object.values(this.entries).some((entry) =>
      (entry.files.routes ?? entry.pages?.map((page) => page.path) ?? []).some(
        (pattern) => pathToRegexp(pattern).regexp.test(path),
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
