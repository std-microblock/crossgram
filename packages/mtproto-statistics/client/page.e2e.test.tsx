// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MtprotoStatisticsData } from '../src/types.js'

const rpcState = vi.hoisted(() => ({ data: undefined as unknown as MtprotoStatisticsData }))

vi.mock('@cordisjs/client', async () => {
  const { ref } = await import('vue')
  return { useRpc: () => ref(rpcState.data) }
})

import { StatisticsPage } from './page.js'

describe('MTProto statistics dashboard e2e', () => {
  beforeEach(() => {
    rpcState.data = statisticsData()
  })

  it('renders live overview cards and navigates through RPC, network, and runtime reports', async () => {
    const wrapper = mountPage()
    expect(wrapper.text()).toContain('RPC P90')
    expect(wrapper.text()).toContain('128.0 ms')
    expect(wrapper.text()).toContain('CrossGram RAM')
    expect(wrapper.text()).toContain('messages.getHistory')

    await wrapper.findAll('.statistics-tabs button')[1]!.trigger('click')
    expect(wrapper.text()).toContain('RPC 方法耗时排行')
    expect(wrapper.text()).toContain('错误率')
    expect(wrapper.text()).toContain('RPC 方法占比')
    expect(wrapper.text()).toContain('不存在的 RPC Hit')
    expect(wrapper.text()).toContain('unknown.method')
    expect(wrapper.text()).toContain('RPC 错误明细（按方法与具体原因聚合）')
    expect(wrapper.text()).toContain('upload.getFile')
    expect(wrapper.text()).toContain('FILE_ID_INVALID')
    expect(wrapper.text()).toContain('messages.faveSticker')
    expect(wrapper.text()).toContain('addFavEmoji: already exists (1)')
    expect(wrapper.text()).toContain('最近 RPC 错误样本')
    expect(wrapper.text()).toContain('location=inputDocumentFileLocation')
    expect(wrapper.findAll('.statistics-pie')).toHaveLength(2)

    await wrapper.findAll('.statistics-tabs button')[2]!.trigger('click')
    expect(wrapper.text()).toContain('来源 IP')
    expect(wrapper.text()).toContain('203.0.113.9')
    expect(wrapper.text()).toContain('接收速度')

    await wrapper.findAll('.statistics-tabs button')[3]!.trigger('click')
    expect(wrapper.text()).toContain('文件直连 / 中转比例')
    expect(wrapper.text()).toContain('直连比例')
    expect(wrapper.text()).toContain('50.00%')
    expect(wrapper.text()).toContain('分设备文件路由')
    expect(wrapper.text()).toContain('Pixel 10')
    expect(wrapper.text()).toContain('tdesktop')
    expect(wrapper.findAll('.statistics-pie')).toHaveLength(1)

    await wrapper.findAll('.statistics-tabs button')[4]!.trigger('click')
    expect(wrapper.text()).toContain('事件循环 P99')
    expect(wrapper.text()).toContain('GC 时间')
    expect(wrapper.text()).toContain('Cgroup Anon')
    expect(wrapper.text()).toContain('V8 Malloc')
    wrapper.unmount()
  })

  it('calls the Muon RPC reset action from the toolbar', async () => {
    const wrapper = mountPage()
    await wrapper.get('.statistics-reset').trigger('click')
    expect(rpcState.data.reset).toHaveBeenCalledOnce()
    wrapper.unmount()
  })
})

function mountPage() {
  const Layout = defineComponent({
    setup(_, { slots }) {
      return () => h('div', [slots.header?.(), slots.default?.()])
    },
  })
  return mount(StatisticsPage, { global: { components: { 'k-layout': Layout } } })
}

function statisticsData(): MtprotoStatisticsData {
  const point = {
    at: Date.now(), rpcCount: 8, rpcErrors: 1, rpcP90Ms: 128, rpcP99Ms: 256,
    packetCount: 12, packetP90Ms: 4, receivedBytes: 8_192, sentBytes: 4_096,
    activeConnections: 2, cpuPercent: 24, rssBytes: 128 * 1024 * 1024,
    heapUsedBytes: 64 * 1024 * 1024, externalBytes: 8 * 1024 * 1024,
    arrayBuffersBytes: 4 * 1024 * 1024, cgroupMemoryCurrentBytes: 160 * 1024 * 1024,
    cgroupAnonBytes: 128 * 1024 * 1024, cgroupFileBytes: 16 * 1024 * 1024,
    cgroupSwapBytes: 0, eventLoopDelayP99Ms: 8, gcDurationMs: 2,
  }
  return {
    snapshot: {
      startedAt: Date.now() - 60_000, updatedAt: Date.now(), activeConnections: 2,
      totalConnections: 5,
      rpc: {
        count: 80, averageMs: 42, minMs: 1, maxMs: 900, p50Ms: 32,
        p90Ms: 128, p95Ms: 250, p99Ms: 500, errors: 2, errorRate: 0.025,
      },
      packets: {
        count: 100, averageMs: 2, minMs: 0.1, maxMs: 12, p50Ms: 1,
        p90Ms: 4, p95Ms: 8, p99Ms: 12, bytes: 1_000_000,
      },
      traffic: {
        receivedBytes: 2_000_000, sentBytes: 1_000_000,
        receivedBytesPerSecond: 8_192, sentBytesPerSecond: 4_096,
      },
      runtime: {
        cpuPercent: 24, rssBytes: 128 * 1024 * 1024, heapUsedBytes: 64 * 1024 * 1024,
        heapTotalBytes: 96 * 1024 * 1024, externalBytes: 8 * 1024 * 1024,
        arrayBuffersBytes: 4 * 1024 * 1024, heapLimitBytes: 1024 * 1024 * 1024,
        heapAvailableBytes: 800 * 1024 * 1024, mallocedBytes: 2 * 1024 * 1024,
        peakMallocedBytes: 4 * 1024 * 1024, nativeContexts: 3, detachedContexts: 0,
        cgroupMemoryCurrentBytes: 160 * 1024 * 1024, cgroupMemoryPeakBytes: 192 * 1024 * 1024,
        cgroupMemoryHighBytes: 1400 * 1024 * 1024, cgroupMemoryMaxBytes: 1800 * 1024 * 1024,
        cgroupAnonBytes: 128 * 1024 * 1024, cgroupFileBytes: 16 * 1024 * 1024,
        cgroupKernelBytes: 8 * 1024 * 1024, cgroupShmemBytes: 1024 * 1024,
        cgroupSwapBytes: 0, eventLoopUtilization: 30,
        eventLoopDelayMeanMs: 2, eventLoopDelayP90Ms: 4, eventLoopDelayP99Ms: 8,
        gcCount: 1, gcDurationMs: 2, uptimeSeconds: 3_600,
      },
      methods: [{
        method: 'messages.getHistory', count: 20, averageMs: 80, minMs: 4, maxMs: 900,
        p50Ms: 64, p90Ms: 128, p95Ms: 250, p99Ms: 500, errors: 1,
        errorRate: 0.05, lastSeenAt: Date.now(),
      }],
      methodDistribution: [{ method: 'messages.getHistory', count: 20 }],
      failures: [{
        category: 'not-implemented', errorCode: 500, count: 1,
        rate: 0.0125, lastSeenAt: Date.now(),
      }],
      failureReasons: [{
        method: 'upload.getFile', category: 'bad-request', errorCode: 400,
        errorMessage: 'FILE_ID_INVALID', count: 1, methodErrorRate: 0.5,
        rate: 0.0125, lastSeenAt: Date.now(),
      }, {
        method: 'messages.faveSticker', category: 'internal', errorCode: 500,
        errorMessage: 'INTERNAL_SERVER_ERROR: addFavEmoji: already exists (1)',
        count: 1, methodErrorRate: 1, rate: 0.0125, lastSeenAt: Date.now(),
      }],
      recentFailures: [{
        at: Date.now(), method: 'upload.getFile', errorCode: 400,
        errorMessage: 'FILE_ID_INVALID',
        requestSummary: 'location=inputDocumentFileLocation, id=42, thumb=m, offset=0, limit=131072',
        connectionId: 'conn-2', remoteAddress: '203.0.113.9',
      }],
      missingRpcs: {
        count: 1, uniqueMethods: 1,
        methods: [{ method: 'unknown.method', count: 1, lastSeenAt: Date.now() }],
      },
      fileRoutes: {
        directFiles: 3, relayFiles: 3, totalFiles: 6, directRate: 0.5,
        devices: [{
          deviceModel: 'Pixel 10', systemVersion: 'SDK 36', appVersion: '12.9.0',
          langPack: 'android', apiId: 6, directFiles: 2, relayFiles: 1,
          totalFiles: 3, directRate: 0.67, lastSeenAt: Date.now(),
        }, {
          deviceModel: 'Workstation', systemVersion: 'Windows 11', appVersion: '6.1',
          langPack: 'tdesktop', apiId: 2040, directFiles: 1, relayFiles: 2,
          totalFiles: 3, directRate: 0.33, lastSeenAt: Date.now(),
        }],
      },
      ips: [{
        address: '203.0.113.9', activeConnections: 2, totalConnections: 5,
        receivedBytes: 2_000_000, sentBytes: 1_000_000,
        receivedBytesPerSecond: 8_192, sentBytesPerSecond: 4_096,
        rpcCount: 80, lastSeenAt: Date.now(),
      }],
      slowest: [{
        at: Date.now(), method: 'messages.getHistory', durationMs: 900,
        connectionId: 'conn-1', remoteAddress: '203.0.113.9', error: false,
      }],
    },
    series: { seconds: [point], minutes: [point], hours: [point] },
    reset: vi.fn(async () => undefined),
  }
}
