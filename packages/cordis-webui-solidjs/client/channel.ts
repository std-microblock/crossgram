import { batch } from 'solid-js'
import { createStore, produce, reconcile } from 'solid-js/store'
import { apply, DeltaState } from '@cordisjs/muon'
import type {
  EntryMeta,
  EntryDelta,
  Snapshot,
  RpcResponse,
} from '../src/protocol.js'

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
export interface ClientConfig {
  buildId?: string
  endpoint: string
  uiPath: string
  title: string
  heartbeatInterval?: number
  heartbeatTimeout?: number
}
interface Pending {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
export class Channel<T = any> {
  readonly cursor = new DeltaState()
  readonly state: { value: T; ready: boolean }
  private setState: ReturnType<
    typeof createStore<{ value: T; ready: boolean }>
  >[1]
  users = 0
  constructor(readonly id: string) {
    ;[this.state, this.setState] = createStore<{ value: T; ready: boolean }>({
      value: {} as T,
      ready: false,
    })
  }
  snapshot(snapshot: Snapshot) {
    this.cursor.restore(snapshot.cursor)
    batch(() => {
      this.setState('value', reconcile(snapshot.data as T, { key: null }))
      this.setState('ready', true)
    })
  }
  delta(delta: EntryDelta) {
    if (!this.state.ready) throw new Error('Delta arrived before snapshot')
    const mutation = this.cursor.load(delta)
    this.setState(
      produce((state) => {
        state.value = apply(state.value, mutation)
      }),
    )
  }
  invalidate() {
    this.setState('ready', false)
  }
  clear() {
    this.setState({ value: {} as T, ready: false })
  }
}
export class Connection {
  readonly state: {
    status: ConnectionState
    entries: Record<string, EntryMeta>
    error: string
    updateAvailable: boolean
  }
  private setState: ReturnType<typeof createStore<Connection['state']>>[1]
  private channels = new Map<string, Channel>()
  private pending = new Map<number, Pending>()
  private socket?: WebSocket
  private serial = 0
  private retry = 0
  private stopped = true
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private pingTimer?: ReturnType<typeof setInterval>
  private pongTimer?: ReturnType<typeof setTimeout>
  constructor(
    readonly config: ClientConfig,
    private makeSocket = (url: string) => new WebSocket(url),
    private baseURL = globalThis.location?.href ?? 'http://localhost/',
  ) {
    ;[this.state, this.setState] = createStore<Connection['state']>({
      status: 'offline',
      entries: {},
      error: '',
      updateAvailable: false,
    })
  }
  start() {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }
  private connect() {
    if (this.stopped) return
    this.setState('status', this.retry ? 'reconnecting' : 'connecting')
    const url = new URL(this.config.endpoint, this.baseURL)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    let socket: WebSocket
    try {
      socket = this.makeSocket(url.href)
    } catch (error) {
      this.disconnected(String(error))
      return
    }
    this.socket = socket
    socket.onmessage = (event) => {
      if (socket !== this.socket) return
      try {
        this.receive(JSON.parse(String(event.data)))
      } catch (error) {
        this.setState('error', 'State synchronization failed. Reconnecting…')
        socket.close(1002, 'Resynchronize')
      }
    }
    socket.onclose = () => {
      if (socket === this.socket) this.disconnected('Connection lost')
    }
    socket.onerror = () => {
      if (socket === this.socket) socket.close()
    }
  }
  private receive({ type, body }: { type: string; body: any }) {
    if (type === 'pong') {
      clearTimeout(this.pongTimer)
      this.pongTimer = undefined
      return
    }
    if (type === 'entry:init') {
      if (body.version !== 'solid-1') {
        this.setState(
          'error',
          'Incompatible WebUI protocol. Reload after updating.',
        )
        this.stop()
        return
      }
      if (
        this.config.buildId &&
        body.buildId &&
        this.config.buildId !== body.buildId
      ) {
        this.setState('updateAvailable', true)
        this.setState(
          'error',
          'A new WebUI build is available. Your current page is kept open; reload before making further changes.',
        )
        this.stop()
        return
      }
      batch(() => {
        if (body.reset) {
          this.setState('entries', reconcile(body.entries, { key: null }))
          for (const channel of this.channels.values()) channel.invalidate()
          this.setState('status', 'connected')
          this.setState('error', '')
          this.retry = 0
          this.startHeartbeat()
          for (const [id, channel] of this.channels)
            if (channel.users && body.entries[id])
              this.send('entry:subscribe', { id })
        } else {
          for (const [id, entry] of Object.entries(body.entries)) {
            if (entry) {
              this.setState('entries', id, entry as EntryMeta)
              if (this.channels.get(id)?.users)
                this.send('entry:subscribe', { id })
            } else {
              this.setState('entries', id, undefined!)
              this.channels.get(id)?.clear()
            }
          }
        }
      })
      return
    }
    if (type === 'entry:snapshot') {
      const channel = this.channels.get(body.id)
      if (channel?.users) channel.snapshot(body)
      return
    }
    if (type === 'entry:delta') {
      const channel = this.channels.get(body.id)
      if (channel?.users) channel.delta(body)
      return
    }
    if (type === 'entry:missing') {
      this.channels.get(body.id)?.clear()
      return
    }
    if (type === 'rpc:response') {
      const result = body as RpcResponse
      const request = this.pending.get(result.sn)
      if (!request) return
      this.pending.delete(result.sn)
      clearTimeout(request.timer)
      if (result.ok) request.resolve(result.value)
      else
        request.reject(
          new Error('message' in result ? result.message : 'Request failed'),
        )
    }
  }
  acquire<T>(id: string): { channel: Channel<T>; release: () => void } {
    let channel = this.channels.get(id)
    if (!channel) {
      channel = new Channel(id)
      this.channels.set(id, channel)
    }
    channel.users++
    if (channel.users === 1 && this.state.status === 'connected')
      this.send('entry:subscribe', { id })
    let released = false
    return {
      channel,
      release: () => {
        if (released) return
        released = true
        if (--channel.users) return
        if (this.state.status === 'connected')
          this.send('entry:unsubscribe', { id })
        channel.clear()
        this.channels.delete(id)
      },
    }
  }
  rpc<T = unknown>(
    entryId: string,
    method: string,
    args: unknown[] = [],
    timeout = 30_000,
  ): Promise<T> {
    if (this.state.status !== 'connected')
      return Promise.reject(
        new Error('Not connected. Try again when the connection returns.'),
      )
    if (!this.state.entries[entryId]?.methods.includes(method))
      return Promise.reject(new Error('Method unavailable: ' + method))
    if (this.pending.size >= 64)
      return Promise.reject(new Error('Too many pending requests'))
    const sn = ++this.serial
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sn)
        reject(
          new Error(
            'Request timed out. Its server-side outcome is unknown; check before retrying.',
          ),
        )
      }, timeout)
      this.pending.set(sn, { resolve, reject, timer })
      try {
        this.send('rpc:request', { sn, entryId, method, args })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(sn)
        reject(error)
      }
    })
  }
  private send(type: string, body?: unknown) {
    if (this.socket?.readyState !== 1) throw new Error('Connection is not open')
    this.socket.send(JSON.stringify({ type, body }))
  }
  private startHeartbeat() {
    clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      if (this.pongTimer || this.socket?.readyState !== 1) return
      this.send('ping')
      this.pongTimer = setTimeout(
        () => this.socket?.close(4000, 'Heartbeat timeout'),
        this.config.heartbeatTimeout ?? 15_000,
      )
    }, this.config.heartbeatInterval ?? 30_000)
  }
  private disconnected(reason: string) {
    this.socket = undefined
    clearInterval(this.pingTimer)
    clearTimeout(this.pongTimer)
    this.pongTimer = undefined
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(
        new Error(
          reason + '. The operation may have completed; check before retrying.',
        ),
      )
    }
    this.pending.clear()
    for (const channel of this.channels.values()) channel.invalidate()
    if (this.stopped) return
    this.setState('status', 'reconnecting')
    const delay =
      Math.min(30_000, 500 * 2 ** Math.min(this.retry++, 6)) *
      (0.8 + Math.random() * 0.4)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }
  stop() {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    const socket = this.socket
    this.disconnected('Connection closed')
    socket?.close()
    this.setState('status', 'offline')
  }
}
