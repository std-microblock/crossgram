import { describe, expect, it, vi } from 'vitest'
import { Client, type Socket } from './client.js'
import {
  MAX_PENDING_RPC,
  MAX_REQUEST_BYTES,
  MAX_SOCKET_BUFFER,
} from './protocol.js'
import type WebUI from './index.js'

class FakeSocket implements Socket {
  bufferedAmount = 0
  readyState = 1
  frames: any[] = []
  listeners = new Map<string, Set<Function>>()
  send = vi.fn((value: string) => {
    this.frames.push(JSON.parse(value))
  })
  close = vi.fn((code?: number) => {
    this.readyState = 3
    for (const fn of this.listeners.get('close') ?? []) fn({ code })
  })
  terminate = vi.fn(() => this.close(1013))
  addEventListener(type: string, fn: Function) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
  }
  removeEventListener(type: string, fn: Function) {
    this.listeners.get(type)?.delete(fn)
  }
}
function setup(data: Record<string, any> = { count: 0, increment: () => 42 }) {
  const entry = {
    id: 'entry',
    data,
    toJSON: () => ({
      module: 'debug',
      methods: ['increment'],
      files: [],
      routes: [],
    }),
    snapshot: () => ({ id: 'entry', data, cursor: {} }),
  }
  const webui = {
    version: 'solid-1',
    entries: { entry },
    clients: {},
    connectionChanged: vi.fn(),
    ctx: {},
  } as unknown as WebUI
  const socket = new FakeSocket()
  const client = new Client(webui, socket)
  webui.clients[client.id] = client
  const request = (type: string, body?: unknown) =>
    client.receive({ data: JSON.stringify({ type, body }) })
  return { socket, client, webui, entry, request }
}
describe('bounded subscription/RPC transport', () => {
  it('sends metadata without eagerly serializing large or sensitive entry state', () => {
    const { socket } = setup({
      secret: 'never in metadata',
      history: 'x'.repeat(10_000_000),
    })
    expect(socket.frames).toHaveLength(1)
    expect(JSON.stringify(socket.frames)).not.toContain('secret')
    expect(socket.terminate).not.toHaveBeenCalled()
  })
  it('subscribes with a complete snapshot, unsubscribes, and answers heartbeat', async () => {
    const { request, client, socket } = setup()
    await request('entry:subscribe', { id: 'entry' })
    expect(client.subscriptions.has('entry')).toBe(true)
    expect(socket.frames.at(-1).type).toBe('entry:snapshot')
    await request('entry:unsubscribe', { id: 'entry' })
    expect(client.subscriptions.size).toBe(0)
    await request('ping')
    expect(socket.frames.at(-1).type).toBe('pong')
    await request('entry:subscribe', { id: 'missing' })
    expect(socket.frames.at(-1)).toEqual({
      type: 'entry:missing',
      body: { id: 'missing' },
    })
  })
  it('calls only exposed own methods and binds this to the entry', async () => {
    const { request, socket, entry } = setup({
      increment(this: any, amount: number) {
        return this.id + ':' + amount
      },
      explode() {
        throw Error('failure')
      },
    })
    await request('rpc:request', {
      sn: 1,
      entryId: entry.id,
      method: 'increment',
      args: [3],
    })
    expect(socket.frames.at(-1).body).toEqual({
      sn: 1,
      ok: true,
      value: 'entry:3',
    })
    for (const method of ['constructor', 'toString', '__proto__', 'absent']) {
      await request('rpc:request', {
        sn: 2,
        entryId: 'entry',
        method,
        args: [],
      })
      expect(socket.frames.at(-1).body.ok).toBe(false)
    }
    await request('rpc:request', {
      sn: 3,
      entryId: 'entry',
      method: 'explode',
      args: [],
    })
    expect(socket.frames.at(-1).body).toEqual({
      sn: 3,
      ok: false,
      message: 'failure',
    })
  })
  it('closes malformed, oversized and duplicate requests instead of throwing unhandled rejections', async () => {
    for (const data of [
      '{',
      'null',
      JSON.stringify({ type: 'rpc:request', body: { sn: -1 } }),
    ]) {
      const { client, socket } = setup()
      await client.receive({ data })
      expect(socket.close).toHaveBeenCalledWith(1007, expect.any(String))
    }
    const { client, socket } = setup()
    await client.receive({ data: 'x'.repeat(MAX_REQUEST_BYTES + 1) })
    expect(socket.close).toHaveBeenCalledWith(1009, expect.any(String))
    const pending = setup({ wait: () => new Promise(() => {}) })
    void pending.request('rpc:request', {
      sn: 1,
      entryId: 'entry',
      method: 'wait',
      args: [],
    })
    await pending.request('rpc:request', {
      sn: 1,
      entryId: 'entry',
      method: 'wait',
      args: [],
    })
    expect(pending.socket.close).toHaveBeenCalledWith(1007, expect.any(String))
  })
  it('bounds concurrent RPC calls', async () => {
    const { request, socket, client } = setup({
      wait: () => new Promise(() => {}),
    })
    for (let sn = 0; sn < MAX_PENDING_RPC; sn++)
      void request('rpc:request', {
        sn,
        entryId: 'entry',
        method: 'wait',
        args: [],
      })
    await request('rpc:request', {
      sn: MAX_PENDING_RPC,
      entryId: 'entry',
      method: 'wait',
      args: [],
    })
    expect(socket.frames.at(-1).body.message).toBe('Too many pending requests')
    client.dispose()
  })
  it('terminates a slow socket once, releases listeners and stops future sends', () => {
    const { client, socket, webui } = setup()
    socket.bufferedAmount = MAX_SOCKET_BUFFER
    expect(client.send({ type: 'test' })).toBe(false)
    expect(socket.terminate).toHaveBeenCalledTimes(1)
    expect(webui.clients).toEqual({})
    expect(socket.listeners.get('message')?.size).toBe(0)
    client.send({ type: 'again' })
    expect(socket.terminate).toHaveBeenCalledTimes(1)
  })
})
