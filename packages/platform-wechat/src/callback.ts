import { createServer, type Server, type Socket } from 'node:net'
import type { ComWeChatCallback } from './types.js'

export interface CallbackServerOptions {
  host: string
  port: number
  maxBytes: number
  maxConnections: number
  onMessage(message: ComWeChatCallback): Promise<void>
  onWarning?: (message: string, error?: unknown) => void
}

export interface CallbackServer {
  close(): Promise<void>
}

export async function startCallbackServer(options: CallbackServerOptions): Promise<CallbackServer> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error(`invalid ComWeChat callback port: ${options.port}`)
  }
  if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new Error(`invalid ComWeChat callback payload limit: ${options.maxBytes}`)
  }
  if (!Number.isInteger(options.maxConnections) || options.maxConnections < 1) {
    throw new Error(`invalid ComWeChat callback connection limit: ${options.maxConnections}`)
  }
  if (!isLoopbackHost(options.host)) {
    throw new Error('ComWeChat callback listener must use a loopback host because callbacks are unauthenticated')
  }

  const sockets = new Set<Socket>()
  const handlers = new Set<Promise<void>>()
  const server = createServer((socket) => {
    if (!isLoopbackAddress(socket.remoteAddress)) {
      warn(options, 'ComWeChat callback rejected from a non-loopback peer')
      socket.destroy()
      return
    }
    if (sockets.size >= options.maxConnections) {
      warn(options, 'ComWeChat callback rejected because the connection limit was reached')
      socket.destroy()
      return
    }
    socket.setTimeout(30_000, () => socket.destroy())
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    const handler = handleSocket(socket, options).catch((error) => {
      warn(options, 'ComWeChat callback handler failed', error)
    })
    handlers.add(handler)
    handler.then(() => handlers.delete(handler))
  })
  await listen(server, options.port, options.host)
  let closing: Promise<void> | undefined
  return {
    close() {
      closing ??= (async () => {
        for (const socket of sockets) socket.destroy()
        await close(server)
        await Promise.all(handlers)
      })()
      return closing
    },
  }
}

async function handleSocket(socket: Socket, options: CallbackServerOptions): Promise<void> {
  const chunks: Buffer[] = []
  let bytes = 0
  let handled = false
  const handle = async () => {
    if (handled) return
    handled = true
    const payload = Buffer.concat(chunks).toString('utf8').trim()
    if (!payload) throw new Error('empty ComWeChat callback payload')
    const parsed: unknown = JSON.parse(payload)
    if (!isObject(parsed)) throw new Error('ComWeChat callback payload must be a JSON object')
    await options.onMessage(parsed)
    socket.end('200 OK')
  }
  try {
    for await (const chunk of socket) {
      const newline = chunk.indexOf(0x0a)
      const accepted = newline < 0 ? chunk : chunk.subarray(0, newline)
      bytes += accepted.length
      if (bytes > options.maxBytes) throw new Error(`ComWeChat callback exceeds ${options.maxBytes} bytes`)
      chunks.push(accepted)
      if (newline >= 0) {
        await handle()
        return
      }
    }
    await handle()
  } catch (error) {
    warn(options, 'ComWeChat callback rejected', error)
    socket.destroy()
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function warn(options: CallbackServerOptions, message: string, error?: unknown): void {
  try {
    options.onWarning?.(message, error)
  } catch {}
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function isObject(value: unknown): value is ComWeChatCallback {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
