import { useEffect, useMemo, useState } from 'react'
import type {
  MtprotoStatisticsData,
  StatisticsPoint,
  StatisticsSeries,
  StatisticsSnapshot,
} from '../src/types.js'
import { useRpc, type PageProps } from 'cordis-webui-react/client'
import {
  ConfirmAction,
  formatBytes,
  formatNumber,
  LiveContent,
  PageHeader,
} from 'cordis-webui-react/components'
import { displayValue } from 'cordis-webui-react/utils'
import { DistributionChart, Sparkline, type ChartTone } from './chart.js'
import {
  distributionSlices,
  formatMs,
  formatPercent,
  formatTimestamp,
  sampleUnit,
  sampleWindow,
  uptime,
  type SampleValue,
  type SeriesRange,
} from './statistics-model.js'
type Tab = 'overview' | 'rpc' | 'network' | 'files' | 'runtime'
const tabs: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'rpc', label: 'RPC' },
  { id: 'network', label: 'Network & IPs' },
  { id: 'files', label: 'File routes' },
  { id: 'runtime', label: 'Runtime' },
]
interface Column<T> {
  label: string
  key: keyof T
  format?: (value: any) => string
}
const methodColumns: Column<any>[] = [
  { label: 'Method', key: 'method' },
  { label: 'Calls', key: 'count', format: formatNumber },
  { label: 'Average', key: 'averageMs', format: formatMs },
  { label: 'P90', key: 'p90Ms', format: formatMs },
  { label: 'P99', key: 'p99Ms', format: formatMs },
  { label: 'Maximum', key: 'maxMs', format: formatMs },
  { label: 'Error rate', key: 'errorRate', format: formatPercent },
]
const slowColumns: Column<any>[] = [
  { label: 'When', key: 'at', format: formatTimestamp },
  { label: 'Method', key: 'method' },
  { label: 'Duration', key: 'durationMs', format: formatMs },
  { label: 'Connection', key: 'connectionId' },
  { label: 'IP', key: 'remoteAddress' },
  { label: 'Error', key: 'error' },
]
const rateColumns = (value: number) => formatBytes(value) + '/s'
export default function StatisticsPage(props: PageProps) {
  const rpc = useRpc<MtprotoStatisticsData>(props.entryId)
  return (
    <>
      <PageHeader
        title="MTProto statistics"
        description="A quieter view of traffic, latency, and the health of your relay."
        actions={
          <ConfirmAction
            label="Reset statistics"
            title="Reset these statistics?"
            description="Counters and historical samples will be cleared. Active connections stay open."
            action={() => rpc.data.reset()}
          />
        }
      />
      <LiveContent ready={rpc.ready}>
        {rpc.data.snapshot ? (
          <StatisticsDashboard
            snapshot={rpc.data.snapshot}
            series={rpc.data.series}
          />
        ) : null}
      </LiveContent>
    </>
  )
}
export function StatisticsDashboard(props: {
  snapshot: StatisticsSnapshot
  series: StatisticsSeries
}) {
  const [tab, setTab] = useState<Tab>('overview')
  const [range, setRange] = useState<keyof StatisticsSeries>('seconds')
  const snapshot = props.snapshot,
    points = props.series?.[range] ?? []
  /** Build a chart series that keeps each sample's timestamp next to its value. */
  const spark = (pick: (point: StatisticsPoint) => number): SampleValue[] =>
    points.map((point) => ({ at: point.at, value: Number(pick(point)) }))
  const runtime = snapshot.runtime
  return (
    <div className="stack statistics-dashboard">
      <div className="stats-toolbar">
        <div
          className="segmented"
          role="tablist"
          aria-label="Statistics sections"
        >
          {tabs.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              className={tab === item.id ? 'selected' : undefined}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="field">
          <span className="sr-only">Chart interval</span>
          <select
            aria-label="Chart interval"
            value={range}
            onChange={(event) =>
              setRange(event.currentTarget.value as keyof StatisticsSeries)
            }
          >
            <option value="seconds">Recent samples</option>
            <option value="minutes">Minute aggregates</option>
            <option value="hours">Hour aggregates</option>
          </select>
        </label>
      </div>
      <p className="muted">
        Updated {formatTimestamp(snapshot.updatedAt)} · {points.length}{' '}
        {sampleUnit(range)}s · {sampleWindow(points, range)} · only this page
        subscribes to statistics
      </p>
      {tab === 'overview' ? (
        <>
          <div className="stats-metrics">
            <Metric
              label={'RPC calls / ' + sampleUnit(range)}
              value={formatNumber(points.at(-1)?.rpcCount ?? 0)}
              detail={formatNumber(snapshot.rpc.count) + ' total calls'}
              series={spark((point) => point.rpcCount)}
              range={range}
              format={formatNumber}
            />
            <Metric
              label="RPC P90"
              value={formatMs(snapshot.rpc.p90Ms)}
              detail={'P99 ' + formatMs(snapshot.rpc.p99Ms)}
              series={spark((point) => point.rpcP90Ms)}
              range={range}
              format={formatMs}
              tone="tertiary"
            />
            <Metric
              label="Network throughput"
              value={
                formatBytes(
                  snapshot.traffic.receivedBytesPerSecond +
                    snapshot.traffic.sentBytesPerSecond,
                ) + '/s'
              }
              detail={
                '↓ ' +
                formatBytes(snapshot.traffic.receivedBytesPerSecond) +
                '/s · ↑ ' +
                formatBytes(snapshot.traffic.sentBytesPerSecond) +
                '/s'
              }
              series={spark(
                (point) => point.receivedBytes + point.sentBytes,
              )}
              range={range}
              format={(value) => formatBytes(value) + '/s'}
            />
            <Metric
              label="Active connections"
              value={formatNumber(snapshot.activeConnections)}
              detail={
                formatNumber(snapshot.totalConnections) +
                ' lifetime connections'
              }
              series={spark((point) => point.activeConnections)}
              range={range}
              format={formatNumber}
            />
            <Metric
              label="CPU"
              value={runtime.cpuPercent.toFixed(1) + '%'}
              detail={
                'Event-loop utilization ' +
                runtime.eventLoopUtilization.toFixed(1) +
                '%'
              }
              series={spark((point) => point.cpuPercent)}
              range={range}
              format={(value) => value.toFixed(1) + '%'}
              tone="tertiary"
            />
            <Metric
              label="Resident memory"
              value={formatBytes(runtime.rssBytes)}
              detail={
                'Heap ' +
                formatBytes(runtime.heapUsedBytes) +
                ' / ' +
                formatBytes(runtime.heapTotalBytes)
              }
              series={spark((point) => point.rssBytes)}
              range={range}
              format={formatBytes}
            />
          </div>
          <StatsTable
            title="Slowest RPC methods"
            rows={snapshot.methods.slice(0, 10)}
            columns={methodColumns}
          />
          <StatsTable
            title="Recent slow requests"
            rows={snapshot.slowest.slice(0, 10)}
            columns={slowColumns}
          />
        </>
      ) : null}
      {tab === 'rpc' ? (
        <>
          <div className="stats-metrics">
            <Metric
              label="Average RPC latency"
              value={formatMs(snapshot.rpc.averageMs)}
              detail={formatNumber(snapshot.rpc.count) + ' calls'}
              series={spark((point) => point.rpcP90Ms)}
              range={range}
            />
            <Metric
              label="P50 / P90"
              value={
                formatMs(snapshot.rpc.p50Ms) +
                ' / ' +
                formatMs(snapshot.rpc.p90Ms)
              }
              detail={'P95 ' + formatMs(snapshot.rpc.p95Ms)}
              series={spark((point) => point.rpcP90Ms)}
              range={range}
            />
            <Metric
              label="P99 / maximum"
              value={
                formatMs(snapshot.rpc.p99Ms) +
                ' / ' +
                formatMs(snapshot.rpc.maxMs)
              }
              detail="Tail latency"
              series={spark((point) => point.rpcP99Ms)}
              range={range}
              tone="tertiary"
            />
            <Metric
              label="RPC error rate"
              value={formatPercent(snapshot.rpc.errorRate)}
              detail={formatNumber(snapshot.rpc.errors) + ' errors'}
              series={spark((point) => point.rpcErrors)}
              range={range}
              tone="error"
            />
          </div>
          <div className="stats-two-columns">
            <Distribution
              title="RPC method distribution"
              slices={distributionSlices(
                snapshot.methodDistribution,
                snapshot.rpc.count,
              )}
            />
            <Distribution
              title="Successful and failed calls"
              slices={[
                {
                  label: 'Success',
                  value: Math.max(0, snapshot.rpc.count - snapshot.rpc.errors),
                },
                { label: 'Errors', value: snapshot.rpc.errors },
              ]}
            />
          </div>
          <StatsTable
            title="RPC methods"
            rows={snapshot.methods}
            columns={methodColumns}
          />
          <StatsTable
            title="RPC failure reasons"
            rows={snapshot.failureReasons}
            columns={[
              { label: 'Method', key: 'method' },
              { label: 'Category', key: 'category' },
              { label: 'Code', key: 'errorCode' },
              { label: 'Reason', key: 'errorMessage' },
              { label: 'Count', key: 'count' },
              {
                label: 'Method error rate',
                key: 'methodErrorRate',
                format: formatPercent,
              },
              { label: 'Share of calls', key: 'rate', format: formatPercent },
              {
                label: 'Last seen',
                key: 'lastSeenAt',
                format: formatTimestamp,
              },
            ]}
          />
          <div className="stats-two-columns">
            <StatsTable
              title="Failure categories"
              rows={snapshot.failures}
              columns={[
                { label: 'Category', key: 'category' },
                { label: 'Code', key: 'errorCode' },
                { label: 'Count', key: 'count' },
                { label: 'Share', key: 'rate', format: formatPercent },
              ]}
            />
            <StatsTable
              title={
                'Missing RPC methods · ' + snapshot.missingRpcs.count + ' hits'
              }
              rows={snapshot.missingRpcs.methods}
              columns={[
                { label: 'Method', key: 'method' },
                { label: 'Count', key: 'count' },
                {
                  label: 'Last seen',
                  key: 'lastSeenAt',
                  format: formatTimestamp,
                },
              ]}
            />
          </div>
          <StatsTable
            title="Recent RPC errors"
            rows={snapshot.recentFailures}
            columns={[
              { label: 'When', key: 'at', format: formatTimestamp },
              { label: 'Method', key: 'method' },
              { label: 'Request', key: 'requestSummary' },
              { label: 'Code', key: 'errorCode' },
              { label: 'Reason', key: 'errorMessage' },
              { label: 'Connection', key: 'connectionId' },
              { label: 'IP', key: 'remoteAddress' },
            ]}
          />
          <StatsTable
            title="Slow requests"
            rows={snapshot.slowest}
            columns={slowColumns}
          />
        </>
      ) : null}
      {tab === 'network' ? (
        <>
          <div className="stats-metrics">
            <Metric
              label="Receive rate"
              value={
                formatBytes(snapshot.traffic.receivedBytesPerSecond) + '/s'
              }
              detail={formatBytes(snapshot.traffic.receivedBytes) + ' received'}
              series={spark((point) => point.receivedBytes)}
              range={range}
            />
            <Metric
              label="Send rate"
              value={formatBytes(snapshot.traffic.sentBytesPerSecond) + '/s'}
              detail={formatBytes(snapshot.traffic.sentBytes) + ' sent'}
              series={spark((point) => point.sentBytes)}
              range={range}
            />
            <Metric
              label="Packet processing P90"
              value={formatMs(snapshot.packets.p90Ms)}
              detail={
                formatNumber(snapshot.packets.count) +
                ' packets · ' +
                formatBytes(snapshot.packets.bytes)
              }
              series={spark((point) => point.packetP90Ms)}
              range={range}
              tone="tertiary"
            />
            <Metric
              label="Connections"
              value={String(snapshot.activeConnections)}
              detail={snapshot.totalConnections + ' total'}
              series={spark((point) => point.activeConnections)}
              range={range}
            />
          </div>
          <StatsTable
            title="Traffic by source IP"
            rows={snapshot.ips}
            columns={[
              { label: 'IP', key: 'address' },
              { label: 'Active', key: 'activeConnections' },
              { label: 'Total', key: 'totalConnections' },
              { label: 'RPCs', key: 'rpcCount' },
              { label: 'Received', key: 'receivedBytes', format: formatBytes },
              {
                label: 'Receive rate',
                key: 'receivedBytesPerSecond',
                format: rateColumns,
              },
              { label: 'Sent', key: 'sentBytes', format: formatBytes },
              {
                label: 'Send rate',
                key: 'sentBytesPerSecond',
                format: rateColumns,
              },
              {
                label: 'Last seen',
                key: 'lastSeenAt',
                format: formatTimestamp,
              },
            ]}
          />
        </>
      ) : null}
      {tab === 'files' ? (
        <>
          <div className="stats-metrics">
            <Metric
              label="File route observations"
              value={formatNumber(snapshot.fileRoutes.totalFiles)}
              detail="Deduplicated file routes"
            />
            <Metric
              label="Direct-download rate"
              value={formatPercent(snapshot.fileRoutes.directRate)}
              detail={
                formatNumber(snapshot.fileRoutes.directFiles) + ' direct files'
              }
            />
            <Metric
              label="Direct files"
              value={formatNumber(snapshot.fileRoutes.directFiles)}
              detail="A direct URL was returned"
            />
            <Metric
              label="Relayed files"
              value={formatNumber(snapshot.fileRoutes.relayFiles)}
              detail="Content was sent through upload.getFile"
              tone="tertiary"
            />
          </div>
          <div className="stats-two-columns">
            <Distribution
              title="Direct and relayed files"
              slices={[
                { label: 'Direct', value: snapshot.fileRoutes.directFiles },
                { label: 'Relayed', value: snapshot.fileRoutes.relayFiles },
              ]}
            />
            <section className="panel stack">
              <h2>How to read these numbers</h2>
              <p>
                Successful direct URL responses and relayed file content are
                counted separately. Consecutive chunks for the same device,
                file, and route are deduplicated in a ten-minute window.
              </p>
              <p className="muted">
                If a direct download fails and the client falls back to
                relaying, both routes can be counted. This is a route
                observation, not a unique-download success rate.
              </p>
            </section>
          </div>
          <StatsTable
            title="File routes by device"
            rows={snapshot.fileRoutes.devices}
            columns={[
              { label: 'Device', key: 'deviceModel' },
              { label: 'System', key: 'systemVersion' },
              { label: 'Client version', key: 'appVersion' },
              { label: 'Language pack', key: 'langPack' },
              { label: 'API ID', key: 'apiId' },
              { label: 'Direct', key: 'directFiles' },
              { label: 'Relayed', key: 'relayFiles' },
              {
                label: 'Direct rate',
                key: 'directRate',
                format: formatPercent,
              },
              {
                label: 'Last seen',
                key: 'lastSeenAt',
                format: formatTimestamp,
              },
            ]}
          />
        </>
      ) : null}
      {tab === 'runtime' ? (
        <div className="stats-metrics">
          <Metric
            label="CPU"
            value={runtime.cpuPercent.toFixed(1) + '%'}
            detail={
              'Event-loop utilization ' +
              runtime.eventLoopUtilization.toFixed(1) +
              '%'
            }
            series={spark((point) => point.cpuPercent)}
            range={range}
          />
          <Metric
            label="RSS"
            value={formatBytes(runtime.rssBytes)}
            detail={'Heap ' + formatBytes(runtime.heapUsedBytes)}
            series={spark((point) => point.rssBytes)}
            range={range}
          />
          <Metric
            label="Cgroup memory"
            value={formatBytes(runtime.cgroupMemoryCurrentBytes)}
            detail={
              'Peak ' +
              formatBytes(runtime.cgroupMemoryPeakBytes) +
              ' · limit ' +
              (runtime.cgroupMemoryMaxBytes > 0
                ? formatBytes(runtime.cgroupMemoryMaxBytes)
                : 'unlimited / unavailable')
            }
            series={spark((point) => point.cgroupMemoryCurrentBytes)}
            range={range}
          />
          <Metric
            label="Cgroup anonymous memory"
            value={formatBytes(runtime.cgroupAnonBytes)}
            detail={
              'File ' +
              formatBytes(runtime.cgroupFileBytes) +
              ' · kernel ' +
              formatBytes(runtime.cgroupKernelBytes)
            }
            series={spark((point) => point.cgroupAnonBytes)}
            range={range}
          />
          <Metric
            label="Swap"
            value={formatBytes(runtime.cgroupSwapBytes)}
            detail={
              'Shared ' +
              formatBytes(runtime.cgroupShmemBytes) +
              ' · high ' +
              (runtime.cgroupMemoryHighBytes > 0
                ? formatBytes(runtime.cgroupMemoryHighBytes)
                : 'unlimited / unavailable')
            }
            series={spark((point) => point.cgroupSwapBytes)}
            range={range}
            tone="tertiary"
          />
          <Metric
            label="V8 heap"
            value={
              formatBytes(runtime.heapUsedBytes) +
              ' / ' +
              formatBytes(runtime.heapTotalBytes)
            }
            detail={
              'Limit ' +
              formatBytes(runtime.heapLimitBytes) +
              ' · available ' +
              formatBytes(runtime.heapAvailableBytes)
            }
            series={spark((point) => point.heapUsedBytes)}
            range={range}
          />
          <Metric
            label="Event-loop delay P99"
            value={formatMs(runtime.eventLoopDelayP99Ms)}
            detail={
              'Mean ' +
              formatMs(runtime.eventLoopDelayMeanMs) +
              ' · P90 ' +
              formatMs(runtime.eventLoopDelayP90Ms)
            }
            series={spark((point) => point.eventLoopDelayP99Ms)}
            range={range}
            tone="tertiary"
          />
          <Metric
            label="Garbage collection"
            value={formatMs(runtime.gcDurationMs)}
            detail={runtime.gcCount + ' collections in the current interval'}
            series={spark((point) => point.gcDurationMs)}
            range={range}
          />
          <Metric
            label="External memory"
            value={formatBytes(runtime.externalBytes)}
            detail="Native allocations tied to JavaScript objects"
            series={spark((point) => point.externalBytes)}
            range={range}
          />
          <Metric
            label="Array buffers"
            value={formatBytes(runtime.arrayBuffersBytes)}
            detail="Buffer and typed-array backing stores"
            series={spark((point) => point.arrayBuffersBytes)}
            range={range}
          />
          <Metric
            label="V8 malloc"
            value={formatBytes(runtime.mallocedBytes)}
            detail={'Peak ' + formatBytes(runtime.peakMallocedBytes)}
          />
          <Metric
            label="V8 contexts"
            value={String(runtime.nativeContexts)}
            detail={runtime.detachedContexts + ' detached'}
          />
          <Metric
            label="Uptime"
            value={uptime(runtime.uptimeSeconds)}
            detail={'Statistics began ' + formatTimestamp(snapshot.startedAt)}
          />
        </div>
      ) : null}
    </div>
  )
}
function Metric(props: {
  label: string
  value: string
  detail?: string
  series?: SampleValue[]
  range?: SeriesRange
  tone?: ChartTone
  format?: (value: number) => string
}) {
  return (
    <article className={'panel stat-metric tone-' + (props.tone ?? 'primary')}>
      <span className="eyebrow">{props.label}</span>
      <strong>{props.value}</strong>
      <p>{props.detail}</p>
      <Sparkline
        series={props.series}
        range={props.range}
        tone={props.tone}
        label={props.label}
        format={props.format}
      />
    </article>
  )
}
function Distribution(props: {
  title: string
  slices: { label: string; value: number }[]
}) {
  return (
    <section className="panel stack">
      <h2>{props.title}</h2>
      <DistributionChart slices={props.slices} />
    </section>
  )
}
export function StatsTable<T extends object>(props: {
  title: string
  rows: T[]
  columns: Column<T>[]
}) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const rows = useMemo(() => {
    const needle = query.toLowerCase()
    return needle
      ? props.rows.filter((row) =>
          props.columns.some((column) =>
            displayValue(row[column.key]).toLowerCase().includes(needle),
          ),
        )
      : props.rows
  }, [props.columns, props.rows, query])
  useEffect(() => {
    if (page * 25 >= rows.length)
      setPage(Math.max(0, Math.ceil(rows.length / 25) - 1))
  }, [page, rows.length])
  return (
    <section className="panel stack">
      <header className="toolbar">
        <h2 className="grow">{props.title}</h2>
        {props.rows.length > 10 ? (
          <label className="field">
            <span className="sr-only">{'Search ' + props.title}</span>
            <input
              type="search"
              placeholder="Filter rows…"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value)
                setPage(0)
              }}
            />
          </label>
        ) : null}
      </header>
      <div className="table-scroll" tabIndex={0} aria-label={props.title}>
        <table>
          <thead>
            <tr>
              {props.columns.map((column) => (
                <th key={column.label}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(page * 25, (page + 1) * 25).map((row, index) => (
              <tr key={index}>
                {props.columns.map((column) => (
                  <td key={column.label} title={displayValue(row[column.key])}>
                    {column.format
                      ? column.format(row[column.key])
                      : displayValue(row[column.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length ? null : <p className="muted">No observations yet.</p>}
      {rows.length > 25 ? (
        <div className="pagination">
          <button
            className="button outlined"
            disabled={!page}
            onClick={() => setPage(page - 1)}
          >
            Previous page
          </button>
          <span>{rows.length} rows</span>
          <button
            className="button outlined"
            disabled={(page + 1) * 25 >= rows.length}
            onClick={() => setPage(page + 1)}
          >
            Next page
          </button>
        </div>
      ) : null}
    </section>
  )
}
