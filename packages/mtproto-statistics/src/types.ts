export interface DistributionSnapshot {
  count: number
  averageMs: number
  minMs: number
  maxMs: number
  p50Ms: number
  p90Ms: number
  p95Ms: number
  p99Ms: number
}

export interface RpcMethodSnapshot extends DistributionSnapshot {
  method: string
  errors: number
  errorRate: number
  lastSeenAt: number
}

export interface RpcMethodCountSnapshot {
  method: string
  count: number
}

export type RpcFailureCategory =
  | 'not-implemented'
  | 'bad-request'
  | 'unauthorized'
  | 'rate-limit'
  | 'internal'
  | 'other'

export interface RpcFailureSnapshot {
  category: RpcFailureCategory
  errorCode: number
  count: number
  rate: number
  lastSeenAt: number
}

export interface RpcFailureReasonSnapshot extends RpcFailureSnapshot {
  method: string
  errorMessage: string
  methodErrorRate: number
}

export interface RpcFailureSample {
  at: number
  method: string
  errorCode: number
  errorMessage: string
  requestSummary?: string
  connectionId: string
  remoteAddress: string
}

export interface MissingRpcSnapshot {
  method: string
  count: number
  lastSeenAt: number
}

export interface SlowRpcSample {
  at: number
  method: string
  durationMs: number
  connectionId: string
  remoteAddress: string
  error: boolean
}

export interface IpSnapshot {
  address: string
  activeConnections: number
  totalConnections: number
  receivedBytes: number
  sentBytes: number
  receivedBytesPerSecond: number
  sentBytesPerSecond: number
  rpcCount: number
  lastSeenAt: number
}

export interface FileRouteDeviceSnapshot {
  deviceModel: string
  systemVersion: string
  appVersion: string
  langPack: string
  apiId: number
  directFiles: number
  relayFiles: number
  totalFiles: number
  directRate: number
  lastSeenAt: number
}

export interface FileRouteSnapshot {
  directFiles: number
  relayFiles: number
  totalFiles: number
  directRate: number
  devices: FileRouteDeviceSnapshot[]
}

export interface RuntimeSnapshot {
  cpuPercent: number
  rssBytes: number
  heapUsedBytes: number
  heapTotalBytes: number
  externalBytes: number
  arrayBuffersBytes: number
  heapLimitBytes: number
  heapAvailableBytes: number
  mallocedBytes: number
  peakMallocedBytes: number
  nativeContexts: number
  detachedContexts: number
  cgroupMemoryCurrentBytes: number
  cgroupMemoryPeakBytes: number
  cgroupMemoryHighBytes: number
  cgroupMemoryMaxBytes: number
  cgroupAnonBytes: number
  cgroupFileBytes: number
  cgroupKernelBytes: number
  cgroupShmemBytes: number
  cgroupSwapBytes: number
  eventLoopUtilization: number
  eventLoopDelayMeanMs: number
  eventLoopDelayP90Ms: number
  eventLoopDelayP99Ms: number
  gcCount: number
  gcDurationMs: number
  uptimeSeconds: number
}

export interface StatisticsPoint {
  at: number
  rpcCount: number
  rpcErrors: number
  rpcP90Ms: number
  rpcP99Ms: number
  packetCount: number
  packetP90Ms: number
  receivedBytes: number
  sentBytes: number
  activeConnections: number
  cpuPercent: number
  rssBytes: number
  heapUsedBytes: number
  externalBytes: number
  arrayBuffersBytes: number
  cgroupMemoryCurrentBytes: number
  cgroupAnonBytes: number
  cgroupFileBytes: number
  cgroupSwapBytes: number
  eventLoopDelayP99Ms: number
  gcDurationMs: number
}

export interface StatisticsSnapshot {
  startedAt: number
  updatedAt: number
  activeConnections: number
  totalConnections: number
  rpc: DistributionSnapshot & { errors: number, errorRate: number }
  packets: DistributionSnapshot & { bytes: number }
  traffic: {
    receivedBytes: number
    sentBytes: number
    receivedBytesPerSecond: number
    sentBytesPerSecond: number
  }
  runtime: RuntimeSnapshot
  methods: RpcMethodSnapshot[]
  methodDistribution: RpcMethodCountSnapshot[]
  failures: RpcFailureSnapshot[]
  failureReasons: RpcFailureReasonSnapshot[]
  recentFailures: RpcFailureSample[]
  missingRpcs: {
    count: number
    uniqueMethods: number
    methods: MissingRpcSnapshot[]
  }
  fileRoutes: FileRouteSnapshot
  ips: IpSnapshot[]
  slowest: SlowRpcSample[]
}

export interface StatisticsSeries {
  seconds: StatisticsPoint[]
  minutes: StatisticsPoint[]
  hours: StatisticsPoint[]
}

export interface MtprotoStatisticsData {
  snapshot: StatisticsSnapshot
  series: StatisticsSeries
  reset(): Promise<void>
}
