import type { MtprotoConnectionScope, MtprotoTrafficSample } from '@mtproto-relay/mtproto'
import { LatencyHistogram } from './histogram.js'
import type {
  IpSnapshot, MissingRpcSnapshot, RpcFailureCategory, RpcFailureSnapshot, RpcMethodCountSnapshot, RpcMethodSnapshot,
  RpcFailureReasonSnapshot, RpcFailureSample, RuntimeSnapshot, SlowRpcSample,
  StatisticsPoint, StatisticsSeries, StatisticsSnapshot,
} from './types.js'

interface MethodState {
  histogram: LatencyHistogram
  errors: number
  lastSeenAt: number
}

interface IpState {
  activeConnections: number
  totalConnections: number
  receivedBytes: number
  sentBytes: number
  intervalReceivedBytes: number
  intervalSentBytes: number
  rpcCount: number
  lastSeenAt: number
}

interface RpcFailureState {
  category: RpcFailureCategory
  errorCode: number
  count: number
  lastSeenAt: number
}

interface RpcFailureReasonState extends RpcFailureState {
  method: string
  errorMessage: string
}

export interface CollectorOptions {
  slowThresholdMs: number
  topMethods: number
  topIps: number
  secondRetention: number
}

const EMPTY_RUNTIME: RuntimeSnapshot = {
  cpuPercent: 0, rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0, externalBytes: 0,
  arrayBuffersBytes: 0, heapLimitBytes: 0, heapAvailableBytes: 0, mallocedBytes: 0,
  peakMallocedBytes: 0, nativeContexts: 0, detachedContexts: 0,
  cgroupMemoryCurrentBytes: 0, cgroupMemoryPeakBytes: 0, cgroupMemoryHighBytes: 0,
  cgroupMemoryMaxBytes: 0, cgroupAnonBytes: 0, cgroupFileBytes: 0,
  cgroupKernelBytes: 0, cgroupShmemBytes: 0, cgroupSwapBytes: 0,
  eventLoopUtilization: 0, eventLoopDelayMeanMs: 0,
  eventLoopDelayP90Ms: 0, eventLoopDelayP99Ms: 0, gcCount: 0, gcDurationMs: 0,
  uptimeSeconds: 0,
}

const MAX_FAILURE_REASONS = 2_048
const MAX_RECENT_FAILURES = 100
const MAX_ERROR_MESSAGE_LENGTH = 500

export class StatisticsCollector {
  readonly series: StatisticsSeries = { seconds: [], minutes: [], hours: [] }
  private startedAt = Date.now()
  private readonly rpc = new LatencyHistogram()
  private readonly packet = new LatencyHistogram()
  private readonly intervalRpc = new LatencyHistogram()
  private readonly intervalPacket = new LatencyHistogram()
  private readonly methods = new Map<string, MethodState>()
  private readonly failures = new Map<string, RpcFailureState>()
  private readonly failureReasons = new Map<string, RpcFailureReasonState>()
  private readonly missingRpcs = new Map<string, { count: number, lastSeenAt: number }>()
  private readonly ips = new Map<string, IpState>()
  private readonly connections = new Map<string, string>()
  private readonly slowest: SlowRpcSample[] = []
  private readonly recentFailures: RpcFailureSample[] = []
  private rpcErrors = 0
  private missingRpcCount = 0
  private intervalRpcErrors = 0
  private packetBytes = 0
  private receivedBytes = 0
  private sentBytes = 0
  private intervalReceivedBytes = 0
  private intervalSentBytes = 0
  private totalConnections = 0
  private minuteBucket: StatisticsPoint[] = []
  private hourBucket: StatisticsPoint[] = []
  private minuteKey = -1
  private hourKey = -1
  private currentIntervalSeconds = 1

  constructor(private readonly options: CollectorOptions) {}

  recordConnection(connection: MtprotoConnectionScope, state: 'open' | 'close', at = Date.now()): void {
    const address = normalizeAddress(connection.remoteAddress)
    const ip = this.ip(address, at)
    if (state === 'open') {
      if (this.connections.has(connection.id)) return
      this.connections.set(connection.id, this.ips.has(address) ? address : 'other')
      ip.activeConnections++
      ip.totalConnections++
      this.totalConnections++
    } else {
      const known = this.connections.get(connection.id)
      if (!known) return
      this.connections.delete(connection.id)
      const knownIp = this.ips.get(known)
      if (knownIp) knownIp.activeConnections = Math.max(0, knownIp.activeConnections - 1)
    }
    ip.lastSeenAt = at
  }

  recordTraffic(sample: MtprotoTrafficSample): void {
    const address = normalizeAddress(sample.connection.remoteAddress)
    const ip = this.ip(address, sample.timestamp)
    if (sample.direction === 'received') {
      this.receivedBytes += sample.bytes
      this.intervalReceivedBytes += sample.bytes
      ip.receivedBytes += sample.bytes
      ip.intervalReceivedBytes += sample.bytes
    } else {
      this.sentBytes += sample.bytes
      this.intervalSentBytes += sample.bytes
      ip.sentBytes += sample.bytes
      ip.intervalSentBytes += sample.bytes
    }
    ip.lastSeenAt = sample.timestamp
  }

  recordPacket(durationMs: number, bytes: number): void {
    this.packet.record(durationMs)
    this.intervalPacket.record(durationMs)
    this.packetBytes += Math.max(0, bytes)
  }

  recordRpc(input: {
    method: string
    durationMs: number
    connectionId: string
    remoteAddress?: string
    error: boolean
    errorCode?: number
    errorMessage?: string
    requestSummary?: string
    at?: number
  }): void {
    const at = input.at ?? Date.now()
    this.rpc.record(input.durationMs)
    this.intervalRpc.record(input.durationMs)
    if (input.error) {
      this.rpcErrors++
      this.intervalRpcErrors++
      const errorCode = input.errorCode ?? 500
      const errorMessage = normalizeErrorMessage(input.errorMessage)
      const category = classifyRpcFailure(errorCode, errorMessage)
      const key = `${category}:${errorCode}`
      const failure = this.failures.get(key) ?? {
        category, errorCode, count: 0, lastSeenAt: at,
      }
      failure.count++
      failure.lastSeenAt = at
      this.failures.set(key, failure)
      this.recordFailureReason({
        method: input.method, category, errorCode, errorMessage, at,
      })
      this.recentFailures.unshift({
        at,
        method: input.method,
        errorCode,
        errorMessage,
        requestSummary: normalizeRequestSummary(input.requestSummary),
        connectionId: input.connectionId,
        remoteAddress: normalizeAddress(input.remoteAddress),
      })
      this.recentFailures.length = Math.min(this.recentFailures.length, MAX_RECENT_FAILURES)
      if (category === 'not-implemented') {
        const missing = this.missingRpcs.get(input.method) ?? { count: 0, lastSeenAt: at }
        missing.count++
        missing.lastSeenAt = at
        this.missingRpcs.set(input.method, missing)
        this.missingRpcCount++
      }
    }
    let method = this.methods.get(input.method)
    if (!method) {
      method = { histogram: new LatencyHistogram(), errors: 0, lastSeenAt: at }
      this.methods.set(input.method, method)
    }
    method.histogram.record(input.durationMs)
    method.errors += Number(input.error)
    method.lastSeenAt = at
    const address = normalizeAddress(input.remoteAddress)
    const ip = this.ip(address, at)
    ip.rpcCount++
    ip.lastSeenAt = at
    const currentFloor = this.slowest.at(-1)?.durationMs ?? 0
    if (
      input.durationMs >= this.options.slowThresholdMs
      || this.slowest.length < 20
      || input.durationMs > currentFloor
    ) {
      this.slowest.push({
        at, method: input.method, durationMs: round(input.durationMs),
        connectionId: input.connectionId, remoteAddress: address, error: input.error,
      })
      this.slowest.sort((left, right) => right.durationMs - left.durationMs)
      this.slowest.length = Math.min(this.slowest.length, 20)
    }
  }

  sample(runtime: RuntimeSnapshot, intervalSeconds: number, at = Date.now()): StatisticsSnapshot {
    const seconds = Math.max(0.001, intervalSeconds)
    this.currentIntervalSeconds = seconds
    const rpcInterval = this.intervalRpc.snapshot()
    const packetInterval = this.intervalPacket.snapshot()
    const point: StatisticsPoint = {
      at,
      rpcCount: rpcInterval.count,
      rpcErrors: this.intervalRpcErrors,
      rpcP90Ms: rpcInterval.p90Ms,
      rpcP99Ms: rpcInterval.p99Ms,
      packetCount: packetInterval.count,
      packetP90Ms: packetInterval.p90Ms,
      receivedBytes: Math.round(this.intervalReceivedBytes / seconds),
      sentBytes: Math.round(this.intervalSentBytes / seconds),
      activeConnections: this.connections.size,
      cpuPercent: runtime.cpuPercent,
      rssBytes: runtime.rssBytes,
      heapUsedBytes: runtime.heapUsedBytes,
      externalBytes: runtime.externalBytes,
      arrayBuffersBytes: runtime.arrayBuffersBytes,
      cgroupMemoryCurrentBytes: runtime.cgroupMemoryCurrentBytes,
      cgroupAnonBytes: runtime.cgroupAnonBytes,
      cgroupFileBytes: runtime.cgroupFileBytes,
      cgroupSwapBytes: runtime.cgroupSwapBytes,
      eventLoopDelayP99Ms: runtime.eventLoopDelayP99Ms,
      gcDurationMs: runtime.gcDurationMs,
    }
    appendBounded(this.series.seconds, point, this.options.secondRetention)
    const nextMinuteKey = Math.floor(at / 60_000)
    if (this.minuteKey !== -1 && nextMinuteKey !== this.minuteKey && this.minuteBucket.length) {
      appendBounded(this.series.minutes, aggregatePoints(this.minuteBucket), 1_440)
      this.minuteBucket = []
    }
    this.minuteKey = nextMinuteKey
    this.minuteBucket.push(point)
    const nextHourKey = Math.floor(at / 3_600_000)
    if (this.hourKey !== -1 && nextHourKey !== this.hourKey && this.hourBucket.length) {
      appendBounded(this.series.hours, aggregatePoints(this.hourBucket), 168)
      this.hourBucket = []
    }
    this.hourKey = nextHourKey
    this.hourBucket.push(point)

    const snapshot = this.snapshot(runtime, point)
    this.intervalRpc.reset()
    this.intervalPacket.reset()
    this.intervalRpcErrors = 0
    this.intervalReceivedBytes = 0
    this.intervalSentBytes = 0
    for (const ip of this.ips.values()) {
      ip.intervalReceivedBytes = 0
      ip.intervalSentBytes = 0
    }
    return snapshot
  }

  snapshot(runtime: RuntimeSnapshot = EMPTY_RUNTIME, latest?: StatisticsPoint): StatisticsSnapshot {
    const rpc = this.rpc.snapshot()
    const packets = this.packet.snapshot()
    return {
      startedAt: this.startedAt,
      updatedAt: latest?.at ?? Date.now(),
      activeConnections: this.connections.size,
      totalConnections: this.totalConnections,
      rpc: { ...rpc, errors: this.rpcErrors, errorRate: ratio(this.rpcErrors, rpc.count) },
      packets: { ...packets, bytes: this.packetBytes },
      traffic: {
        receivedBytes: this.receivedBytes,
        sentBytes: this.sentBytes,
        receivedBytesPerSecond: latest?.receivedBytes ?? 0,
        sentBytesPerSecond: latest?.sentBytes ?? 0,
      },
      runtime,
      methods: this.methodSnapshots(),
      methodDistribution: this.methodCountSnapshots(),
      failures: this.failureSnapshots(rpc.count),
      failureReasons: this.failureReasonSnapshots(rpc.count),
      recentFailures: [...this.recentFailures],
      missingRpcs: {
        count: this.missingRpcCount,
        uniqueMethods: this.missingRpcs.size,
        methods: this.missingRpcSnapshots(),
      },
      ips: this.ipSnapshots(),
      slowest: [...this.slowest],
    }
  }

  reset(at = Date.now()): void {
    this.startedAt = at
    this.rpc.reset()
    this.packet.reset()
    this.intervalRpc.reset()
    this.intervalPacket.reset()
    this.methods.clear()
    this.failures.clear()
    this.failureReasons.clear()
    this.missingRpcs.clear()
    this.slowest.length = 0
    this.recentFailures.length = 0
    this.rpcErrors = 0
    this.missingRpcCount = 0
    this.intervalRpcErrors = 0
    this.packetBytes = 0
    this.receivedBytes = 0
    this.sentBytes = 0
    this.intervalReceivedBytes = 0
    this.intervalSentBytes = 0
    this.totalConnections = this.connections.size
    this.series.seconds.length = 0
    this.series.minutes.length = 0
    this.series.hours.length = 0
    this.minuteBucket = []
    this.hourBucket = []
    this.minuteKey = -1
    this.hourKey = -1
    for (const ip of this.ips.values()) {
      ip.totalConnections = ip.activeConnections
      ip.receivedBytes = 0
      ip.sentBytes = 0
      ip.intervalReceivedBytes = 0
      ip.intervalSentBytes = 0
      ip.rpcCount = 0
    }
  }

  private methodSnapshots(): RpcMethodSnapshot[] {
    return [...this.methods.entries()].map(([method, state]) => {
      const distribution = state.histogram.snapshot()
      return {
        method, ...distribution, errors: state.errors,
        errorRate: ratio(state.errors, distribution.count), lastSeenAt: state.lastSeenAt,
      }
    }).sort((left, right) => right.p90Ms - left.p90Ms || right.count - left.count)
      .slice(0, this.options.topMethods)
  }

  private failureSnapshots(total: number): RpcFailureSnapshot[] {
    return [...this.failures.values()].map((failure) => ({
      ...failure,
      rate: ratio(failure.count, total),
    })).sort((left, right) => right.count - left.count || right.lastSeenAt - left.lastSeenAt)
  }

  private failureReasonSnapshots(total: number): RpcFailureReasonSnapshot[] {
    return [...this.failureReasons.values()].map((failure) => ({
      ...failure,
      rate: ratio(failure.count, total),
      methodErrorRate: ratio(failure.count, this.methods.get(failure.method)?.errors ?? 0),
    })).sort((left, right) => right.count - left.count || right.lastSeenAt - left.lastSeenAt)
      .slice(0, this.options.topMethods * 2)
  }

  private methodCountSnapshots(): RpcMethodCountSnapshot[] {
    return [...this.methods.entries()].map(([method, state]) => ({
      method, count: state.histogram.count,
    })).sort((left, right) => right.count - left.count || left.method.localeCompare(right.method))
      .slice(0, this.options.topMethods)
  }

  private missingRpcSnapshots(): MissingRpcSnapshot[] {
    return [...this.missingRpcs.entries()].map(([method, state]) => ({
      method, count: state.count, lastSeenAt: state.lastSeenAt,
    })).sort((left, right) => right.count - left.count || right.lastSeenAt - left.lastSeenAt)
      .slice(0, this.options.topMethods)
  }

  private ipSnapshots(): IpSnapshot[] {
    return [...this.ips.entries()].map(([address, state]) => ({
      address,
      activeConnections: state.activeConnections,
      totalConnections: state.totalConnections,
      receivedBytes: state.receivedBytes,
      sentBytes: state.sentBytes,
      receivedBytesPerSecond: Math.round(state.intervalReceivedBytes / this.currentIntervalSeconds),
      sentBytesPerSecond: Math.round(state.intervalSentBytes / this.currentIntervalSeconds),
      rpcCount: state.rpcCount,
      lastSeenAt: state.lastSeenAt,
    })).sort((left, right) =>
      right.activeConnections - left.activeConnections
      || right.receivedBytes + right.sentBytes - left.receivedBytes - left.sentBytes)
      .slice(0, this.options.topIps)
  }

  private ip(address: string, at: number): IpState {
    let state = this.ips.get(address)
    if (!state) {
      if (this.ips.size >= 2_048) address = 'other'
      state = this.ips.get(address)
    }
    if (!state) {
      state = {
        activeConnections: 0, totalConnections: 0, receivedBytes: 0, sentBytes: 0,
        intervalReceivedBytes: 0, intervalSentBytes: 0, rpcCount: 0, lastSeenAt: at,
      }
      this.ips.set(address, state)
    }
    return state
  }

  private recordFailureReason(input: {
    method: string
    category: RpcFailureCategory
    errorCode: number
    errorMessage: string
    at: number
  }): void {
    let key = `${input.method}\u0000${input.errorCode}\u0000${input.errorMessage}`
    let state = this.failureReasons.get(key)
    if (!state && this.failureReasons.size >= MAX_FAILURE_REASONS) {
      key = `*\u0000${input.errorCode}\u0000[其他错误原因：统计维度已达上限]`
      state = this.failureReasons.get(key)
      input = {
        ...input,
        method: '*',
        errorMessage: '[其他错误原因：统计维度已达上限]',
      }
    }
    state ??= {
      method: input.method,
      category: input.category,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      count: 0,
      lastSeenAt: input.at,
    }
    state.count++
    state.lastSeenAt = input.at
    this.failureReasons.set(key, state)
  }
}

function normalizeAddress(address?: string): string {
  if (!address) return 'unknown'
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

function appendBounded<T>(items: T[], value: T, maximum: number): void {
  items.push(value)
  if (items.length > maximum) items.splice(0, items.length - maximum)
}

function ratio(value: number, total: number): number {
  return total ? round(value / total) : 0
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function aggregatePoints(points: StatisticsPoint[]): StatisticsPoint {
  const sum = <K extends keyof StatisticsPoint>(key: K) => points.reduce((total, point) => total + Number(point[key]), 0)
  const average = <K extends keyof StatisticsPoint>(key: K) => round(sum(key) / points.length)
  const maximum = <K extends keyof StatisticsPoint>(key: K) => Math.max(...points.map(point => Number(point[key])))
  const last = points.at(-1)!
  return {
    at: last.at,
    rpcCount: sum('rpcCount'),
    rpcErrors: sum('rpcErrors'),
    rpcP90Ms: maximum('rpcP90Ms'),
    rpcP99Ms: maximum('rpcP99Ms'),
    packetCount: sum('packetCount'),
    packetP90Ms: maximum('packetP90Ms'),
    receivedBytes: average('receivedBytes'),
    sentBytes: average('sentBytes'),
    activeConnections: last.activeConnections,
    cpuPercent: average('cpuPercent'),
    rssBytes: last.rssBytes,
    heapUsedBytes: last.heapUsedBytes,
    externalBytes: last.externalBytes,
    arrayBuffersBytes: last.arrayBuffersBytes,
    cgroupMemoryCurrentBytes: last.cgroupMemoryCurrentBytes,
    cgroupAnonBytes: last.cgroupAnonBytes,
    cgroupFileBytes: last.cgroupFileBytes,
    cgroupSwapBytes: last.cgroupSwapBytes,
    eventLoopDelayP99Ms: maximum('eventLoopDelayP99Ms'),
    gcDurationMs: sum('gcDurationMs'),
  }
}

function classifyRpcFailure(errorCode: number, errorMessage?: string): RpcFailureCategory {
  if (errorMessage?.startsWith('METHOD_NOT_IMPLEMENTED:')) return 'not-implemented'
  if (errorCode === 401 || errorMessage?.includes('AUTH_KEY_UNREGISTERED')) return 'unauthorized'
  if (errorCode === 429 || errorMessage?.includes('FLOOD_WAIT')) return 'rate-limit'
  if (errorCode === 400) return 'bad-request'
  if (errorCode >= 500) return 'internal'
  return 'other'
}

function normalizeErrorMessage(message?: string): string {
  const normalized = message?.replace(/\s+/g, ' ').trim() || '[无错误信息]'
  if (normalized.length <= MAX_ERROR_MESSAGE_LENGTH) return normalized
  return `${normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
}

function normalizeRequestSummary(summary?: string): string | undefined {
  if (!summary) return
  const normalized = summary.replace(/\s+/g, ' ').trim()
  if (!normalized) return
  if (normalized.length <= MAX_ERROR_MESSAGE_LENGTH) return normalized
  return `${normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
}
