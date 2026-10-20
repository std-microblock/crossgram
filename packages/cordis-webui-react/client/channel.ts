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
interface Store<T> {
  readonly state: T
  subscribe(listener: () => void): () => void
}
/**
 * Minimal external store so React can subscribe with `useSyncExternalStore`.
 * Mutations replace the state object instead of editing it, which is what the
 * hook compares between renders.
 */
class Observable<T> implements Store<T> {
  private current: T
  private listeners = new Set<() => void>()
  constructor(initial: T) {
    this.current = initial
  }
  get state(): T {
    return this.current
  }
  getSnapshot = (): T => this.current
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  protected set(next: T) {
    this.current = next
    for (const listener of this.listeners) listener()
  }
  protected patch(patch: Partial<T>) {
    this.set({ ...this.current, ...patch })
  }
}
export class Channel<T = any> extends Observable<{ value: T; ready: boolean }> {
  readonly cursor = new DeltaState()
  users = 0
  constructor(readonly id: string) {
    super({ value: {} as T, ready: false })
  }
  snapshot(snapshot: Snapshot) {
    this.cursor.restore(snapshot.cursor)
    this.set({ value: snapshot.data as T, ready: true })
  }
  delta(delta: EntryDelta) {
    // A delta can overtake the snapshot that created the subscription. The
    // snapshot is authoritative and arrives next, so dropping the early delta
    // is safe; a stale cursor (after invalidate/reconnect) still throws so the
    // connection can resubscribe just this entry.
    if (!this.state.ready) return
    const mutation = this.cursor.load(delta)
    this.set({ value: apply(this.state.value, mutation), ready: true })
  }
  invalidate() {
    this.patch({ ready: false })
  }
  clear() {
    this.set({ value: {} as T, ready: false })
  }
}
export interface ConnectionStoreState {
  status: ConnectionState
  entries: Record<string, EntryMeta>
  error: string
  updateAvailable: boolean
}
export class Connection extends Observable<ConnectionStoreState> {
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
    super({ status: 'offline', entries: {}, error: '', updateAvailable: false })
  }
  start() {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }
  private connect() {
    if (this.stopped) return
    this.patch({ status: this.retry ? 'reconnecting' : 'connecting' })
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
        this.patch({
          error:
            'State synchronization failed. Reconnecting…' +
            (error instanceof Error ? ` (${error.message})` : ''),
        })
        // 1002 is a valid wire code but the browser WebSocket API rejects it
        // outside 1000/3000-4999, so use an application code for the resync.
        try {
          socket.close(4002, 'Resynchronize')
        } catch {
          // A close that raced with the transport is already disconnected.
        }
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
      if (body.version !== 'react-1') {
        this.patch({
          error: 'Incompatible WebUI protocol. Reload after updating.',
        })
        this.stop()
        return
      }
      if (
        this.config.buildId &&
        body.buildId &&
        this.config.buildId !== body.buildId
      ) {
        this.patch({
          updateAvailable: true,
          error:
            'A new WebUI build is available. Your current page is kept open; reload before making further changes.',
        })
        this.stop()
        return
      }
      if (body.reset) {
        const entries: Record<string, EntryMeta> = { ...body.entries }
        this.patch({ entries, status: 'connected', error: '' })
        for (const channel of this.channels.values()) channel.invalidate()
        this.retry = 0
        this.startHeartbeat()
        for (const [id, channel] of this.channels)
          if (channel.users && entries[id]) this.send('entry:subscribe', { id })
      } else {
        const entries = { ...this.state.entries }
        for (const [id, entry] of Object.entries(body.entries)) {
          if (entry) {
            entries[id] = entry as EntryMeta
            if (this.channels.get(id)?.users)
              this.send('entry:subscribe', { id })
          } else {
            delete entries[id]
            this.channels.get(id)?.clear()
          }
        }
        this.patch({ entries })
      }
      return
    }
    if (type === 'entry:snapshot') {
      const channel = this.channels.get(body.id)
      if (channel?.users) channel.snapshot(body)
      return
    }
    if (type === 'entry:delta') {
      const channel = this.channels.get(body.id)
      if (!channel?.users) return
      try {
        channel.delta(body)
      } catch {
        // Cursor mismatch: resubscribe this entry only. Killing and rebuilding
        // the whole socket would surface a sync error for one bad delta.
        if (this.state.status === 'connected')
          this.send('entry:subscribe', { id: body.id })
      }
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
  /** Read a channel snapshot without subscribing; undefined before it is acquired. */
  peek<T = any>(id: string): { value: T; ready: boolean } | undefined {
    return this.channels.get(id)?.state as
      | { value: T; ready: boolean }
      | undefined
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
    this.patch({ status: 'reconnecting' })
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
    this.patch({ status: 'offline' })
  }
}
