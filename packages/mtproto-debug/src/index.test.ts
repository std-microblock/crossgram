import { describe, expect, it } from 'vitest'
import type { MtprotoDebugEvent } from '@mtproto-relay/mtproto'
import { apply } from './index.js'
import type { MtprotoDebugData } from './types.js'

describe('MTProto debug Cordis entry', () => {
  it('captures, bounds, pauses, resumes, and clears the live event stream', async () => {
    const listeners = new Set<(event: MtprotoDebugEvent) => void>()
    const cleanups: Array<() => void> = []
    let data!: MtprotoDebugData
    let files!: { routes?: string[] }
    let apiRoute!: { path: string, callback: (req: any, res: any) => Promise<void> }
    const routes: Array<{ method: string, path: string }> = []

    const ctx = {
      mtproto: {},
      webui: {
        addEntry(entryFiles: typeof files, value: MtprotoDebugData) {
          files = entryFiles
          data = value
          return { mutate: (callback: (target: MtprotoDebugData) => void) => callback(data) }
        },
      },
      server: {
        get(path: string, callback: (req: any, res: any) => Promise<void>) {
          routes.push({ method: 'get', path })
          if (path === '/api/mtproto-debug/events') apiRoute = { path, callback }
        },
        post(path: string) {
          routes.push({ method: 'post', path })
        },
        delete(path: string) {
          routes.push({ method: 'delete', path })
        },
      },
      throttle: (callback: () => void) => callback,
      on(name: string, listener: (event: MtprotoDebugEvent) => void) {
        expect(name).toBe('mtproto/debug')
        listeners.add(listener)
        const dispose = () => listeners.delete(listener)
        cleanups.push(dispose)
        return dispose
      },
      effect(callback: () => () => void) {
        cleanups.push(callback())
      },
    }

    apply(ctx as never, { maxEvents: 2 })
    expect(files.routes).toEqual(['/mtproto-debug'])
    expect(apiRoute.path).toBe('/api/mtproto-debug/events')
    expect(data.recordingsApiPath).toBe('/api/mtproto-debug/recordings')
    expect(routes).toEqual([
      { method: 'get', path: '/api/mtproto-debug/events' },
      { method: 'get', path: '/api/mtproto-debug/recordings' },
      { method: 'post', path: '/api/mtproto-debug/recordings' },
      { method: 'get', path: '/api/mtproto-debug/recordings/current' },
      { method: 'get', path: '/api/mtproto-debug/recordings/:id' },
      { method: 'delete', path: '/api/mtproto-debug/recordings/:id' },
    ])
    // `current` must be matched before the `:id` download route.
    const paths = routes.map(route => route.path)
    expect(paths.indexOf('/api/mtproto-debug/recordings/current'))
      .toBeLessThan(paths.indexOf('/api/mtproto-debug/recordings/:id'))
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

    const captured = async () => {
      await apiRoute.callback({ query: new URLSearchParams() }, response)
      return (response.body as { events: Array<{ name: string }> }).events
    }
    expect(data).not.toHaveProperty('chunks')
    expect(data).not.toHaveProperty('events')
    await data.pause()
    expect((await captured()).map(event => event.name)).toEqual(['second.call', 'third.call'])
    expect(data.dropped).toBe(1)

    emit('paused.call')
    expect((await captured()).map(event => event.name)).toEqual(['second.call', 'third.call'])
    expect(data.capturing).toBe(false)

    await data.start()
    emit('resumed.call')
    await data.pause()
    expect((await captured()).map(event => event.name)).toEqual(['third.call', 'resumed.call'])
    expect(data.dropped).toBe(2)

    await data.clear()
    expect(await captured()).toEqual([])
    expect(data.dropped).toBe(0)

    cleanups.forEach(cleanup => cleanup())
    expect(listeners.size).toBe(0)
  })

  it('applies a new buffer size from the page and trims the retained window', async () => {
    const listeners = new Set<(event: MtprotoDebugEvent) => void>()
    const cleanups: Array<() => void> = []
    let data!: MtprotoDebugData
    let apiRoute!: { callback: (req: any, res: any) => Promise<void> }
    const ctx = {
      mtproto: {},
      webui: {
        addEntry: (_files: unknown, value: MtprotoDebugData) => {
          data = value
          return { mutate: (callback: (target: MtprotoDebugData) => void) => callback(data) }
        },
      },
      server: {
        get(path: string, callback: (req: any, res: any) => Promise<void>) {
          if (path === '/api/mtproto-debug/events') apiRoute = { callback }
        },
        post: () => undefined,
        delete: () => undefined,
      },
      throttle: (callback: () => void) => callback,
      on(_name: string, listener: (event: MtprotoDebugEvent) => void) {
        listeners.add(listener)
        const dispose = () => listeners.delete(listener)
        cleanups.push(dispose)
        return dispose
      },
      effect(callback: () => () => void) {
        cleanups.push(callback())
      },
    }

    apply(ctx as never, { maxEvents: 400 })
    const emit = (name: string) => {
      const event: MtprotoDebugEvent = {
        direction: 'client->server', phase: 'message', connectionId: 'conn-1',
        timestamp: Date.now(), payload: { _: name },
      }
      for (const listener of listeners) listener(event)
    }
    for (let index = 0; index < 500; index++) emit('call.' + index)

    // Shrinking flushes the pending batch first, then drops whole chunks from
    // the front, so the retained window never keeps more than the new cap.
    await data.setMaxEvents(100)
    expect(data.maxEvents).toBe(100)
    expect(data.dropped).toBe(400)

    const response = { headers: new Headers(), status: 200, body: undefined as unknown,
      json(value: unknown) { this.body = value } }
    const retained = async () => {
      await apiRoute.callback({ query: new URLSearchParams() }, response)
      return (response.body as { total: number, events: Array<{ name: string }> })
    }
    expect((await retained()).total).toBe(100)

    emit('after.shrink')
    expect((await retained()).total).toBeLessThanOrEqual(100)
    expect(data.dropped).toBeGreaterThan(400)

    await expect(data.setMaxEvents(50)).rejects.toThrow(/between 100 and 20000/)
    await expect(data.setMaxEvents(1.5)).rejects.toThrow(/whole number/)
    await expect(data.setMaxEvents('200' as unknown as number)).rejects.toThrow(/whole number/)
    expect(data.maxEvents).toBe(100)

    cleanups.forEach(cleanup => cleanup())
  })

  it('can start in a paused state without retaining traffic', () => {
    const listeners = new Set<(event: MtprotoDebugEvent) => void>()
    let data!: MtprotoDebugData
    const ctx = {
      mtproto: {},
      webui: {
        addEntry: (_files: unknown, value: MtprotoDebugData) => {
          data = value
          return { mutate: (callback: (target: MtprotoDebugData) => void) => callback(data) }
        },
      },
      server: {
        get: () => undefined,
        post: () => undefined,
        delete: () => undefined,
      },
      throttle: (callback: () => void) => callback,
      on: (_name: string, listener: (event: MtprotoDebugEvent) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
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
    expect(data).not.toHaveProperty('chunks')
    expect(data).not.toHaveProperty('events')
  })
})
