/** @jsxImportSource vue */
/** @jsxRuntime automatic */

import type { Context } from 'cordis'
import { computed, defineComponent, ref, resolveComponent } from 'vue'
import { useRpc } from '@cordisjs/client'
import type {
  MtprotoStatisticsData, RpcMethodSnapshot, StatisticsPoint,
} from '../src/types.js'
import './style.css'

type DashboardTab = 'overview' | 'rpc' | 'network' | 'runtime'
type Range = 'seconds' | 'minutes' | 'hours'

const Sparkline = defineComponent({
  name: 'StatisticsSparkline',
  props: {
    points: { type: Array as () => number[], required: true },
    color: { type: String, default: '#4f8cff' },
  },
  setup(props) {
    const path = computed(() => {
      if (!props.points.length) return ''
      const maximum = Math.max(...props.points, 1)
      const width = 300
      const height = 72
      return props.points.map((value, index) => {
        const x = props.points.length === 1 ? width : index * width / (props.points.length - 1)
        const y = height - value / maximum * (height - 4) - 2
        return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
      }).join(' ')
    })
    return () => <svg class="statistics-sparkline" viewBox="0 0 300 72" preserveAspectRatio="none" aria-hidden="true">
      <path class="sparkline-area" d={path.value ? `${path.value} L300,72 L0,72 Z` : ''} style={{ fill: props.color }} />
      <path class="sparkline-line" d={path.value} style={{ stroke: props.color }} />
    </svg>
  },
})

const MetricCard = defineComponent({
  name: 'StatisticsMetricCard',
  props: {
    label: { type: String, required: true },
    value: { type: String, required: true },
    detail: { type: String, default: '' },
    points: { type: Array as () => number[], default: () => [] },
    color: { type: String, default: '#4f8cff' },
  },
  setup(props) {
    return () => <article class="statistics-card">
      <div class="statistics-card-label">{props.label}</div>
      <div class="statistics-card-value">{props.value}</div>
      <div class="statistics-card-detail">{props.detail}</div>
      <Sparkline points={props.points} color={props.color} />
    </article>
  },
})

export const StatisticsPage = defineComponent({
  name: 'MtprotoStatisticsPage',
  setup() {
    const data = useRpc<MtprotoStatisticsData>()
    const tab = ref<DashboardTab>('overview')
    const range = ref<Range>('seconds')
    const busy = ref(false)
    const points = computed(() => data.value.series[range.value])
    const values = (selector: (point: StatisticsPoint) => number) => computed(() => points.value.map(selector))
    const rpcRate = values(point => point.rpcCount)
    const rpcP90 = values(point => point.rpcP90Ms)
    const traffic = values(point => point.receivedBytes + point.sentBytes)
    const cpu = values(point => point.cpuPercent)
    const memory = values(point => point.rssBytes)
    const loop = values(point => point.eventLoopDelayP99Ms)

    const reset = async () => {
      busy.value = true
      try {
        await data.value.reset()
      } finally {
        busy.value = false
      }
    }

    return () => {
      const Layout = resolveComponent('k-layout') as ReturnType<typeof defineComponent>
      const snapshot = data.value.snapshot
      return <Layout class="mtproto-statistics-page">{
        {
          header: () => <div class="statistics-toolbar">
            <nav class="statistics-tabs" aria-label="Statistics sections">
              {(['overview', 'rpc', 'network', 'runtime'] as DashboardTab[]).map(item => <button
                type="button" class={{ active: tab.value === item }} onClick={() => { tab.value = item }}
              >{{ overview: '总览', rpc: 'RPC', network: '网络 / IP', runtime: '运行时' }[item]}</button>)}
            </nav>
            <div class="statistics-range">
              {(['seconds', 'minutes', 'hours'] as Range[]).map(item => <button
                type="button" class={{ active: range.value === item }} onClick={() => { range.value = item }}
              >{{ seconds: '秒', minutes: '分钟', hours: '小时' }[item]}</button>)}
            </div>
            <button class="statistics-reset" type="button" disabled={busy.value} onClick={reset}>重置统计</button>
            <span class="statistics-updated">更新于 {formatTime(snapshot.updatedAt)}</span>
          </div>,
          default: () => <main class="statistics-content">
            {tab.value === 'overview' && <>
              <section class="statistics-grid">
                <MetricCard label="RPC 速率" value={`${latest(points.value, 'rpcCount')} / ${rangeUnit(range.value)}`} detail={`${formatInteger(snapshot.rpc.count)} 次累计`} points={rpcRate.value} />
                <MetricCard label="RPC P90" value={formatMs(snapshot.rpc.p90Ms)} detail={`P99 ${formatMs(snapshot.rpc.p99Ms)} · 最大 ${formatMs(snapshot.rpc.maxMs)}`} points={rpcP90.value} color="#a970ff" />
                <MetricCard label="网络吞吐" value={formatRate(snapshot.traffic.receivedBytesPerSecond + snapshot.traffic.sentBytesPerSecond)} detail={`↓ ${formatRate(snapshot.traffic.receivedBytesPerSecond)} · ↑ ${formatRate(snapshot.traffic.sentBytesPerSecond)}`} points={traffic.value} color="#39b980" />
                <MetricCard label="活跃连接" value={String(snapshot.activeConnections)} detail={`${snapshot.totalConnections} 次累计连接`} points={values(point => point.activeConnections).value} color="#e49b3d" />
                <MetricCard label="CrossGram CPU" value={`${snapshot.runtime.cpuPercent.toFixed(1)}%`} detail={`事件循环利用率 ${snapshot.runtime.eventLoopUtilization.toFixed(1)}%`} points={cpu.value} color="#e05d6f" />
                <MetricCard label="CrossGram RAM" value={formatBytes(snapshot.runtime.rssBytes)} detail={`Heap ${formatBytes(snapshot.runtime.heapUsedBytes)} / ${formatBytes(snapshot.runtime.heapTotalBytes)}`} points={memory.value} color="#37a0c9" />
              </section>
              <section class="statistics-two-column">
                <Panel title="最慢 RPC 方法"><MethodTable rows={snapshot.methods.slice(0, 10)} /></Panel>
                <Panel title="最近最慢突发"><SlowTable rows={snapshot.slowest.slice(0, 10)} /></Panel>
              </section>
            </>}
            {tab.value === 'rpc' && <>
              <section class="statistics-grid compact">
                <MetricCard label="平均" value={formatMs(snapshot.rpc.averageMs)} detail={`${snapshot.rpc.count} 次调用`} points={rpcP90.value} />
                <MetricCard label="P50 / P90" value={`${formatMs(snapshot.rpc.p50Ms)} / ${formatMs(snapshot.rpc.p90Ms)}`} detail={`P95 ${formatMs(snapshot.rpc.p95Ms)}`} points={rpcP90.value} />
                <MetricCard label="P99 / 最大" value={`${formatMs(snapshot.rpc.p99Ms)} / ${formatMs(snapshot.rpc.maxMs)}`} detail="长尾耗时" points={rpcP90.value} color="#a970ff" />
                <MetricCard label="错误率" value={formatPercent(snapshot.rpc.errorRate)} detail={`${snapshot.rpc.errors} 次错误`} points={values(point => point.rpcErrors).value} color="#e05d6f" />
              </section>
              <Panel title="RPC 方法耗时排行"><MethodTable rows={snapshot.methods} /></Panel>
              <Panel title="慢请求与突发长尾"><SlowTable rows={snapshot.slowest} /></Panel>
            </>}
            {tab.value === 'network' && <>
              <section class="statistics-grid compact">
                <MetricCard label="接收速度" value={formatRate(snapshot.traffic.receivedBytesPerSecond)} detail={`${formatBytes(snapshot.traffic.receivedBytes)} 累计`} points={values(point => point.receivedBytes).value} color="#39b980" />
                <MetricCard label="发送速度" value={formatRate(snapshot.traffic.sentBytesPerSecond)} detail={`${formatBytes(snapshot.traffic.sentBytes)} 累计`} points={values(point => point.sentBytes).value} color="#4f8cff" />
                <MetricCard label="包处理 P90" value={formatMs(snapshot.packets.p90Ms)} detail={`${snapshot.packets.count} 包 · ${formatBytes(snapshot.packets.bytes)}`} points={values(point => point.packetP90Ms).value} color="#a970ff" />
                <MetricCard label="连接" value={`${snapshot.activeConnections} 活跃`} detail={`${snapshot.totalConnections} 累计`} points={values(point => point.activeConnections).value} color="#e49b3d" />
              </section>
              <Panel title="来源 IP"><IpTable rows={snapshot.ips} /></Panel>
            </>}
            {tab.value === 'runtime' && <>
              <section class="statistics-grid">
                <MetricCard label="CPU" value={`${snapshot.runtime.cpuPercent.toFixed(1)}%`} detail={`ELU ${snapshot.runtime.eventLoopUtilization.toFixed(1)}%`} points={cpu.value} color="#e05d6f" />
                <MetricCard label="RSS" value={formatBytes(snapshot.runtime.rssBytes)} detail={`Heap ${formatBytes(snapshot.runtime.heapUsedBytes)}`} points={memory.value} color="#37a0c9" />
                <MetricCard label="事件循环 P99" value={formatMs(snapshot.runtime.eventLoopDelayP99Ms)} detail={`均值 ${formatMs(snapshot.runtime.eventLoopDelayMeanMs)} · P90 ${formatMs(snapshot.runtime.eventLoopDelayP90Ms)}`} points={loop.value} color="#a970ff" />
                <MetricCard label="GC 时间" value={formatMs(snapshot.runtime.gcDurationMs)} detail={`${snapshot.runtime.gcCount} 次 / 当前采样周期`} points={values(point => point.gcDurationMs).value} color="#e49b3d" />
                <MetricCard label="External" value={formatBytes(snapshot.runtime.externalBytes)} detail={`ArrayBuffers ${formatBytes(snapshot.runtime.arrayBuffersBytes)}`} points={[]} />
                <MetricCard label="运行时间" value={formatDuration(snapshot.runtime.uptimeSeconds)} detail={`统计始于 ${formatTime(snapshot.startedAt)}`} points={[]} color="#39b980" />
              </section>
            </>}
          </main>,
        }
      }</Layout>
    }
  },
})

const Panel = defineComponent({
  props: { title: { type: String, required: true } },
  setup(props, { slots }) {
    return () => <section class="statistics-panel"><h2>{props.title}</h2>{slots.default?.()}</section>
  },
})

const MethodTable = defineComponent({
  props: { rows: { type: Array as () => RpcMethodSnapshot[], required: true } },
  setup(props) {
    return () => <Table headers={['方法', '次数', '平均', 'P90', 'P99', '最大', '错误率']} rows={props.rows.map(row => [
      <code title={row.method}>{row.method}</code>, formatInteger(row.count), formatMs(row.averageMs),
      formatMs(row.p90Ms), formatMs(row.p99Ms), formatMs(row.maxMs), formatPercent(row.errorRate),
    ])} />
  },
})

const SlowTable = defineComponent({
  props: { rows: { type: Array as () => MtprotoStatisticsData['snapshot']['slowest'], required: true } },
  setup(props) {
    return () => <Table headers={['时间', '方法', '耗时', '连接', 'IP', '结果']} rows={props.rows.map(row => [
      formatTime(row.at), <code>{row.method}</code>, formatMs(row.durationMs), row.connectionId,
      <code>{row.remoteAddress}</code>, row.error ? <span class="status-error">错误</span> : '成功',
    ])} />
  },
})

const IpTable = defineComponent({
  props: { rows: { type: Array as () => MtprotoStatisticsData['snapshot']['ips'], required: true } },
  setup(props) {
    return () => <Table headers={['IP', '活跃 / 累计连接', 'RPC', '接收', '发送', '最后活动']} rows={props.rows.map(row => [
      <code>{row.address}</code>, `${row.activeConnections} / ${row.totalConnections}`,
      formatInteger(row.rpcCount), `${formatBytes(row.receivedBytes)} (${formatRate(row.receivedBytesPerSecond)})`,
      `${formatBytes(row.sentBytes)} (${formatRate(row.sentBytesPerSecond)})`, formatTime(row.lastSeenAt),
    ])} />
  },
})

const Table = defineComponent({
  props: {
    headers: { type: Array as () => string[], required: true },
    rows: { type: Array as () => unknown[][], required: true },
  },
  setup(props) {
    return () => <div class="statistics-table-wrap"><table class="statistics-table">
      <thead><tr>{props.headers.map(header => <th>{header}</th>)}</tr></thead>
      <tbody>{props.rows.length
        ? props.rows.map(row => <tr>{row.map(cell => <td>{cell as never}</td>)}</tr>)
        : <tr><td colspan={props.headers.length} class="statistics-empty">暂无数据</td></tr>}
      </tbody>
    </table></div>
  },
})

export default function apply(ctx: Context): void {
  ctx.client.router.page({
    path: '/mtproto-statistics',
    name: 'Statistics',
    icon: 'activity:default',
    order: 125,
    component: StatisticsPage,
  })
}

function latest(points: StatisticsPoint[], key: keyof StatisticsPoint): number {
  return Number(points.at(-1)?.[key] ?? 0)
}

function rangeUnit(range: Range): string {
  return range === 'seconds' ? '秒' : range === 'minutes' ? '分钟' : '小时'
}

function formatMs(value: number): string {
  if (value < 1) return `${Math.round(value * 1_000)} µs`
  if (value < 1_000) return `${value.toFixed(value < 10 ? 2 : 1)} ms`
  return `${(value / 1_000).toFixed(2)} s`
}

function formatBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let amount = Math.max(0, value)
  let unit = 0
  while (amount >= 1_024 && unit < units.length - 1) {
    amount /= 1_024
    unit++
  }
  return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}`
}

function formatRate(value: number): string {
  return `${formatBytes(value)}/s`
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat().format(value)
}

function formatTime(value: number): string {
  return value ? new Date(value).toLocaleString(undefined, { hour12: false }) : '—'
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor(seconds % 86_400 / 3_600)
  const minutes = Math.floor(seconds % 3_600 / 60)
  return days ? `${days}天 ${hours}小时` : hours ? `${hours}小时 ${minutes}分` : `${minutes}分`
}
