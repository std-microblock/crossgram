import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MtprotoConnectionScope, MtprotoTrafficSample } from '@mtproto-relay/mtproto'
import { apply } from './index.js'
import type { MtprotoStatisticsData } from './types.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('MTProto statistics Muon entry e2e', () => {
  it('observes Cordis protocol hooks and publishes one batched live report', async () => {
    vi.useFakeTimers()
    const listeners = new Map<string, { listener: Function, options?: unknown }>()
    const cleanups: Array<() => void> = []
    let files!: { routes?: string[] }
    let data!: MtprotoStatisticsData
    let mutations = 0
    const ctx = {
      mtproto: {},
      webui: {
        addEntry(entryFiles: typeof files, value: MtprotoStatisticsData) {
          files = entryFiles
          data = value
          return {
            mutate(callback: (target: MtprotoStatisticsData) => void) {
              mutations++
              callback(data)
            },
          }
        },
      },
      on(name: string, listener: Function, options?: unknown) {
        listeners.set(name, { listener, options })
        return () => listeners.delete(name)
      },
      effect(callback: () => () => void) {
        const cleanup = callback()
        cleanups.push(cleanup)
        return cleanup
      },
    }

    apply(ctx as never, { sampleIntervalMs: 1_000, historySeconds: 60 })
    expect(files.routes).toEqual(['/mtproto-statistics'])
    expect(listeners.get('mtproto/rpc')?.options).toEqual({ prepend: true })
    expect(listeners.get('mtproto/packet')?.options).toEqual({ prepend: true })

    const connection = fakeConnection()
    listeners.get('mtproto/connection')!.listener(connection, 'open')
    listeners.get('mtproto/traffic')!.listener({
      connection, direction: 'received', bytes: 4_096, timestamp: Date.now(),
    } satisfies MtprotoTrafficSample)
    listeners.get('mtproto/traffic')!.listener({
      connection, direction: 'sent', bytes: 2_048, timestamp: Date.now(),
    } satisfies MtprotoTrafficSample)
    await listeners.get('mtproto/packet')!.listener.call(
      { mtprotoConnection: connection },
      { connection, sequence: 1, data: new Uint8Array(128) },
      async () => undefined,
    )
    await listeners.get('mtproto/rpc')!.listener.call(
      { mtprotoConnection: connection },
      { _: 'messages.getHistory' },
      async () => ({ _: 'messages.messages' }),
    )
    await listeners.get('mtproto/rpc')!.listener.call(
      { mtprotoConnection: connection },
      {
        _: 'upload.getFile', offset: 0, limit: 131_072,
        location: { _: 'inputDocumentFileLocation', id: '42', thumbSize: 'm' },
      },
      async () => ({
        _: 'mt_rpc_error', errorCode: 400,
        errorMessage: 'FILE_ID_INVALID',
      }),
    )
    await listeners.get('mtproto/rpc')!.listener.call(
      { mtprotoConnection: connection },
      {
        _: 'messages.faveSticker', unfave: false,
        id: { _: 'inputDocument', id: '77' },
      },
      async () => ({
        _: 'mt_rpc_error', errorCode: 500,
        errorMessage: 'INTERNAL_SERVER_ERROR: addFavEmoji: already exists (1)',
      }),
    )
    await listeners.get('mtproto/rpc')!.listener.call(
      { mtprotoConnection: connection },
      { _: 'unknown.method' },
      async () => ({
        _: 'mt_rpc_error', errorCode: 500,
        errorMessage: 'METHOD_NOT_IMPLEMENTED: unknown.method',
      }),
    )

    expect(mutations).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mutations).toBe(1)
    expect(data.snapshot).toMatchObject({
      activeConnections: 1,
      rpc: { count: 4, errors: 3 },
      packets: { count: 1, bytes: 128 },
      traffic: { receivedBytes: 4_096, sentBytes: 2_048 },
    })
    expect(data.snapshot.methods.find(method => method.method === 'messages.getHistory')).toBeTruthy()
    expect(data.snapshot.methodDistribution).toEqual(expect.arrayContaining([
      { method: 'messages.getHistory', count: 1 },
      { method: 'unknown.method', count: 1 },
    ]))
    expect(data.snapshot.failures).toEqual([
      expect.objectContaining({ count: 1 }),
      expect.objectContaining({ count: 1 }),
      expect.objectContaining({ count: 1 }),
    ])
    expect(data.snapshot.failureReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'upload.getFile', errorCode: 400, errorMessage: 'FILE_ID_INVALID',
      }),
      expect.objectContaining({
        method: 'messages.faveSticker', errorCode: 500,
        errorMessage: 'INTERNAL_SERVER_ERROR: addFavEmoji: already exists (1)',
      }),
    ]))
    expect(data.snapshot.recentFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'upload.getFile',
        requestSummary: 'location=inputDocumentFileLocation, id=42, thumb=m, offset=0, limit=131072',
      }),
      expect.objectContaining({
        method: 'messages.faveSticker',
        requestSummary: 'document=inputDocument, id=77, unfave=false',
      }),
    ]))
    expect(data.snapshot.missingRpcs).toMatchObject({
      count: 1, uniqueMethods: 1,
      methods: [expect.objectContaining({ method: 'unknown.method', count: 1 })],
    })
    expect(data.snapshot.ips[0]).toMatchObject({ address: '198.51.100.8', activeConnections: 1 })
    expect(data.series.seconds).toHaveLength(1)

    await data.reset()
    expect(data.snapshot.rpc.count).toBe(0)
    expect(data.snapshot.activeConnections).toBe(1)
    expect(data.snapshot.failures).toEqual([])
    expect(data.snapshot.failureReasons).toEqual([])
    expect(data.snapshot.recentFailures).toEqual([])
    expect(data.snapshot.missingRpcs).toEqual({ count: 0, uniqueMethods: 0, methods: [] })
    expect(data.series.seconds).toEqual([])
    cleanups.forEach(cleanup => cleanup())
  })
})

function fakeConnection(): MtprotoConnectionScope {
  return {
    id: 'conn-e2e', remoteAddress: '198.51.100.8', remotePort: 443,
    connection: {} as never, session: {} as never,
  }
}
