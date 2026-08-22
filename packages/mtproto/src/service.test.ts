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
import { AuthKeyStorePublishedError, MemoryAuthKeyStore } from './session/auth-key-store.js'
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
  authKeyId: Uint8Array | null
  connection: FakeConnection
  acceptsUpdates: boolean
  sendUpdate: ReturnType<typeof vi.fn>
  sendLoginTokenUpdate: ReturnType<typeof vi.fn>
  supersedeLoginToken: ReturnType<typeof vi.fn>
  apiLayer: number | null
  applyApiLayer: ReturnType<typeof vi.fn>
}

function fakeSession(
  authKeyId: Uint8Array | null,
  connection: FakeConnection,
  acceptsUpdates: boolean,
): FakeSession {
  return {
    authKeyId, connection, acceptsUpdates,
    sendUpdate: vi.fn(),
    sendLoginTokenUpdate: vi.fn(() => true),
    supersedeLoginToken: vi.fn(),
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

describe('Mtproto durable revocation recovery', () => {
  it('recovers pending revocations before opening its listening socket', async () => {
    const store = new MemoryAuthKeyStore()
    let releaseRecovery!: () => void
    const recoveryGate = new Promise<void>(resolve => { releaseRecovery = resolve })
    let markRecoveryStarted!: () => void
    const recoveryStarted = new Promise<void>(resolve => { markRecoveryStarted = resolve })
    vi.spyOn(store, 'recoverPendingRevocations').mockImplementation(async () => {
      markRecoveryStarted()
      await recoveryGate
    })
    const ctx = new Context()
    const service = new Mtproto(ctx, {
      port: 0, host: '127.0.0.1', rsaKey: generateRsaKeyPair(), log, authKeyStore: store,
    })
    const generator = service[Service.init]()
    const initializing = generator.next()

    await recoveryStarted
    expect((service as unknown as { _server: unknown })._server).toBeNull()
    releaseRecovery()
    const initialized = await initializing
    try {
      expect(service.port).toBeGreaterThan(0)
    } finally {
      if (typeof initialized.value === 'function') await initialized.value()
      await generator.return(undefined)
    }
  })

  it('warns but starts fail-closed when pending revocation recovery fails', async () => {
    const store = new MemoryAuthKeyStore()
    store.save(authKeyA, { key: new Uint8Array(256).fill(1) })
    store.beginRevocation(authKeyA)
    vi.spyOn(store, 'recoverPendingRevocations').mockImplementation(() => {
      throw new Error('recovery failed')
    })
    const logger = {
      warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn(),
    }
    const ctx = new Context()
    const service = new Mtproto(ctx, {
      port: 0, host: '127.0.0.1', rsaKey: generateRsaKeyPair(), authKeyStore: store,
      log: logger as never,
    })
    const generator = service[Service.init]()
    const initialized = await generator.next()
    try {
      expect(service.port).toBeGreaterThan(0)
      expect(logger.warn).toHaveBeenCalledWith(
        'failed to recover pending auth key revocations: %s',
        'recovery failed',
      )
      await expect(service.hasAuthKey(authKeyA)).resolves.toBe(false)
    } finally {
      if (typeof initialized.value === 'function') await initialized.value()
      await generator.return(undefined)
    }
  })

  it('closes a sibling before the gated logout response settles, then closes its origin on finish', async () => {
    const store = new MemoryAuthKeyStore()
    store.save(authKeyA, { key: new Uint8Array(256).fill(1) })
    const { service, stop } = await makeService()
    try {
      const origin = fakeSession(authKeyA, fakeConnection(0), true)
      const sibling = fakeSession(authKeyA, fakeConnection(0), true)
      const unrelated = fakeSession(authKeyB, fakeConnection(0), true)
      sessionsOf(service).add(origin)
      sessionsOf(service).add(sibling)
      sessionsOf(service).add(unrelated)
      ;(service as unknown as { _authKeyStore: MemoryAuthKeyStore })._authKeyStore = store
      let releaseResponseWrite!: () => void
      const responseWrite = new Promise<void>(resolve => { releaseResponseWrite = resolve })

      await service.beginAuthKeyRevocation(authKeyA, origin.connection as unknown as ServerConnection)

      expect(origin.connection.close).not.toHaveBeenCalled()
      expect(sibling.connection.close).toHaveBeenCalledOnce()
      expect(unrelated.connection.close).not.toHaveBeenCalled()
      await expect(service.hasAuthKey(authKeyA)).resolves.toBe(false)

      releaseResponseWrite()
      await responseWrite
      await service.finishAuthKeyRevocation(authKeyA)
      expect(origin.connection.close).toHaveBeenCalledOnce()
    } finally {
      await stop()
    }
  })

  it('closes even the origin when directory sync fails after publishing a tombstone', async () => {
    const store = new MemoryAuthKeyStore()
    store.save(authKeyA, { key: new Uint8Array(256).fill(1) })
    const originalBegin = store.beginRevocation.bind(store)
    vi.spyOn(store, 'beginRevocation').mockImplementation((id) => {
      originalBegin(id)
      throw new AuthKeyStorePublishedError(new Error('directory fsync failed'), 'post-rename')
    })
    const { service, stop } = await makeService()
    try {
      const origin = fakeSession(authKeyA, fakeConnection(0), true)
      const sibling = fakeSession(authKeyA, fakeConnection(0), true)
      sessionsOf(service).add(origin)
      sessionsOf(service).add(sibling)
      ;(service as unknown as { _authKeyStore: MemoryAuthKeyStore })._authKeyStore = store

      await expect(service.beginAuthKeyRevocation(authKeyA, origin.connection as unknown as ServerConnection))
        .rejects.toBeInstanceOf(AuthKeyStorePublishedError)

      expect(origin.connection.close).toHaveBeenCalledOnce()
      expect(sibling.connection.close).toHaveBeenCalledOnce()
      await expect(service.hasAuthKey(authKeyA)).resolves.toBe(false)
    } finally {
      await stop()
    }
  })

  it('keeps connections open when begin fails before publication', async () => {
    const store = new MemoryAuthKeyStore()
    vi.spyOn(store, 'beginRevocation').mockImplementation(() => { throw new Error('file fsync failed') })
    const { service, stop } = await makeService()
    try {
      const origin = fakeSession(authKeyA, fakeConnection(0), true)
      const sibling = fakeSession(authKeyA, fakeConnection(0), true)
      sessionsOf(service).add(origin)
      sessionsOf(service).add(sibling)
      ;(service as unknown as { _authKeyStore: MemoryAuthKeyStore })._authKeyStore = store

      await expect(service.beginAuthKeyRevocation(authKeyA, origin.connection as unknown as ServerConnection))
        .rejects.toThrow('file fsync failed')

      expect(origin.connection.close).not.toHaveBeenCalled()
      expect(sibling.connection.close).not.toHaveBeenCalled()
    } finally {
      await stop()
    }
  })
})

describe('Mtproto stalled-connection handling', () => {
  it('reports open and authorized connection counts for management consumers', async () => {
    const { service, stop } = await makeService()
    try {
      const authorized = fakeSession(authKeyA, fakeConnection(0), true)
      const unauthorized = fakeSession(null as unknown as Uint8Array, fakeConnection(0), false)
      sessionsOf(service).add(authorized)
      sessionsOf(service).add(unauthorized)

      expect(service.activeConnectionCount).toBe(2)
      expect(service.authorizedConnectionCount).toBe(1)
    } finally {
      await stop()
    }
  })

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

  it('sends a QR login approval notification only to matching eligible connections', async () => {
    const { service, stop } = await makeService()
    try {
      const token = new Uint8Array(32).fill(7)
      const first = fakeSession(authKeyA, fakeConnection(0), false)
      const second = fakeSession(authKeyA, fakeConnection(0), false)
      const rejected = fakeSession(authKeyA, fakeConnection(0), false)
      rejected.sendLoginTokenUpdate.mockReturnValue(false)
      const stalled = fakeSession(authKeyA, fakeConnection(40_000), false)
      const noAuthKey = fakeSession(null, fakeConnection(0), false)
      const otherKey = fakeSession(authKeyB, fakeConnection(0), false)
      sessionsOf(service).add(first)
      sessionsOf(service).add(second)
      sessionsOf(service).add(rejected)
      sessionsOf(service).add(stalled)
      sessionsOf(service).add(noAuthKey)
      sessionsOf(service).add(otherKey)

      expect(service.sendLoginTokenUpdateToAuthKey(authKeyA, token)).toBe(2)
      expect(first.sendLoginTokenUpdate).toHaveBeenCalledWith(token)
      expect(second.sendLoginTokenUpdate).toHaveBeenCalledWith(token)
      expect(rejected.sendLoginTokenUpdate).toHaveBeenCalledWith(token)
      expect(stalled.sendLoginTokenUpdate).not.toHaveBeenCalled()
      expect(noAuthKey.sendLoginTokenUpdate).not.toHaveBeenCalled()
      expect(otherKey.sendLoginTokenUpdate).not.toHaveBeenCalled()
    } finally {
      await stop()
    }
  })

  it('clears a superseded QR token only on other connections with the same key', async () => {
    const { service, stop } = await makeService()
    try {
      const token = new Uint8Array(32).fill(7)
      const origin = fakeSession(authKeyA, fakeConnection(0), false)
      const sibling = fakeSession(authKeyA, fakeConnection(0), false)
      const otherKey = fakeSession(authKeyB, fakeConnection(0), false)
      sessionsOf(service).add(origin)
      sessionsOf(service).add(sibling)
      sessionsOf(service).add(otherKey)

      ;(service as unknown as {
        _supersedeLoginToken(authKeyId: Uint8Array, token: Uint8Array, origin: FakeConnection): void
      })._supersedeLoginToken(authKeyA, token, origin.connection)

      expect(origin.supersedeLoginToken).not.toHaveBeenCalled()
      expect(sibling.supersedeLoginToken).toHaveBeenCalledWith(token)
      expect(otherKey.supersedeLoginToken).not.toHaveBeenCalled()
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
