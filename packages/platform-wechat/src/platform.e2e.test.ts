import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createTcpServer, connect, type Socket } from 'node:net'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import type { IMEvent } from '@mtproto-relay/bridge'
import { ComWeChatPlatform } from './index.js'

interface FakeRequest {
  path: string
  type: string
  body: Record<string, unknown>
}

interface FakeComWeChatOptions {
  waitForCallbackStartResponse?: Promise<void>
  waitForCallbackStopResponse?: Promise<void>
  callbackStartStatus?: () => number
  stopCallbackStatus?: number
}

const closeables: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closeables.splice(0).map(close => close()))
})

async function unusedPort(): Promise<number> {
  const server = createTcpServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to allocate test port')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function startFakeComWeChat(options: FakeComWeChatOptions = {}) {
  const requests: FakeRequest[] = []
  const server = createHttpServer(async (request, response) => {
    const path = request.url ?? ''
    const url = new URL(path, 'http://127.0.0.1')
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const type = url.searchParams.get('type')
    if (request.method !== 'POST' || url.pathname !== '/api/' || !type) {
      response.writeHead(404).end()
      return
    }
    requests.push({ path, type, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    if (type === '9') await options.waitForCallbackStartResponse
    if (type === '10') await options.waitForCallbackStopResponse
    const payload: Record<string, unknown> = {
      '0': { is_login: 1 },
      '1': { data: { wxId: 'self', nickname: 'Self' } },
      '9': { msg: 'ok' },
      '10': { msg: 'ok' },
      '15': { data: [{ wxid: 'friend', wxNickName: 'Friend' }, { wxid: 'room@chatroom', wxNickName: 'Room' }] },
      '25': { members: 'member^G', result: 'OK' },
      '26': { data: { wxNickName: 'Member' } },
    }[type] ?? { msg: 0 }
    response.writeHead(type === '9' ? options.callbackStartStatus?.() ?? 200 : type === '10' ? options.stopCallbackStatus ?? 200 : 200, { 'content-type': 'application/json' })
      .end(JSON.stringify(payload))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to start fake ComWeChat')
  closeables.push(() => closeHttpServer(server))
  return { endpoint: `http://127.0.0.1:${address.port}/api/`, requests }
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

function open(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

async function injectCallback(port: number, callback: Record<string, unknown>): Promise<string> {
  const socket = await open(port)
  const chunks: Buffer[] = []
  socket.on('data', chunk => chunks.push(Buffer.from(chunk)))
  socket.end(`${JSON.stringify(callback)}\n`)
  await once(socket, 'close')
  return Buffer.concat(chunks).toString('utf8')
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for local fake ComWeChat request')
}

describe('ComWeChatPlatform local transport e2e', () => {
  it('round-trips account, dialogs, group members, callback registration, and callback events locally', async () => {
    const fake = await startFakeComWeChat()
    const callbackPort = await unusedPort()
    const platform = new ComWeChatPlatform({ endpoint: fake.endpoint, callbackPort, requestTimeoutMs: 500 })
    const events: IMEvent[] = []

    await expect(platform.getAccount()).resolves.toMatchObject({ user: { id: 'self', firstName: 'Self' } })
    await expect(platform.getDialogs({} as never)).resolves.toMatchObject({
      total: 2, dialogs: [{ conversation: { id: 'friend', kind: 'direct' } }, { conversation: { id: 'room@chatroom', kind: 'group' } }],
    })
    await expect(platform.getConversationMembers({} as never, { id: 'room@chatroom' })).resolves.toMatchObject({
      total: 1, members: [{ user: { id: 'member' } }],
    })
    const unsubscribe = await platform.subscribe({} as never, async event => { events.push(event) })
    await expect(injectCallback(callbackPort, {
      type: 1, msgid: 'inbound-id', sender: 'room@chatroom', wxid: 'member', message: 'from local TCP', timestamp: 1_700_000_000,
    })).resolves.toBe('200 OK')

    expect(events).toMatchObject([{
      type: 'message', conversation: { id: 'room@chatroom', kind: 'group' },
      message: { id: 'inbound-id', senderId: 'member', content: { parts: [{ type: 'text', text: 'from local TCP' }] } },
    }])
    expect(fake.requests).toEqual(expect.arrayContaining([
      { path: '/api/?type=0', type: '0', body: {} },
      { path: '/api/?type=1', type: '1', body: {} },
      { path: '/api/?type=9', type: '9', body: { port: callbackPort } },
      { path: '/api/?type=15', type: '15', body: {} },
      { path: '/api/?type=25', type: '25', body: { chatroom_id: 'room@chatroom' } },
      { path: '/api/?type=26', type: '26', body: { chatroom_id: 'room@chatroom', wxid: 'member' } },
    ]))

    await unsubscribe()
    await waitFor(() => fake.requests.some(request => request.type === '10'))
    expect(fake.requests).toContainEqual({ path: '/api/?type=10', type: '10', body: {} })
    await expect(open(callbackPort)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('waits for the native type-10 unhook before unsubscribe resolves', async () => {
    let releaseCallbackStop!: () => void
    const callbackStop = new Promise<void>(resolve => { releaseCallbackStop = resolve })
    const fake = await startFakeComWeChat({ waitForCallbackStopResponse: callbackStop })
    const callbackPort = await unusedPort()
    const platform = new ComWeChatPlatform({ endpoint: fake.endpoint, callbackPort, requestTimeoutMs: 500 })
    const unsubscribe = await platform.subscribe({} as never, async () => {})

    const unsubscribing = unsubscribe()
    await waitFor(() => fake.requests.some(request => request.type === '10'))
    const stoppedBeforeUnhook = await Promise.race([
      Promise.resolve(unsubscribing).then(() => true),
      new Promise<boolean>(resolve => setImmediate(() => resolve(false))),
    ])
    expect(stoppedBeforeUnhook).toBe(false)

    releaseCallbackStop()
    await expect(unsubscribing).resolves.toBeUndefined()
  })

  it('closes the TCP listener when the best-effort type-10 unhook fails', async () => {
    const fake = await startFakeComWeChat({ stopCallbackStatus: 503 })
    const callbackPort = await unusedPort()
    const warnings: string[] = []
    const platform = new ComWeChatPlatform({ endpoint: fake.endpoint, callbackPort, requestTimeoutMs: 500 }, {
      warn: (format, ...args) => warnings.push(format.replace('%s', String(args[0]))),
    })
    const unsubscribe = await platform.subscribe({} as never, async () => {})

    await unsubscribe()
    await waitFor(() => fake.requests.some(request => request.type === '10'))
    await waitFor(() => warnings.length > 0)

    expect(fake.requests).toContainEqual({ path: '/api/?type=10', type: '10', body: {} })
    expect(warnings).toContain('ComWeChat callback unhook failed: ComWeChat request type 10 returned HTTP 503')
    await expect(open(callbackPort)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('serializes an active disposer with a replacement subscription across an in-flight callback', async () => {
    const fake = await startFakeComWeChat()
    const callbackPort = await unusedPort()
    const platform = new ComWeChatPlatform({ endpoint: fake.endpoint, callbackPort, requestTimeoutMs: 500 })
    let releaseHandler!: () => void
    let handlerStarted!: () => void
    const handlerRelease = new Promise<void>(resolve => { releaseHandler = resolve })
    const handlerEntered = new Promise<void>(resolve => { handlerStarted = resolve })
    const first = await platform.subscribe({} as never, async () => {
      handlerStarted()
      await handlerRelease
    })

    const incoming = injectCallback(callbackPort, { type: 1, msgid: 'blocking', sender: 'friend', message: 'blocking' })
    await handlerEntered
    const disposing = first()
    const secondEvents: IMEvent[] = []
    const second = platform.subscribe({} as never, async event => { secondEvents.push(event) })
    const disposedBeforeHandler = await Promise.race([
      Promise.resolve(disposing).then(() => true),
      new Promise<boolean>(resolve => setImmediate(() => resolve(false))),
    ])
    expect(disposedBeforeHandler).toBe(false)

    releaseHandler()
    await incoming
    await disposing
    const unsubscribeSecond = await second
    expect(fake.requests.map(request => request.type).filter(type => type === '9' || type === '10')).toEqual(['9', '10', '9'])

    await injectCallback(callbackPort, { type: 1, msgid: 'replacement', sender: 'friend', message: 'replacement' })
    expect(secondEvents).toHaveLength(1)
    await first()
    await injectCallback(callbackPort, { type: 1, msgid: 'replacement-again', sender: 'friend', message: 'replacement again' })
    expect(secondEvents).toHaveLength(2)
    await unsubscribeSecond()
  })

  it('recovers lifecycle serialization after a failed type-9 transition', async () => {
    let starts = 0
    const fake = await startFakeComWeChat({ callbackStartStatus: () => ++starts === 1 ? 503 : 200 })
    const callbackPort = await unusedPort()
    const platform = new ComWeChatPlatform({ endpoint: fake.endpoint, callbackPort, requestTimeoutMs: 500 })

    await expect(platform.subscribe({} as never, async () => {})).rejects.toThrow('ComWeChat request type 9 returned HTTP 503')
    const events: IMEvent[] = []
    const unsubscribe = await platform.subscribe({} as never, async event => { events.push(event) })
    await injectCallback(callbackPort, { type: 1, msgid: 'after-failure', sender: 'friend', message: 'after failure' })

    expect(events).toHaveLength(1)
    expect(fake.requests.map(request => request.type).filter(type => type === '9' || type === '10')).toEqual(['9', '10', '9'])
    await unsubscribe()
  })

  it('queues a replacement hook after stopping a paused type-9 request', async () => {
    let releaseCallbackStart!: () => void
    const callbackStart = new Promise<void>(resolve => { releaseCallbackStart = resolve })
    const fake = await startFakeComWeChat({ waitForCallbackStartResponse: callbackStart })
    const callbackPort = await unusedPort()
    const platform = new ComWeChatPlatform({ endpoint: fake.endpoint, callbackPort, requestTimeoutMs: 500 })
    const subscription = platform.subscribe({} as never, async () => {})
    const subscriptionFailure = expect(subscription).rejects.toThrow('callback subscription was stopped before it started')

    await waitFor(() => fake.requests.some(request => request.type === '9'))
    const stopping = platform.stop()
    const stoppedBeforeUnhook = await Promise.race([
      stopping.then(() => true),
      new Promise<boolean>(resolve => setImmediate(() => resolve(false))),
    ])
    expect(stoppedBeforeUnhook).toBe(false)
    releaseCallbackStart()
    await stopping
    const events: IMEvent[] = []
    const replacement = platform.subscribe({} as never, async event => { events.push(event) })

    await subscriptionFailure
    const unsubscribe = await replacement
    await injectCallback(callbackPort, { type: 1, msgid: 'replacement', sender: 'friend', message: 'replacement' })
    expect(events).toHaveLength(1)
    expect(fake.requests.map(request => request.type).filter(type => type === '9' || type === '10')).toEqual(['9', '10', '9'])
    await unsubscribe()
  })

  it('does not reactivate a listener when stop wins over a paused type-9 request', async () => {
    let releaseCallbackStart!: () => void
    const callbackStart = new Promise<void>(resolve => { releaseCallbackStart = resolve })
    const fake = await startFakeComWeChat({ waitForCallbackStartResponse: callbackStart })
    const callbackPort = await unusedPort()
    const platform = new ComWeChatPlatform({ endpoint: fake.endpoint, callbackPort, requestTimeoutMs: 500 })
    const subscription = platform.subscribe({} as never, async () => {})
    const subscriptionFailure = expect(subscription).rejects.toThrow('callback subscription was stopped before it started')

    await waitFor(() => fake.requests.some(request => request.type === '9'))
    const stopping = platform.stop()
    releaseCallbackStart()
    await stopping

    await subscriptionFailure
    await waitFor(() => fake.requests.some(request => request.type === '10'))
    await expect(open(callbackPort)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('leaves only the latest listener active when subscriptions overlap', async () => {
    const fake = await startFakeComWeChat()
    const callbackPort = await unusedPort()
    const platform = new ComWeChatPlatform({ endpoint: fake.endpoint, callbackPort, requestTimeoutMs: 500 })
    const first = await platform.subscribe({} as never, async () => {})
    const replaced = platform.subscribe({} as never, async () => {})
    const replacedExpectation = expect(replaced).rejects.toThrow('callback subscription was replaced before it started')
    const latestEvents: IMEvent[] = []
    const latest = await platform.subscribe({} as never, async event => { latestEvents.push(event) })

    await replacedExpectation
    await first()
    await injectCallback(callbackPort, { type: 1, msgid: 'latest-overlap', sender: 'friend', message: 'latest' })

    expect(latestEvents).toHaveLength(1)
    expect(fake.requests.filter(request => request.type === '9')).toHaveLength(2)
    await latest()
  })

  it('keeps only the latest subscription active when subscriptions are replaced', async () => {
    const fake = await startFakeComWeChat()
    const callbackPort = await unusedPort()
    const platform = new ComWeChatPlatform({ endpoint: fake.endpoint, callbackPort, requestTimeoutMs: 500 })
    const firstEvents: IMEvent[] = []
    const secondEvents: IMEvent[] = []
    const first = await platform.subscribe({} as never, async event => { firstEvents.push(event) })
    const second = await platform.subscribe({} as never, async event => { secondEvents.push(event) })

    await first()
    expect(fake.requests.filter(request => request.type === '10')).toHaveLength(1)
    await injectCallback(callbackPort, { type: 1, msgid: 'latest', sender: 'friend', message: 'latest' })

    expect(firstEvents).toEqual([])
    expect(secondEvents).toHaveLength(1)
    expect(fake.requests.filter(request => request.type === '9')).toHaveLength(2)
    await waitFor(() => fake.requests.filter(request => request.type === '10').length === 1)
    await second()
    await waitFor(() => fake.requests.filter(request => request.type === '10').length === 2)
  })
})
