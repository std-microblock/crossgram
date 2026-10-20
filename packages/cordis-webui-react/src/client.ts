import { randomUUID } from 'node:crypto'
import type WebUI from './index.js'
import {
  MAX_PENDING_RPC,
  MAX_REQUEST_BYTES,
  MAX_SOCKET_BUFFER,
} from './protocol.js'

export interface Socket {
  readonly bufferedAmount: number
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate?(): void
  addEventListener(type: string, listener: (event: any) => void): void
  removeEventListener(type: string, listener: (event: any) => void): void
}
export class Client {
  readonly id = randomUUID()
  readonly subscriptions = new Set<string>()
  private active = true
  private inFlight = new Set<number>()
  constructor(
    readonly webui: WebUI,
    readonly socket: Socket,
  ) {
    socket.addEventListener('message', this.receive)
    socket.addEventListener('close', this.dispose)
    this.send({
      type: 'entry:init',
      body: {
        version: webui.version,
        buildId: webui.buildId,
        reset: true,
        entries: Object.fromEntries(
          Object.values(webui.entries).map((entry) => [
            entry.id,
            entry.toJSON(),
          ]),
        ),
      },
    })
  }
  get ctx() {
    return this.webui.ctx
  }
  send(payload: unknown): boolean {
    if (!this.active || this.socket.readyState !== 1) return false
    return this.sendRaw(JSON.stringify(payload))
  }
  sendRaw(payload: string): boolean {
    if (!this.active || this.socket.readyState !== 1) return false
    if (
      !Number.isFinite(this.socket.bufferedAmount) ||
      this.socket.bufferedAmount + Buffer.byteLength(payload) >
        MAX_SOCKET_BUFFER
    ) {
      this.dispose()
      if (this.socket.terminate) this.socket.terminate()
      else this.socket.close(1013, 'WebUI client is too slow')
      return false
    }
    try {
      this.socket.send(payload)
      return true
    } catch {
      this.dispose()
      this.socket.close()
      return false
    }
  }
  dispose = () => {
    if (!this.active) return
    this.active = false
    this.subscriptions.clear()
    this.inFlight.clear()
    this.socket.removeEventListener('message', this.receive)
    this.socket.removeEventListener('close', this.dispose)
    delete this.webui.clients[this.id]
    this.webui.connectionChanged(this)
  }
  receive = async (event: { data: { toString(): string } }) => {
    if (!this.active) return
    try {
      const text = event.data.toString()
      if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) {
        this.socket.close(1009, 'Request too large')
        return
      }
      const message = JSON.parse(text)
      if (!message || typeof message !== 'object')
        throw new Error('Expected message')
      const { type, body } = message
      if (type === 'ping') {
        this.send({ type: 'pong' })
        return
      }
      if (type === 'entry:subscribe') {
        if (typeof body?.id !== 'string') throw new Error('Expected entry ID')
        const entry = this.webui.entries[body.id]
        if (!entry) {
          this.send({ type: 'entry:missing', body: { id: body.id } })
          return
        }
        this.subscriptions.add(entry.id)
        this.send({ type: 'entry:snapshot', body: entry.snapshot() })
        return
      }
      if (type === 'entry:unsubscribe') {
        this.subscriptions.delete(body?.id)
        return
      }
      if (type !== 'rpc:request') return
      if (
        !Number.isSafeInteger(body?.sn) ||
        body.sn < 0 ||
        typeof body.entryId !== 'string' ||
        typeof body.method !== 'string' ||
        !Array.isArray(body.args)
      )
        throw new Error('Invalid RPC request')
      const { sn, entryId, method, args } = body
      if (this.inFlight.has(sn)) throw new Error('Duplicate RPC serial')
      if (this.inFlight.size >= MAX_PENDING_RPC) {
        this.send({
          type: 'rpc:response',
          body: { sn, ok: false, message: 'Too many pending requests' },
        })
        return
      }
      const entry = this.webui.entries[entryId]
      // Only explicitly exposed own methods are callable; never Object.prototype.
      const fn =
        entry && Object.hasOwn(entry.data ?? {}, method) && entry.data[method]
      if (typeof fn !== 'function') {
        this.send({
          type: 'rpc:response',
          body: { sn, ok: false, message: 'No such method: ' + method },
        })
        return
      }
      this.inFlight.add(sn)
      try {
        const value = await Reflect.apply(fn, entry, args)
        this.send({ type: 'rpc:response', body: { sn, ok: true, value } })
      } catch (error) {
        this.send({
          type: 'rpc:response',
          body: {
            sn,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          },
        })
      } finally {
        this.inFlight.delete(sn)
      }
    } catch {
      this.socket.close(1007, 'Invalid WebUI message')
    }
  }
}
