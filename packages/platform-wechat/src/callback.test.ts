import { createServer, connect, type Socket } from 'node:net'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startCallbackServer, type CallbackServer } from './callback.js'

const servers: CallbackServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
})

async function unusedPort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to allocate callback port')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

function open(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

async function send(port: number, payload: string): Promise<string> {
  const socket = await open(port)
  const chunks: Buffer[] = []
  socket.on('data', chunk => chunks.push(Buffer.from(chunk)))
  socket.end(payload)
  await once(socket, 'close')
  return Buffer.concat(chunks).toString('utf8')
}

describe('ComWeChat callback server', () => {
  it('acknowledges one JSON object framed with a newline', async () => {
    const onMessage = vi.fn(async () => {})
    const port = await unusedPort()
    const server = await startCallbackServer({ host: '127.0.0.1', port, maxBytes: 1024, maxConnections: 32, onMessage })
    servers.push(server)

    await expect(send(port, '{"msgid":"newline"}\nignored')).resolves.toBe('200 OK')
    expect(onMessage).toHaveBeenCalledExactlyOnceWith({ msgid: 'newline' })
  })

  it('acknowledges one JSON object framed by EOF', async () => {
    const onMessage = vi.fn(async () => {})
    const port = await unusedPort()
    const server = await startCallbackServer({ host: '127.0.0.1', port, maxBytes: 1024, maxConnections: 32, onMessage })
    servers.push(server)

    await expect(send(port, '{"msgid":"eof"}')).resolves.toBe('')
    expect(onMessage).toHaveBeenCalledExactlyOnceWith({ msgid: 'eof' })
  })

  it('rejects malformed JSON without acknowledging it', async () => {
    const onWarning = vi.fn()
    const port = await unusedPort()
    const server = await startCallbackServer({ host: '127.0.0.1', port, maxBytes: 1024, maxConnections: 32, onMessage: async () => {}, onWarning })
    servers.push(server)

    await expect(send(port, '{bad json}\n')).resolves.toBe('')
    await vi.waitFor(() => expect(onWarning).toHaveBeenCalledOnce())
    expect(onWarning.mock.calls[0]?.[0]).toBe('ComWeChat callback rejected')
  })

  it('rejects a JSON array callback without acknowledging it', async () => {
    const onWarning = vi.fn()
    const port = await unusedPort()
    const server = await startCallbackServer({ host: '127.0.0.1', port, maxBytes: 1024, maxConnections: 32, onMessage: async () => {}, onWarning })
    servers.push(server)

    await expect(send(port, '[]\n')).resolves.toBe('')
    await vi.waitFor(() => expect(onWarning).toHaveBeenCalledOnce())
    expect(onWarning.mock.calls[0]?.[1]).toBeInstanceOf(Error)
  })

  it('rejects a callback payload exceeding the configured byte limit', async () => {
    const onWarning = vi.fn()
    const port = await unusedPort()
    const server = await startCallbackServer({ host: '127.0.0.1', port, maxBytes: 8, maxConnections: 32, onMessage: async () => {}, onWarning })
    servers.push(server)

    await expect(send(port, '{"message":"too long"}\n')).resolves.toBe('')
    await vi.waitFor(() => expect(onWarning).toHaveBeenCalledOnce())
    expect(onWarning.mock.calls[0]?.[1]).toMatchObject({ message: 'ComWeChat callback exceeds 8 bytes' })
  })

  it('does not acknowledge a callback until its handler resolves', async () => {
    let release!: () => void
    const handled = new Promise<void>(resolve => { release = resolve })
    let handlerStarted!: () => void
    const started = new Promise<void>(resolve => { handlerStarted = resolve })
    const port = await unusedPort()
    const server = await startCallbackServer({
      host: '127.0.0.1', port, maxBytes: 1024, maxConnections: 32,
      onMessage: async () => {
        handlerStarted()
        await handled
      },
    })
    servers.push(server)
    const socket = await open(port)
    const data = once(socket, 'data')
    socket.write('{"msgid":"backpressure"}\n')
    await started

    const ackedBeforeHandler = await Promise.race([
      data.then(() => true),
      new Promise<boolean>(resolve => setImmediate(() => resolve(false))),
    ])
    expect(ackedBeforeHandler).toBe(false)

    release()
    await expect(data).resolves.toEqual([Buffer.from('200 OK')])
    socket.destroy()
  })

  it('does not finish closing until an accepted callback handler settles', async () => {
    let release!: () => void
    const handled = new Promise<void>(resolve => { release = resolve })
    let handlerStarted!: () => void
    const started = new Promise<void>(resolve => { handlerStarted = resolve })
    const port = await unusedPort()
    const server = await startCallbackServer({
      host: '127.0.0.1', port, maxBytes: 1024, maxConnections: 32,
      onMessage: async () => {
        handlerStarted()
        await handled
      },
    })
    servers.push(server)
    const socket = await open(port)
    socket.write('{"msgid":"close-pending"}\n')
    await started

    const closing = server.close()
    const closedBeforeHandler = await Promise.race([
      closing.then(() => true),
      new Promise<boolean>(resolve => setImmediate(() => resolve(false))),
    ])
    expect(closedBeforeHandler).toBe(false)

    release()
    await expect(closing).resolves.toBeUndefined()
    servers.splice(servers.indexOf(server), 1)
  })

  it('disconnects established callback clients when stopped', async () => {
    const port = await unusedPort()
    const server = await startCallbackServer({ host: '127.0.0.1', port, maxBytes: 1024, maxConnections: 32, onMessage: async () => {} })
    servers.push(server)
    const socket = await open(port)
    const disconnected = once(socket, 'close')

    await server.close()
    await expect(disconnected).resolves.toHaveLength(1)
    servers.splice(servers.indexOf(server), 1)
  })

  it('allows callback servers to be stopped more than once', async () => {
    const port = await unusedPort()
    const server = await startCallbackServer({ host: '127.0.0.1', port, maxBytes: 1024, maxConnections: 32, onMessage: async () => {} })
    servers.push(server)

    await server.close()
    await expect(server.close()).resolves.toBeUndefined()
    servers.splice(servers.indexOf(server), 1)
  })

  it('refuses non-loopback callback listener hosts', async () => {
    await expect(startCallbackServer({ host: '0.0.0.0', port: 23456, maxBytes: 1024, maxConnections: 32, onMessage: async () => {} }))
      .rejects.toThrow('callback listener must use a loopback host')
  })

  it('rejects invalid callback ports', async () => {
    await expect(startCallbackServer({ host: '127.0.0.1', port: 0, maxBytes: 1024, maxConnections: 32, onMessage: async () => {} }))
      .rejects.toThrow('invalid ComWeChat callback port')
  })

  it('rejects invalid callback payload limits', async () => {
    await expect(startCallbackServer({ host: '127.0.0.1', port: 23456, maxBytes: 0, maxConnections: 32, onMessage: async () => {} }))
      .rejects.toThrow('invalid ComWeChat callback payload limit')
  })

  it('rejects idle connections above the limit and admits one after capacity is released', async () => {
    const port = await unusedPort()
    const server = await startCallbackServer({ host: '127.0.0.1', port, maxBytes: 1024, maxConnections: 2, onMessage: async () => {} })
    servers.push(server)
    const first = await open(port)
    const second = await open(port)
    const rejected = await open(port)
    const rejectedClosed = once(rejected, 'close')

    await expect(rejectedClosed).resolves.toHaveLength(1)
    const firstClosed = once(first, 'close')
    first.destroy()
    await firstClosed
    const replacement = await open(port)
    const replacementClosed = once(replacement, 'close')
    replacement.destroy()
    second.destroy()
    await expect(replacementClosed).resolves.toHaveLength(1)
  })

  it('rejects invalid callback connection limits', async () => {
    await expect(startCallbackServer({ host: '127.0.0.1', port: 23456, maxBytes: 1024, maxConnections: 0, onMessage: async () => {} }))
      .rejects.toThrow('invalid ComWeChat callback connection limit')
  })
})
