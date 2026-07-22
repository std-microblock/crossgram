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
      throttle: (callback: () => void) => callback,
      effect(callback: () => () => void) {
        cleanups.push(callback())
      },
    }

    apply(ctx as never, { maxEvents: 2 })
    expect(files.routes).toEqual(['/mtproto-debug'])
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
    expect(data.events.map(event => event.name)).toEqual(['second.call', 'third.call'])
    expect(data.dropped).toBe(1)

    await data.pause()
    emit('paused.call')
    expect(data.events.map(event => event.name)).toEqual(['second.call', 'third.call'])
    expect(data.capturing).toBe(false)

    await data.start()
    emit('resumed.call')
    expect(data.events.map(event => event.name)).toEqual(['third.call', 'resumed.call'])
    expect(data.dropped).toBe(2)

    await data.clear()
    expect(data.events).toEqual([])
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
    expect(data.events).toEqual([])
  })
})
