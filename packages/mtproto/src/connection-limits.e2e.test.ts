import { Context, Service } from 'cordis'
import { connect, type Socket } from 'node:net'
import { once } from 'node:events'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { LogManager } from '@mtcute/core/utils.js'
import { NodePlatform } from '@mtcute/node'
import { Mtproto } from './service.js'
import { generateRsaKeyPair } from './crypto/rsa-keygen.js'

const log = new LogManager('connection-limits-e2e', new NodePlatform()).create('test')
const sockets: Socket[] = []

afterAll(async () => {
  await Promise.all(sockets.map(async (socket) => {
    if (socket.destroyed) return
    const closed = once(socket, 'close')
    socket.destroy()
    await closed
  }))
})

async function open(port: number): Promise<Socket> {
  const socket = connect({ host: '127.0.0.1', port })
  sockets.push(socket)
  await once(socket, 'connect')
  return socket
}

describe('MTProto reconnect-storm resource bounds', () => {
  it('keeps only the newest connections and remains available after a reconnect storm', async () => {
    const ctx = new Context()
    const service = new Mtproto(ctx, {
      port: 0,
      host: '127.0.0.1',
      rsaKey: generateRsaKeyPair(),
      log,
      maxConnections: 4,
      maxConnectionsPerIp: 4,
      connectionIdleTimeoutMs: 0,
    })
    const generator = service[Service.init]()
    const initialized = await generator.next()
    try {
      for (let index = 0; index < 40; index++) await open(service.port)

      await vi.waitFor(() => expect(service.activeConnectionCount).toBe(4))
      expect(sockets.filter((socket) => !socket.destroyed)).toHaveLength(4)

      const newest = sockets.at(-1)!
      newest.write(Buffer.from([0xef]))
      await new Promise(resolve => setTimeout(resolve, 25))
      expect(newest.destroyed).toBe(false)

      const oldestSurvivor = sockets.find((socket) => !socket.destroyed)!
      const closed = once(oldestSurvivor, 'close')
      const replacement = await open(service.port)
      await closed
      await vi.waitFor(() => expect(service.activeConnectionCount).toBe(4))
      expect(replacement.destroyed).toBe(false)
    } finally {
      if (typeof initialized.value === 'function') await initialized.value()
      await generator.return(undefined)
    }
  })
})
