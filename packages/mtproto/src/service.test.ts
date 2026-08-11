import { Context, Service } from 'cordis'
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import { LogManager } from '@mtcute/core/utils.js'
import { NodePlatform } from '@mtcute/node'
import { Mtproto } from './service.js'
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

async function makeService(): Promise<{ service: Mtproto, stop: () => Promise<void> }> {
  const ctx = new Context()
  const service = new Mtproto(ctx, {
    port: 0, host: '127.0.0.1', rsaKey: generateRsaKeyPair(), log,
  })
  const generator = service[Service.init]()
  await generator.next()
  return {
    service,
    stop: async () => { await generator.return(undefined) },
  }
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

// Keep the import referenced for type stability of the fixture shape.
void (null as unknown as ServerSession | ServerConnection | undefined)
