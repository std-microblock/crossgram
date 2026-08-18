import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
  type EventLoopUtilization,
} from 'node:perf_hooks'
import type { RuntimeSnapshot } from './types.js'

export class RuntimeMonitor {
  private readonly delay = monitorEventLoopDelay({ resolution: 20 })
  private previousCpu = process.cpuUsage()
  private previousTime = performance.now()
  private previousElu: EventLoopUtilization = performance.eventLoopUtilization()
  private gcCount = 0
  private gcDurationMs = 0
  private readonly observer: PerformanceObserver

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
    const result: RuntimeSnapshot = {
      cpuPercent: round((cpu.user + cpu.system) / (elapsedMs * 10)),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
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

function nanos(value: number): number {
  return Number.isFinite(value) ? round(value / 1_000_000) : 0
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
