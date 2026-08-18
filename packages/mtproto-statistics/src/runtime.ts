import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
  type EventLoopUtilization,
} from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getHeapStatistics } from 'node:v8'
import type { RuntimeSnapshot } from './types.js'

const CGROUP_SAMPLE_INTERVAL_MS = 5_000

interface CgroupMemorySnapshot {
  currentBytes: number
  peakBytes: number
  highBytes: number
  maxBytes: number
  anonBytes: number
  fileBytes: number
  kernelBytes: number
  shmemBytes: number
  swapBytes: number
}

const EMPTY_CGROUP_MEMORY: CgroupMemorySnapshot = {
  currentBytes: 0, peakBytes: 0, highBytes: 0, maxBytes: 0,
  anonBytes: 0, fileBytes: 0, kernelBytes: 0, shmemBytes: 0, swapBytes: 0,
}

export class RuntimeMonitor {
  private readonly delay = monitorEventLoopDelay({ resolution: 20 })
  private previousCpu = process.cpuUsage()
  private previousTime = performance.now()
  private previousElu: EventLoopUtilization = performance.eventLoopUtilization()
  private gcCount = 0
  private gcDurationMs = 0
  private readonly observer: PerformanceObserver
  private readonly cgroupPath = unifiedCgroupPath()
  private cgroup = EMPTY_CGROUP_MEMORY
  private nextCgroupSampleAt = 0

  constructor() {
    this.delay.enable()
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.gcCount++
        this.gcDurationMs += entry.duration
      }
    })
    this.observer.observe({ entryTypes: ['gc'] })
  }

  sample(): RuntimeSnapshot {
    const now = performance.now()
    const cpu = process.cpuUsage(this.previousCpu)
    const elapsedMs = Math.max(1, now - this.previousTime)
    const elu = performance.eventLoopUtilization(this.previousElu)
    const memory = process.memoryUsage()
    const heap = getHeapStatistics()
    if (now >= this.nextCgroupSampleAt) {
      this.cgroup = readCgroupMemory(this.cgroupPath)
      this.nextCgroupSampleAt = now + CGROUP_SAMPLE_INTERVAL_MS
    }
    const result: RuntimeSnapshot = {
      cpuPercent: round((cpu.user + cpu.system) / (elapsedMs * 10)),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      heapLimitBytes: heap.heap_size_limit,
      heapAvailableBytes: heap.total_available_size,
      mallocedBytes: heap.malloced_memory,
      peakMallocedBytes: heap.peak_malloced_memory,
      nativeContexts: heap.number_of_native_contexts,
      detachedContexts: heap.number_of_detached_contexts,
      cgroupMemoryCurrentBytes: this.cgroup.currentBytes,
      cgroupMemoryPeakBytes: this.cgroup.peakBytes,
      cgroupMemoryHighBytes: this.cgroup.highBytes,
      cgroupMemoryMaxBytes: this.cgroup.maxBytes,
      cgroupAnonBytes: this.cgroup.anonBytes,
      cgroupFileBytes: this.cgroup.fileBytes,
      cgroupKernelBytes: this.cgroup.kernelBytes,
      cgroupShmemBytes: this.cgroup.shmemBytes,
      cgroupSwapBytes: this.cgroup.swapBytes,
      eventLoopUtilization: round(elu.utilization * 100),
      eventLoopDelayMeanMs: nanos(this.delay.mean),
      eventLoopDelayP90Ms: nanos(this.delay.percentile(90)),
      eventLoopDelayP99Ms: nanos(this.delay.percentile(99)),
      gcCount: this.gcCount,
      gcDurationMs: round(this.gcDurationMs),
      uptimeSeconds: Math.floor(process.uptime()),
    }
    this.previousCpu = process.cpuUsage()
    this.previousTime = now
    this.previousElu = performance.eventLoopUtilization()
    this.gcCount = 0
    this.gcDurationMs = 0
    this.delay.reset()
    return result
  }

  dispose(): void {
    this.delay.disable()
    this.observer.disconnect()
  }
}

function unifiedCgroupPath(): string | undefined {
  try {
    const line = readFileSync('/proc/self/cgroup', 'utf8')
      .split(/\r?\n/u)
      .find((value) => value.startsWith('0::'))
    if (!line) return
    const relative = line.slice(3).replace(/^\/+/, '')
    return resolve('/sys/fs/cgroup', relative)
  } catch {
    return
  }
}

function readCgroupMemory(path: string | undefined): CgroupMemorySnapshot {
  if (!path) return EMPTY_CGROUP_MEMORY
  try {
    const stat = new Map(readFileSync(resolve(path, 'memory.stat'), 'utf8')
      .trim().split(/\r?\n/u).map((line) => {
        const [key, value] = line.split(/\s+/u)
        return [key!, finiteBytes(value)] as const
      }))
    return {
      currentBytes: readBytes(resolve(path, 'memory.current')),
      peakBytes: readBytes(resolve(path, 'memory.peak')),
      highBytes: readBytes(resolve(path, 'memory.high')),
      maxBytes: readBytes(resolve(path, 'memory.max')),
      anonBytes: stat.get('anon') ?? 0,
      fileBytes: stat.get('file') ?? 0,
      kernelBytes: stat.get('kernel') ?? 0,
      shmemBytes: stat.get('shmem') ?? 0,
      swapBytes: readBytes(resolve(path, 'memory.swap.current')),
    }
  } catch {
    return EMPTY_CGROUP_MEMORY
  }
}

function readBytes(path: string): number {
  try {
    return finiteBytes(readFileSync(path, 'utf8').trim())
  } catch {
    return 0
  }
}

function finiteBytes(value: string | undefined): number {
  if (!value || value === 'max') return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function nanos(value: number): number {
  return Number.isFinite(value) ? round(value / 1_000_000) : 0
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
