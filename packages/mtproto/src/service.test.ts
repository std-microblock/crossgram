import { Context, Service } from 'cordis'
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import { LogManager } from '@mtcute/core/utils.js'
import { NodePlatform } from '@mtcute/node'
import { connect as connectTcp } from 'node:net'
import { once } from 'node:events'
import Long from 'long'
import { Mtproto } from './service.js'
import type { ServerRpcContext } from './rpc/context.js'
import { generateRsaKeyPair } from './crypto/rsa-keygen.js'
import type { ServerSession } from './session/server-session.js'
import type { ServerConnection } from './transport/server-connection.js'

const crypto = new NodeCryptoProvider()
const log = new LogManager('test', new NodePlatform()).create('test')

beforeAll(async () => {
  await crypto.initialize?.()
})

afterEach(() => {
  vi.useRealTimers()
})

const authKeyA = new Uint8Array(16).fill(0x61) // "a" × 16
const authKeyB = new Uint8Array(16).fill(0x62) // "b" × 16

interface FakeConnection {
  stalledForMs: number
  bufferedBytes: number
  label: string
  close: ReturnType<typeof vi.fn>
}

function fakeConnection(stalledForMs: number): FakeConnection {
  return {
    stalledForMs, bufferedBytes: 1024, label: '127.0.0.1:1',
    close: vi.fn(),
  }
}

interface FakeSession {
  authKeyId: Uint8Array
  connection: FakeConnection
  acceptsUpdates: boolean
  sendUpdate: ReturnType<typeof vi.fn>
  apiLayer: number | null
  applyApiLayer: ReturnType<typeof vi.fn>
}

function fakeSession(
  authKeyId: Uint8Array,
  connection: FakeConnection,
  acceptsUpdates: boolean,
): FakeSession {
  return {
    authKeyId, connection, acceptsUpdates,
    sendUpdate: vi.fn(),
    apiLayer: 228,
    applyApiLayer: vi.fn(),
  }
}

async function makeService(): Promise<{ ctx: Context, service: Mtproto, stop: () => Promise<void> }> {
  const ctx = new Context()
  const service = new Mtproto(ctx, {
    port: 0, host: '127.0.0.1', rsaKey: generateRsaKeyPair(), log,
  })
  const generator = service[Service.init]()
  const initialized = await generator.next()
  return {
    ctx,
    service,
    stop: async () => {
      if (typeof initialized.value === 'function') await initialized.value()
      await generator.return(undefined)
    },
  }
}

function makeRpcContext(ctx: Context, request: { _: string }): ServerRpcContext {
  const connection = fakeConnection(0) as unknown as ServerConnection
  const connectionScope = {
    id: 'conn-test', connection, session: {} as ServerSession,
    remoteAddress: '127.0.0.1', remotePort: 10000,
  }
  const rpc = ctx.extend({
    mtprotoConnection: connectionScope,
    mtprotoPacket: { connection: connectionScope, sequence: 1, data: new Uint8Array([1]) },
    mtprotoRpc: {
      connection: connectionScope, request, messageId: Long.ONE, receivedAt: Date.now(),
    },
    connection,
    apiLayer: 228,
    authKeyId: new Uint8Array(8).fill(1),
    sessionId: Long.ONE,
    isAuthorized: true,
    sendUpdate: () => {},
    getPlatformData: <T>() => undefined as T,
    setPlatformData: () => {},
  })
  Object.defineProperty(rpc, 'cordis', { value: rpc })
  return rpc as unknown as ServerRpcContext
}

function sessionsOf(service: Mtproto): Set<FakeSession> {
  return (service as unknown as { _sessions: Set<FakeSession> })._sessions
}

describe('Mtproto stalled-connection handling', () => {
  it('sendUpdateToAuthKey skips a stalled connection and delivers on a healthy one', async () => {
    const { service, stop } = await makeService()
    try {
      const stalled = fakeSession(authKeyA, fakeConnection(40_000), true)
      const healthy = fakeSession(authKeyA, fakeConnection(0), true)
      const otherKey = fakeSession(authKeyB, fakeConnection(0), true)
      sessionsOf(service).add(stalled)
      sessionsOf(service).add(healthy)
      sessionsOf(service).add(otherKey)

      const delivered = service.sendUpdateToAuthKey(authKeyA, { _: 'updateShort', update: { _: 'updateConfig' }, date: 0 })

      expect(delivered).toBe(1)
      expect(stalled.sendUpdate).not.toHaveBeenCalled()
      expect(healthy.sendUpdate).toHaveBeenCalledOnce()
      expect(otherKey.sendUpdate).not.toHaveBeenCalled()
    } finally {
      await stop()
    }
  })

  it('sendUpdateToAuthKey returns zero when every candidate connection is stalled', async () => {
    const { service, stop } = await makeService()
    try {
      const stalledA = fakeSession(authKeyA, fakeConnection(40_000), true)
      const stalledB = fakeSession(authKeyA, fakeConnection(60_000), false)
      sessionsOf(service).add(stalledA)
      sessionsOf(service).add(stalledB)

      const delivered = service.sendUpdateToAuthKey(authKeyA, { _: 'updateShort', update: { _: 'updateConfig' }, date: 0 })

      expect(delivered).toBe(0)
      expect(stalledA.sendUpdate).not.toHaveBeenCalled()
      expect(stalledB.sendUpdate).not.toHaveBeenCalled()
    } finally {
      await stop()
    }
  })

  it('broadcastUpdate skips stalled sessions entirely', async () => {
    const { service, stop } = await makeService()
    try {
      const stalled = fakeSession(authKeyA, fakeConnection(45_000), true)
      const healthy = fakeSession(authKeyB, fakeConnection(0), false)
      sessionsOf(service).add(stalled)
      sessionsOf(service).add(healthy)

      service.broadcastUpdate({ _: 'updateShort', update: { _: 'updateConfig' }, date: 0 })

      expect(stalled.sendUpdate).not.toHaveBeenCalled()
      expect(healthy.sendUpdate).toHaveBeenCalledOnce()
    } finally {
      await stop()
    }
  })

  it('reaps connections stalled beyond the timeout on the watch interval', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const { service, stop } = await makeService()
    try {
      const stalled = fakeSession(authKeyA, fakeConnection(0), true)
      sessionsOf(service).add(stalled)

      // First check: not yet stalled — nothing closed.
      vi.advanceTimersByTime(5_000)
      expect(stalled.connection.close).not.toHaveBeenCalled()

      // Connection becomes stalled and stays that way past the 30 s timeout.
      stalled.connection.stalledForMs = 31_000
      vi.advanceTimersByTime(5_000)
      expect(stalled.connection.close).toHaveBeenCalledOnce()

      // A healthy connection is never touched.
      stalled.connection.close.mockClear()
      stalled.connection.stalledForMs = 0
      vi.advanceTimersByTime(10_000)
      expect(stalled.connection.close).not.toHaveBeenCalled()
    } finally {
      await stop()
    }
  })
})

describe('Mtproto Cordis-native RPC pipeline', () => {
  it('dispatches upload.getFile method listeners with Cordis serial semantics', async () => {
    const { ctx, service, stop } = await makeService()
    const order: string[] = []
    const disposeFallback = ctx.on('mtproto/rpc/method', async (method) => {
      if (method !== 'upload.getFile') return
      order.push('fallback')
      return { _: 'boolTrue' } as never
    })
    const disposeProbe = ctx.on('mtproto/rpc/method', async (method) => {
      if (method !== 'upload.getFile') return
      order.push('probe:before')
      await Promise.resolve()
      order.push('probe:after')
      return undefined
    }, { prepend: true })
    const disposeSkipped = ctx.on('mtproto/rpc/method', async (method) => {
      if (method !== 'upload.getFile') return
      order.push('skipped')
      return { _: 'boolFalse' } as never
    })
    const request = { _: 'upload.getFile' } as never

    try {
      await expect(service.dispatch(makeRpcContext(ctx, request), request)).resolves.toEqual({ _: 'boolTrue' })
      expect(order).toEqual(['probe:before', 'probe:after', 'fallback'])
    } finally {
      disposeProbe()
      disposeFallback()
      disposeSkipped()
      await stop()
    }
  })

  it('runs middleware and a method route in a short-lived derived-context fiber', async () => {
    const { ctx, service, stop } = await makeService()
    const order: string[] = []
    let handlerContext: ServerRpcContext | undefined
    const middlewareDispose = ctx.on('mtproto/rpc', async function (request, next) {
      expect(Context.is(this)).toBe(true)
      expect(this.mtprotoRpc.request).toBe(request)
      order.push('middleware:before')
      const result = await next()
      order.push('middleware:after')
      return result
    })
    const routeFiber = ctx.plugin((routeCtx) => {
      routeCtx.mtproto.register('test.echo', async (rpc, request) => {
        handlerContext = rpc
        order.push('handler')
        return { _: 'test.echoResult', value: (request as any).value } as never
      })
    })
    await routeFiber
    try {
      const request = { _: 'test.echo', value: 'hello' } as never
      const parent = makeRpcContext(ctx, request)
      const parentFiber = (parent as unknown as Context).fiber
      const result = await service.dispatch(parent, request)

      expect(result).toEqual({ _: 'test.echoResult', value: 'hello' })
      expect(order).toEqual(['middleware:before', 'handler', 'middleware:after'])
      expect(Context.is(handlerContext)).toBe(true)
      expect((handlerContext as unknown as Context).fiber).not.toBe(parentFiber)
      expect(handlerContext?.mtprotoConnection?.id).toBe('conn-test')
      expect(handlerContext?.mtprotoRpc?.request).toBe(request)
    } finally {
      middlewareDispose()
      await routeFiber.dispose()
      await stop()
    }
  })

  it('removes method routes automatically when their owner fiber unloads', async () => {
    const { ctx, service, stop } = await makeService()
    const routeFiber = ctx.plugin((routeCtx) => {
      routeCtx.mtproto.register('test.lifecycle', async () => ({ _: 'boolTrue' }))
    })
    await routeFiber
    const request = { _: 'test.lifecycle' } as never
    try {
      expect(await service.dispatch(makeRpcContext(ctx, request), request)).toEqual({ _: 'boolTrue' })
      await routeFiber.dispose()
      expect(await service.dispatch(makeRpcContext(ctx, request), request)).toMatchObject({
        _: 'mt_rpc_error', errorMessage: 'METHOD_NOT_IMPLEMENTED: test.lifecycle',
      })
    } finally {
      await routeFiber.dispose()
      await stop()
    }
  })
})

describe('Mtproto connection fibers', () => {
  it('creates a derived connection context and disposes its fiber when the socket closes', async () => {
    const { ctx, service, stop } = await makeService()
    const states: string[] = []
    let openedScope: import('./rpc/context.js').MtprotoConnectionScope | undefined
    const dispose = ctx.on('mtproto/connection', function (scope, state) {
      expect(Context.is(this)).toBe(true)
      expect(this.mtprotoConnection).toBe(scope)
      expect(this.fiber.name).toBe('connectionFiber')
      states.push(state)
      if (state === 'open') openedScope = scope
    })
    const socket = connectTcp({ host: '127.0.0.1', port: service.port })
    try {
      await once(socket, 'connect')
      const connectionFibers = (service as unknown as { _connectionFibers: Map<string, import('cordis').Fiber> })
        ._connectionFibers
      await vi.waitFor(() => expect(connectionFibers.size).toBe(1))
      const connectionFiber = [...connectionFibers.values()][0]
      await connectionFiber.await()
      expect(openedScope?.connection.label).toContain('127.0.0.1')
      socket.destroy()
      await once(socket, 'close')
      await connectionFiber.dispose()
      await vi.waitFor(() => {
        expect(connectionFibers.size).toBe(0)
      })
      await vi.waitFor(() => expect(states).toEqual(['open', 'close']))
    } finally {
      dispose()
      socket.destroy()
      await stop()
    }
  })
})

// Keep the import referenced for type stability of the fixture shape.
void (null as unknown as ServerSession | ServerConnection | undefined)
