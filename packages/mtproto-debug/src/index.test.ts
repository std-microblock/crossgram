import { describe, expect, it } from 'vitest'
import type { MtprotoDebugEvent } from '@mtproto-relay/mtproto'
import { apply } from './index.js'
import { flattenChunks } from './chunks.js'
import type { MtprotoDebugData } from './types.js'

describe('MTProto debug Cordis entry', () => {
  it('captures, bounds, pauses, resumes, and clears the live event stream', async () => {
    const listeners = new Set<(event: MtprotoDebugEvent) => void>()
    const cleanups: Array<() => void> = []
    let data!: MtprotoDebugData
    let files!: { routes?: string[] }
    let apiRoute!: { path: string, callback: (req: any, res: any) => Promise<void> }

    const ctx = {
      mtproto: {
        onDebug: {
          add: (listener: (event: MtprotoDebugEvent) => void) => listeners.add(listener),
          remove: (listener: (event: MtprotoDebugEvent) => void) => listeners.delete(listener),
        },
      },
      webui: {
        addEntry(entryFiles: typeof files, value: MtprotoDebugData) {
          files = entryFiles
          data = value
          return { mutate: (callback: (target: MtprotoDebugData) => void) => callback(data) }
        },
      },
      server: {
        get(path: string, callback: (req: any, res: any) => Promise<void>) {
          apiRoute = { path, callback }
        },
      },
      throttle: (callback: () => void) => callback,
      effect(callback: () => () => void) {
        cleanups.push(callback())
      },
    }

    apply(ctx as never, { maxEvents: 2 })
    expect(files.routes).toEqual(['/mtproto-debug'])
    expect(apiRoute.path).toBe('/api/mtproto-debug/events')
    expect(data.capturing).toBe(true)
    expect(listeners.size).toBe(1)

    const emit = (name: string) => {
      const event: MtprotoDebugEvent = {
        direction: 'client->server', phase: 'message', connectionId: 'conn-1',
        timestamp: Date.now(), payload: { _: name },
      }
      for (const listener of listeners) listener(event)
    }

    emit('first.call')
    emit('second.call')
    emit('third.call')
    const response = {
      headers: new Headers(), status: 200, body: undefined as unknown,
      json(value: unknown) { this.body = value },
    }
    await apiRoute.callback({ query: new URLSearchParams('name=third&limit=1') }, response)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.body).toMatchObject({ total: 2, matched: 1, events: [{ name: 'third.call' }] })
    await apiRoute.callback({ query: new URLSearchParams('direction=sideways') }, response)
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'Invalid direction: sideways' })

    await data.pause()
    expect(flattenChunks(data.chunks).map(event => event.name)).toEqual(['second.call', 'third.call'])
    expect(data.dropped).toBe(1)

    emit('paused.call')
    expect(flattenChunks(data.chunks).map(event => event.name)).toEqual(['second.call', 'third.call'])
    expect(data.capturing).toBe(false)

    await data.start()
    emit('resumed.call')
    await data.pause()
    expect(flattenChunks(data.chunks).map(event => event.name)).toEqual(['third.call', 'resumed.call'])
    expect(data.dropped).toBe(2)

    await data.clear()
    expect(flattenChunks(data.chunks)).toEqual([])
    expect(data.dropped).toBe(0)

    cleanups.forEach(cleanup => cleanup())
    expect(listeners.size).toBe(0)
  })

  it('can start in a paused state without retaining traffic', () => {
    const listeners = new Set<(event: MtprotoDebugEvent) => void>()
    let data!: MtprotoDebugData
    const ctx = {
      mtproto: { onDebug: { add: (value: any) => listeners.add(value), remove: () => undefined } },
      webui: {
        addEntry: (_files: unknown, value: MtprotoDebugData) => {
          data = value
          return { mutate: (callback: (target: MtprotoDebugData) => void) => callback(data) }
        },
      },
      server: { get: () => undefined },
      throttle: (callback: () => void) => callback,
      effect: (callback: () => () => void) => callback(),
    }
    apply(ctx as never, { initiallyPaused: true })
    for (const listener of listeners) {
      listener({
        direction: 'client->server', phase: 'connection', connectionId: 'conn-1',
        timestamp: 1, payload: { _: 'connection_opened' },
      })
    }
    expect(data.capturing).toBe(false)
    expect(flattenChunks(data.chunks)).toEqual([])
  })
})
