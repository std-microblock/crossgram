import { describe, expect, it } from 'vitest'
import type { MtprotoConnectionScope } from '@mtproto-relay/mtproto'
import { StatisticsCollector } from './collector.js'
import type { RuntimeSnapshot } from './types.js'

describe('StatisticsCollector', () => {
  it('aggregates RPC tails, packets, traffic, slow spikes, source IPs, and time series', () => {
    const collector = createCollector()
    const connection = fakeConnection('conn-1', '::ffff:203.0.113.7')
    collector.recordConnection(connection, 'open', 1_000)
    collector.recordTraffic({ connection, direction: 'received', bytes: 4_096, timestamp: 1_100 })
    collector.recordTraffic({ connection, direction: 'sent', bytes: 2_048, timestamp: 1_200 })
    collector.recordPacket(3, 3_800)
    collector.recordRpc({
      method: 'messages.getHistory', durationMs: 12, connectionId: connection.id,
      remoteAddress: connection.remoteAddress, error: false, at: 1_300,
    })
    collector.recordRpc({
      method: 'messages.sendMessage', durationMs: 1_250, connectionId: connection.id,
      remoteAddress: connection.remoteAddress, error: true, at: 1_400,
    })

    const snapshot = collector.sample(runtime(), 2, 2_000)
    expect(snapshot).toMatchObject({
      activeConnections: 1,
      totalConnections: 1,
      rpc: { count: 2, errors: 1, errorRate: 0.5, maxMs: 1_250 },
      packets: { count: 1, bytes: 3_800 },
      traffic: {
        receivedBytes: 4_096, sentBytes: 2_048,
        receivedBytesPerSecond: 2_048, sentBytesPerSecond: 1_024,
      },
    })
    expect(snapshot.methods[0]).toMatchObject({ method: 'messages.sendMessage', errors: 1 })
    expect(snapshot.ips).toEqual([expect.objectContaining({
      address: '203.0.113.7', activeConnections: 1, rpcCount: 2,
      receivedBytesPerSecond: 2_048, sentBytesPerSecond: 1_024,
    })])
    expect(snapshot.slowest[0]).toMatchObject({ method: 'messages.sendMessage', durationMs: 1_250 })
    expect(collector.series.seconds).toHaveLength(1)
    expect(collector.series.seconds[0]).toMatchObject({ rpcCount: 2, rpcErrors: 1 })

    collector.recordConnection(connection, 'close', 2_100)
    expect(collector.snapshot(runtime()).activeConnections).toBe(0)
  })

  it('retains bounded second history and resets counters without losing live connections', () => {
    const collector = createCollector({ secondRetention: 2 })
    const connection = fakeConnection('conn-live', '127.0.0.1')
    collector.recordConnection(connection, 'open')
    collector.sample(runtime(), 1, 1_000)
    collector.sample(runtime(), 1, 2_000)
    collector.sample(runtime(), 1, 3_000)
    expect(collector.series.seconds.map(point => point.at)).toEqual([2_000, 3_000])

    collector.reset(4_000)
    expect(collector.snapshot(runtime())).toMatchObject({
      startedAt: 4_000, activeConnections: 1, totalConnections: 1,
      rpc: { count: 0 }, traffic: { receivedBytes: 0, sentBytes: 0 },
    })
    expect(collector.series.seconds).toEqual([])
  })

  it('rolls completed wall-clock minutes and hours into long-term reports', () => {
    const collector = createCollector()
    collector.recordRpc({
      method: 'ping', durationMs: 8, connectionId: 'direct', error: false, at: 59_000,
    })
    collector.sample(runtime(), 1, 59_999)
    collector.sample(runtime(), 1, 60_001)
    expect(collector.series.minutes).toEqual([expect.objectContaining({ at: 59_999, rpcCount: 1 })])

    collector.sample(runtime(), 1, 3_599_999)
    collector.sample(runtime(), 1, 3_600_001)
    expect(collector.series.hours).toEqual([expect.objectContaining({ at: 3_599_999, rpcCount: 1 })])
  })
})

function createCollector(overrides: Partial<ConstructorParameters<typeof StatisticsCollector>[0]> = {}) {
  return new StatisticsCollector({
    slowThresholdMs: 1_000, topMethods: 20, topIps: 20, secondRetention: 60, ...overrides,
  })
}

function fakeConnection(id: string, remoteAddress: string): MtprotoConnectionScope {
  return { id, remoteAddress, remotePort: 443, connection: {} as never, session: {} as never }
}

function runtime(): RuntimeSnapshot {
  return {
    cpuPercent: 12.5, rssBytes: 100, heapUsedBytes: 50, heapTotalBytes: 80,
    externalBytes: 5, arrayBuffersBytes: 2, eventLoopUtilization: 7,
    eventLoopDelayMeanMs: 1, eventLoopDelayP90Ms: 2, eventLoopDelayP99Ms: 4,
    gcCount: 1, gcDurationMs: 3, uptimeSeconds: 10,
  }
}
