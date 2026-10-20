import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeltaState, observe } from '@cordisjs/muon'
import { Channel, Connection } from './channel.js'

class Socket {
  readyState = 1
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  frames: any[] = []
  closed?: [number | undefined, string | undefined]
  send(data: string) {
    this.frames.push(JSON.parse(data))
  }
  close(code?: number, reason?: string) {
    this.closed = [code, reason]
    this.readyState = 3
    this.onclose?.()
  }
  receive(type: string, body?: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type, body }) })
  }
}
const meta = {
  module: 'debug',
  files: [],
  routes: ['/debug'],
  methods: ['save'],
}
function setup() {
  const sockets: Socket[] = []
  const connection = new Connection(
    {
      endpoint: '/api',
      uiPath: '',
      title: 'Test',
      heartbeatInterval: 1000,
      heartbeatTimeout: 500,
    },
    () => {
      const socket = new Socket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    'https://example.test/',
  )
  connection.start()
  const socket = sockets[0]
  socket.receive('entry:init', {
    version: 'react-1',
    reset: true,
    entries: { test: meta },
  })
  return { connection, socket, sockets }
}
afterEach(() => vi.useRealTimers())
describe('Muon channel store', () => {
  it('applies compressed cursors and all delta kinds, notifying subscribers', () => {
    const source = {
      nested: { value: 1 },
      untouched: 9,
      list: [1, 2],
      text: 'hello',
      optional: true as boolean | undefined,
    }
    const channel = new Channel<typeof source>('test')
    const state = new DeltaState()
    channel.snapshot({
      id: 'test',
      data: structuredClone(source),
      cursor: state.snapshot(),
    })
    let updates = 0
    const unsubscribe = channel.subscribe(() => {
      updates++
    })
    expect(updates).toBe(0)
    const mutate = (fn: (value: typeof source) => void) => {
      const mutation = observe(source, fn)
      if (mutation) channel.delta({ id: 'test', ...state.dump(mutation) })
    }
    mutate((value) => {
      value.nested.value = 2
    })
    expect(updates).toBe(1)
    mutate((value) => {
      value.nested.value = 3
      value.list.push(3, 4)
      value.text += ' world'
    })
    mutate((value) => {
      value.list.length = 1
      delete value.optional
    })
    expect(updates).toBe(3)
    expect(channel.state.value).toEqual(source)
    mutate((value) => {
      value.untouched = 10
    })
    expect(updates).toBe(4)
    channel.invalidate()
    expect(channel.state.ready).toBe(false)
    // Invalidate publishes the "not ready" state to subscribers as well.
    expect(updates).toBe(5)
    // A delta that arrives while the channel waits for a fresh snapshot is
    // dropped; the snapshot that follows is authoritative.
    expect(() =>
      channel.delta({ id: 'test', o: 'SET', p: ['untouched'], v: 2 }),
    ).not.toThrow()
    expect(channel.state.value.untouched).toBe(10)
    unsubscribe()
    expect(updates).toBe(5)
  })
  it('restores compressed cursors after reconnect and replaces stale state', () => {
    const channel = new Channel<any>('test')
    channel.snapshot({
      id: 'test',
      data: { old: true, count: 5 },
      cursor: { p: ['count'], o: 'SET' },
    })
    channel.delta({ id: 'test', v: 6 })
    expect(channel.state.value.count).toBe(6)
    channel.snapshot({
      id: 'test',
      data: { count: 10 },
      cursor: { p: ['count'], o: 'SET' },
    })
    expect(channel.state.value.old).toBeUndefined()
    channel.delta({ id: 'test', v: 11 })
    expect(channel.state.value.count).toBe(11)
  })
  it('exposes a stable snapshot between changes so useSyncExternalStore can compare it', () => {
    const channel = new Channel<{ count: number }>('test')
    channel.snapshot({
      id: 'test',
      data: { count: 1 },
      cursor: { p: ['count'], o: 'SET' },
    })
    const first = channel.getSnapshot()
    expect(channel.getSnapshot()).toBe(first)
    channel.delta({ id: 'test', v: 2 })
    expect(channel.getSnapshot()).not.toBe(first)
    expect(channel.getSnapshot().value).toEqual({ count: 2 })
  })
})
describe('Connection lifecycle', () => {
  it('detects a changed server build without clearing metadata or replaying RPCs', () => {
    const { connection, socket } = setup()
    connection.config.buildId = 'old-build'
    socket.receive('entry:init', {
      version: 'react-1',
      buildId: 'new-build',
      reset: true,
      entries: {},
    })
    expect(connection.state.updateAvailable).toBe(true)
    expect(connection.state.status).toBe('offline')
    expect(connection.state.entries.test).toBeDefined()
    expect(connection.state.error).toContain('new WebUI build')
  })
  it('reference-counts subscriptions and drops large inactive state', () => {
    const { connection, socket } = setup()
    const a = connection.acquire<any>('test'),
      b = connection.acquire('test')
    expect(socket.frames).toEqual([
      { type: 'entry:subscribe', body: { id: 'test' } },
    ])
    socket.receive('entry:snapshot', {
      id: 'test',
      data: { history: 'large' },
      cursor: { p: [], o: 'SET' },
    })
    expect(a.channel.state.ready).toBe(true)
    expect(connection.peek('test')?.ready).toBe(true)
    a.release()
    a.release()
    expect(socket.frames).toHaveLength(1)
    b.release()
    expect(socket.frames.at(-1).type).toBe('entry:unsubscribe')
    expect(a.channel.state.ready).toBe(false)
    expect(a.channel.state.value.history).toBeUndefined()
    expect(connection.peek('test')).toBeUndefined()
    connection.stop()
  })
  it('resolves/rejects RPC replies and bounds pending calls', async () => {
    vi.useFakeTimers()
    const { connection, socket } = setup()
    const result = connection.rpc('test', 'save', [42])
    socket.receive('rpc:response', {
      sn: socket.frames.at(-1).body.sn,
      ok: true,
      value: 'saved',
    })
    await expect(result).resolves.toBe('saved')
    const failed = connection.rpc('test', 'save')
    socket.receive('rpc:response', {
      sn: socket.frames.at(-1).body.sn,
      ok: false,
      message: 'Invalid configuration',
    })
    await expect(failed).rejects.toThrow('Invalid configuration')
    await expect(connection.rpc('test', 'constructor')).rejects.toThrow(
      'unavailable',
    )
    const pending = Array.from({ length: 64 }, () =>
      connection.rpc('test', 'save').catch((error) => error),
    )
    await expect(connection.rpc('test', 'save')).rejects.toThrow('Too many')
    connection.stop()
    expect(
      (await Promise.all(pending)).every((value) => value instanceof Error),
    ).toBe(true)
  })
  it('does not replay mutations, reload the page, or retain stale snapshots during reconnect', async () => {
    vi.useFakeTimers()
    const { connection, socket, sockets } = setup()
    const { channel, release } = connection.acquire('test')
    socket.receive('entry:snapshot', {
      id: 'test',
      data: { count: 3 },
      cursor: { p: ['count'], o: 'SET' },
    })
    const mutation = connection.rpc('test', 'save').catch((error) => error)
    socket.close()
    expect(channel.state.ready).toBe(false)
    expect(connection.state.status).toBe('reconnecting')
    expect(await mutation).toMatchObject({
      message: expect.stringContaining('may have completed'),
    })
    await vi.advanceTimersByTimeAsync(700)
    expect(sockets).toHaveLength(2)
    sockets[1].receive('entry:init', {
      version: 'react-1',
      reset: true,
      entries: { test: meta },
    })
    expect(sockets[1].frames).toEqual([
      { type: 'entry:subscribe', body: { id: 'test' } },
    ])
    sockets[1].receive('entry:snapshot', {
      id: 'test',
      data: { count: 5 },
      cursor: { p: ['count'], o: 'SET' },
    })
    expect(channel.state.value).toEqual({ count: 5 })
    release()
    connection.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sockets).toHaveLength(2)
  })
  it('times out requests with an honest uncertain-outcome error and recovers missed heartbeat', async () => {
    vi.useFakeTimers()
    const { connection, socket } = setup()
    const result = connection
      .rpc('test', 'save', [], 100)
      .catch((error) => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(await result).toMatchObject({
      message: expect.stringContaining('outcome is unknown'),
    })
    await vi.advanceTimersByTimeAsync(900)
    expect(socket.frames.at(-1).type).toBe('ping')
    await vi.advanceTimersByTimeAsync(500)
    expect(connection.state.status).toBe('reconnecting')
    connection.stop()
  })
  it('removes disposed entries, clears snapshots and rejects incompatible protocols', () => {
    const { connection, socket } = setup()
    const { channel, release } = connection.acquire('test')
    socket.receive('entry:snapshot', {
      id: 'test',
      data: { count: 4 },
      cursor: { p: [], o: 'SET' },
    })
    socket.receive('entry:init', {
      version: 'react-1',
      entries: { test: null },
    })
    expect(connection.state.entries.test).toBeUndefined()
    expect(channel.state.ready).toBe(false)
    socket.receive('entry:init', { version: 'incompatible', entries: {} })
    expect(connection.state.status).toBe('offline')
    expect(connection.state.error).toContain('Incompatible')
    release()
  })
  it('drops a delta that overtakes its snapshot without failing the connection', () => {
    const { connection, socket } = setup()
    const { channel, release } = connection.acquire('test')
    socket.receive('entry:delta', { id: 'test', p: ['count'], o: 'SET', v: 1 })
    expect(channel.state.ready).toBe(false)
    expect(connection.state.error).toBe('')
    expect(connection.state.status).toBe('connected')
    socket.receive('entry:snapshot', {
      id: 'test',
      data: { count: 4 },
      cursor: { p: [], o: 'SET' },
    })
    expect(channel.state.value).toEqual({ count: 4 })
    release()
    connection.stop()
  })
  it('resynchronizes malformed frames with a browser-valid close code', () => {
    const { connection, socket } = setup()
    socket.onmessage?.({ data: '{not json' })
    // Browsers reject close codes outside 1000/3000-4999, so never use 1002.
    expect(socket.closed).toEqual([4002, 'Resynchronize'])
    expect(connection.state.error).toContain('State synchronization failed')
    connection.stop()
  })
})
