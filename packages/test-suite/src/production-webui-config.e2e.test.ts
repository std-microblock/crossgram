import { Context } from 'cordis'
import { Loader } from '@cordisjs/plugin-loader'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const root = new URL('../../../', import.meta.url)

describe('production WebUI plugin settings e2e', () => {
  it('serves the plugin settings route and persists edits to a workspace plugin', async () => {
    const work = join(fileURLToPath(root), '_work')
    await mkdir(work, { recursive: true })
    const temp = await mkdtemp(join(work, 'crossgram-webui-config-'))
    await copyFile(join(fileURLToPath(root), 'package.json'), join(temp, 'package.json'))
    const configPath = join(temp, 'app.yml')
    await writeFile(configPath, `
- id: timer
  name: '@cordisjs/plugin-timer'
- id: server
  name: '@cordisjs/plugin-server'
  config:
    host: 127.0.0.1
    port: 0
- id: webui
  name: '@cordisjs/plugin-webui'
- id: loader-webui
  name: '@cordisjs/plugin-loader-webui'
- id: bridge
  name: '@mtproto-relay/bridge'
  disabled: true
  config:
    serverHost: 127.0.0.1
    serverPort: 4430
`, 'utf8')

    const ctx = new Context()
    ctx.baseUrl = root.href
    const loaderFiber = ctx.plugin(Loader)
    let socket: WebSocket | undefined
    try {
      await loaderFiber
      await ctx.loader.create({
        name: '@cordisjs/plugin-include',
        config: { path: pathToFileURL(configPath).href, enableLogs: false },
      })

      const managerEntry = await waitForManagerEntry(ctx)
      expect(managerEntry.files.routes).toContain('/plugins{/*id}')
      const page = await fetch(new URL('/plugins/bridge', ctx.server.baseUrl))
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('<title>Cordis')

      const endpoint = new URL('/api', ctx.server.baseUrl)
      endpoint.protocol = 'ws:'
      socket = new WebSocket(endpoint)
      const initial = await waitForSocketMessage(socket, message => message.type === 'entry:init')
      const serializedManager = initial.body.entries[managerEntry.id]
      expect(serializedManager.methods).toEqual(expect.arrayContaining([
        'updateConfig', 'listConfig',
      ]))
      expect(serializedManager.data.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'bridge', name: '@mtproto-relay/bridge' }),
      ]))

      await rpc(socket, managerEntry.id, 'updateConfig', [{
        id: 'bridge',
        config: { serverHost: '203.0.113.77', serverPort: 5443 },
      }])
      await vi.waitFor(async () => {
        const saved = await readFile(configPath, 'utf8')
        expect(saved).toContain('serverHost: 203.0.113.77')
        expect(saved).toContain('serverPort: 5443')
      })
    } finally {
      socket?.close()
      await Promise.resolve((loaderFiber as any).dispose?.())
      await rm(temp, { recursive: true, force: true })
    }
  })
})

async function waitForManagerEntry(ctx: Context): Promise<any> {
  let entry: any
  await vi.waitFor(() => {
    entry = Object.values(ctx.webui.entries)
      .find((candidate: any) => candidate.files.routes?.includes('/plugins{/*id}'))
    expect(entry).toBeTruthy()
  })
  return entry
}

async function waitForSocketMessage(
  socket: WebSocket,
  predicate: (message: any) => boolean,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebUI socket message timed out')), 5_000)
    const onError = () => finish(reject, new Error('WebUI socket failed'))
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data))
      if (predicate(message)) finish(resolve, message)
    }
    const finish = (callback: (value: any) => void, value: any) => {
      clearTimeout(timer)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('message', onMessage)
      callback(value)
    }
    socket.addEventListener('error', onError)
    socket.addEventListener('message', onMessage)
  })
}

let sequence = 0

async function rpc(socket: WebSocket, entryId: string, method: string, args: unknown[]): Promise<any> {
  const sn = ++sequence
  const response = waitForSocketMessage(socket, message =>
    message.type === 'rpc:response' && message.body.sn === sn)
  socket.send(JSON.stringify({
    type: 'rpc:request',
    body: { sn, entryId, method, args },
  }))
  const message = await response
  if (!message.body.ok) throw new Error(message.body.message)
  return message.body.value
}
