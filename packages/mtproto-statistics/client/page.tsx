/** @jsxImportSource solid-js */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Show,
  type JSX,
} from 'solid-js'
import type {
  MtprotoStatisticsData,
  StatisticsPoint,
  StatisticsSeries,
  StatisticsSnapshot,
} from '../src/types.js'
import { useRpc, type PageProps } from 'cordis-webui-solidjs/client'
import {
  ConfirmAction,
  formatBytes,
  formatNumber,
  LiveContent,
  PageHeader,
} from 'cordis-webui-solidjs/components'
import { displayValue } from 'cordis-webui-solidjs/utils'
import {
  distributionSlices,
  formatMs,
  formatPercent,
  formatTimestamp,
  sparkPath,
  uptime,
} from './statistics-model.js'
type Tab = 'overview' | 'rpc' | 'network' | 'files' | 'runtime'
const tabs: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'rpc', label: 'RPC' },
  { id: 'network', label: 'Network & IPs' },
  { id: 'files', label: 'File routes' },
  { id: 'runtime', label: 'Runtime' },
]
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
        <Show when={rpc.data.snapshot}>
          {(snapshot) => (
            <StatisticsDashboard
              snapshot={snapshot()}
              series={rpc.data.series}
            />
          )}
        </Show>
      </LiveContent>
    </>
  )
}
export function StatisticsDashboard(props: {
  snapshot: StatisticsSnapshot
  series: StatisticsSeries
}) {
  const [tab, setTab] = createSignal<Tab>('overview'),
    [range, setRange] = createSignal<keyof StatisticsSeries>('seconds')
  const snapshot = () => props.snapshot,
    points = () => props.series?.[range()] ?? []
  const values = (key: keyof StatisticsPoint) =>
    points().map((point) => point[key])
  const runtime = () => snapshot().runtime
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
  return (
    <div class="stack statistics-dashboard">
      <div class="stats-toolbar">
        <div class="segmented" role="tablist" aria-label="Statistics sections">
          <For each={tabs}>
            {(item) => (
              <button
                role="tab"
                aria-selected={tab() === item.id}
                classList={{ selected: tab() === item.id }}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            )}
          </For>
        </div>
        <label class="field">
          <span class="sr-only">Chart interval</span>
          <select
            aria-label="Chart interval"
            value={range()}
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
      <p class="muted">
        Updated {formatTimestamp(snapshot().updatedAt)} · {points().length}{' '}
        samples · only this page subscribes to statistics
      </p>
      <Show when={tab() === 'overview'}>
        <div class="stats-metrics">
          <Metric
            label={
              'RPC calls / ' +
              (range() === 'seconds'
                ? 'sample'
                : range() === 'minutes'
                  ? 'minute'
                  : 'hour')
            }
            value={formatNumber(points().at(-1)?.rpcCount ?? 0)}
            detail={formatNumber(snapshot().rpc.count) + ' total calls'}
            values={values('rpcCount')}
          />
          <Metric
            label="RPC P90"
            value={formatMs(snapshot().rpc.p90Ms)}
            detail={'P99 ' + formatMs(snapshot().rpc.p99Ms)}
            values={values('rpcP90Ms')}
            tone="tertiary"
          />
          <Metric
            label="Network throughput"
            value={
              formatBytes(
                snapshot().traffic.receivedBytesPerSecond +
                  snapshot().traffic.sentBytesPerSecond,
              ) + '/s'
            }
            detail={
              '↓ ' +
              formatBytes(snapshot().traffic.receivedBytesPerSecond) +
              '/s · ↑ ' +
              formatBytes(snapshot().traffic.sentBytesPerSecond) +
              '/s'
            }
            values={points().map(
              (point) => point.receivedBytes + point.sentBytes,
            )}
          />
          <Metric
            label="Active connections"
            value={formatNumber(snapshot().activeConnections)}
            detail={
              formatNumber(snapshot().totalConnections) +
              ' lifetime connections'
            }
            values={values('activeConnections')}
          />
          <Metric
            label="CPU"
            value={runtime().cpuPercent.toFixed(1) + '%'}
            detail={
              'Event-loop utilization ' +
              runtime().eventLoopUtilization.toFixed(1) +
              '%'
            }
            values={values('cpuPercent')}
            tone="tertiary"
          />
          <Metric
            label="Resident memory"
            value={formatBytes(runtime().rssBytes)}
            detail={
              'Heap ' +
              formatBytes(runtime().heapUsedBytes) +
              ' / ' +
              formatBytes(runtime().heapTotalBytes)
            }
            values={values('rssBytes')}
          />
        </div>
        <StatsTable
          title="Slowest RPC methods"
          rows={snapshot().methods.slice(0, 10)}
          columns={methodColumns}
        />
        <StatsTable
          title="Recent slow requests"
          rows={snapshot().slowest.slice(0, 10)}
          columns={slowColumns}
        />
      </Show>
      <Show when={tab() === 'rpc'}>
        <div class="stats-metrics">
          <Metric
            label="Average RPC latency"
            value={formatMs(snapshot().rpc.averageMs)}
            detail={formatNumber(snapshot().rpc.count) + ' calls'}
            values={values('rpcP90Ms')}
          />
          <Metric
            label="P50 / P90"
            value={
              formatMs(snapshot().rpc.p50Ms) +
              ' / ' +
              formatMs(snapshot().rpc.p90Ms)
            }
            detail={'P95 ' + formatMs(snapshot().rpc.p95Ms)}
            values={values('rpcP90Ms')}
          />
          <Metric
            label="P99 / maximum"
            value={
              formatMs(snapshot().rpc.p99Ms) +
              ' / ' +
              formatMs(snapshot().rpc.maxMs)
            }
            detail="Tail latency"
            values={values('rpcP99Ms')}
            tone="tertiary"
          />
          <Metric
            label="RPC error rate"
            value={formatPercent(snapshot().rpc.errorRate)}
            detail={formatNumber(snapshot().rpc.errors) + ' errors'}
            values={values('rpcErrors')}
            tone="error"
          />
        </div>
        <div class="stats-two-columns">
          <Distribution
            title="RPC method distribution"
            slices={distributionSlices(
              snapshot().methodDistribution,
              snapshot().rpc.count,
            )}
          />
          <Distribution
            title="Successful and failed calls"
            slices={[
              {
                label: 'Success',
                value: Math.max(
                  0,
                  snapshot().rpc.count - snapshot().rpc.errors,
                ),
              },
              { label: 'Errors', value: snapshot().rpc.errors },
            ]}
          />
        </div>
        <StatsTable
          title="RPC methods"
          rows={snapshot().methods}
          columns={methodColumns}
        />
        <StatsTable
          title="RPC failure reasons"
          rows={snapshot().failureReasons}
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
            { label: 'Last seen', key: 'lastSeenAt', format: formatTimestamp },
          ]}
        />
        <div class="stats-two-columns">
          <StatsTable
            title="Failure categories"
            rows={snapshot().failures}
            columns={[
              { label: 'Category', key: 'category' },
              { label: 'Code', key: 'errorCode' },
              { label: 'Count', key: 'count' },
              { label: 'Share', key: 'rate', format: formatPercent },
            ]}
          />
          <StatsTable
            title={
              'Missing RPC methods · ' + snapshot().missingRpcs.count + ' hits'
            }
            rows={snapshot().missingRpcs.methods}
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
          rows={snapshot().recentFailures}
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
          rows={snapshot().slowest}
          columns={slowColumns}
        />
      </Show>
      <Show when={tab() === 'network'}>
        <div class="stats-metrics">
          <Metric
            label="Receive rate"
            value={
              formatBytes(snapshot().traffic.receivedBytesPerSecond) + '/s'
            }
            detail={formatBytes(snapshot().traffic.receivedBytes) + ' received'}
            values={values('receivedBytes')}
          />
          <Metric
            label="Send rate"
            value={formatBytes(snapshot().traffic.sentBytesPerSecond) + '/s'}
            detail={formatBytes(snapshot().traffic.sentBytes) + ' sent'}
            values={values('sentBytes')}
          />
          <Metric
            label="Packet processing P90"
            value={formatMs(snapshot().packets.p90Ms)}
            detail={
              formatNumber(snapshot().packets.count) +
              ' packets · ' +
              formatBytes(snapshot().packets.bytes)
            }
            values={values('packetP90Ms')}
            tone="tertiary"
          />
          <Metric
            label="Connections"
            value={String(snapshot().activeConnections)}
            detail={snapshot().totalConnections + ' total'}
            values={values('activeConnections')}
          />
        </div>
        <StatsTable
          title="Traffic by source IP"
          rows={snapshot().ips}
          columns={[
            { label: 'IP', key: 'address' },
            { label: 'Active', key: 'activeConnections' },
            { label: 'Total', key: 'totalConnections' },
            { label: 'RPCs', key: 'rpcCount' },
            { label: 'Received', key: 'receivedBytes', format: formatBytes },
            {
              label: 'Receive rate',
              key: 'receivedBytesPerSecond',
              format: (value) => formatBytes(value) + '/s',
            },
            { label: 'Sent', key: 'sentBytes', format: formatBytes },
            {
              label: 'Send rate',
              key: 'sentBytesPerSecond',
              format: (value) => formatBytes(value) + '/s',
            },
            { label: 'Last seen', key: 'lastSeenAt', format: formatTimestamp },
          ]}
        />
      </Show>
      <Show when={tab() === 'files'}>
        <div class="stats-metrics">
          <Metric
            label="File route observations"
            value={formatNumber(snapshot().fileRoutes.totalFiles)}
            detail="Deduplicated file routes"
          />
          <Metric
            label="Direct-download rate"
            value={formatPercent(snapshot().fileRoutes.directRate)}
            detail={
              formatNumber(snapshot().fileRoutes.directFiles) + ' direct files'
            }
          />
          <Metric
            label="Direct files"
            value={formatNumber(snapshot().fileRoutes.directFiles)}
            detail="A direct URL was returned"
          />
          <Metric
            label="Relayed files"
            value={formatNumber(snapshot().fileRoutes.relayFiles)}
            detail="Content was sent through upload.getFile"
            tone="tertiary"
          />
        </div>
        <div class="stats-two-columns">
          <Distribution
            title="Direct and relayed files"
            slices={[
              { label: 'Direct', value: snapshot().fileRoutes.directFiles },
              { label: 'Relayed', value: snapshot().fileRoutes.relayFiles },
            ]}
          />
          <section class="panel stack">
            <h2>How to read these numbers</h2>
            <p>
              Successful direct URL responses and relayed file content are
              counted separately. Consecutive chunks for the same device, file,
              and route are deduplicated in a ten-minute window.
            </p>
            <p class="muted">
              If a direct download fails and the client falls back to relaying,
              both routes can be counted. This is a route observation, not a
              unique-download success rate.
            </p>
          </section>
        </div>
        <StatsTable
          title="File routes by device"
          rows={snapshot().fileRoutes.devices}
          columns={[
            { label: 'Device', key: 'deviceModel' },
            { label: 'System', key: 'systemVersion' },
            { label: 'Client version', key: 'appVersion' },
            { label: 'Language pack', key: 'langPack' },
            { label: 'API ID', key: 'apiId' },
            { label: 'Direct', key: 'directFiles' },
            { label: 'Relayed', key: 'relayFiles' },
            { label: 'Direct rate', key: 'directRate', format: formatPercent },
            { label: 'Last seen', key: 'lastSeenAt', format: formatTimestamp },
          ]}
        />
      </Show>
      <Show when={tab() === 'runtime'}>
        <div class="stats-metrics">
          <Metric
            label="CPU"
            value={runtime().cpuPercent.toFixed(1) + '%'}
            detail={
              'Event-loop utilization ' +
              runtime().eventLoopUtilization.toFixed(1) +
              '%'
            }
            values={values('cpuPercent')}
          />
          <Metric
            label="RSS"
            value={formatBytes(runtime().rssBytes)}
            detail={'Heap ' + formatBytes(runtime().heapUsedBytes)}
            values={values('rssBytes')}
          />
          <Metric
            label="Cgroup memory"
            value={formatBytes(runtime().cgroupMemoryCurrentBytes)}
            detail={
              'Peak ' +
              formatBytes(runtime().cgroupMemoryPeakBytes) +
              ' · limit ' +
              (runtime().cgroupMemoryMaxBytes > 0
                ? formatBytes(runtime().cgroupMemoryMaxBytes)
                : 'unlimited / unavailable')
            }
            values={values('cgroupMemoryCurrentBytes')}
          />
          <Metric
            label="Cgroup anonymous memory"
            value={formatBytes(runtime().cgroupAnonBytes)}
            detail={
              'File ' +
              formatBytes(runtime().cgroupFileBytes) +
              ' · kernel ' +
              formatBytes(runtime().cgroupKernelBytes)
            }
            values={values('cgroupAnonBytes')}
          />
          <Metric
            label="Swap"
            value={formatBytes(runtime().cgroupSwapBytes)}
            detail={
              'Shared ' +
              formatBytes(runtime().cgroupShmemBytes) +
              ' · high ' +
              (runtime().cgroupMemoryHighBytes > 0
                ? formatBytes(runtime().cgroupMemoryHighBytes)
                : 'unlimited / unavailable')
            }
            values={values('cgroupSwapBytes')}
            tone="tertiary"
          />
          <Metric
            label="V8 heap"
            value={
              formatBytes(runtime().heapUsedBytes) +
              ' / ' +
              formatBytes(runtime().heapTotalBytes)
            }
            detail={
              'Limit ' +
              formatBytes(runtime().heapLimitBytes) +
              ' · available ' +
              formatBytes(runtime().heapAvailableBytes)
            }
            values={values('heapUsedBytes')}
          />
          <Metric
            label="Event-loop delay P99"
            value={formatMs(runtime().eventLoopDelayP99Ms)}
            detail={
              'Mean ' +
              formatMs(runtime().eventLoopDelayMeanMs) +
              ' · P90 ' +
              formatMs(runtime().eventLoopDelayP90Ms)
            }
            values={values('eventLoopDelayP99Ms')}
            tone="tertiary"
          />
          <Metric
            label="Garbage collection"
            value={formatMs(runtime().gcDurationMs)}
            detail={runtime().gcCount + ' collections in the current interval'}
            values={values('gcDurationMs')}
          />
          <Metric
            label="External memory"
            value={formatBytes(runtime().externalBytes)}
            detail="Native allocations tied to JavaScript objects"
            values={values('externalBytes')}
          />
          <Metric
            label="Array buffers"
            value={formatBytes(runtime().arrayBuffersBytes)}
            detail="Buffer and typed-array backing stores"
            values={values('arrayBuffersBytes')}
          />
          <Metric
            label="V8 malloc"
            value={formatBytes(runtime().mallocedBytes)}
            detail={'Peak ' + formatBytes(runtime().peakMallocedBytes)}
          />
          <Metric
            label="V8 contexts"
            value={String(runtime().nativeContexts)}
            detail={runtime().detachedContexts + ' detached'}
          />
          <Metric
            label="Uptime"
            value={uptime(runtime().uptimeSeconds)}
            detail={'Statistics began ' + formatTimestamp(snapshot().startedAt)}
          />
        </div>
      </Show>
    </div>
  )
}
function Metric(props: {
  label: string
  value: string
  detail?: string
  values?: number[]
  tone?: string
}) {
  const path = createMemo(() => sparkPath(props.values ?? []))
  return (
    <article class={'panel stat-metric tone-' + (props.tone ?? 'primary')}>
      <span class="eyebrow">{props.label}</span>
      <strong>{props.value}</strong>
      <p>{props.detail}</p>
      <Show when={props.values?.length}>
        <svg
          class="stat-spark"
          viewBox="0 0 300 72"
          preserveAspectRatio="none"
          role="img"
          aria-label={props.label + ' history'}
        >
          <path d={path() + ' L300,72 L0,72 Z'} class="spark-fill" />
          <path d={path()} class="spark-line" />
        </svg>
      </Show>
    </article>
  )
}
function Distribution(props: {
  title: string
  slices: { label: string; value: number }[]
}) {
  const total = () =>
    props.slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0)
  return (
    <section class="panel stack">
      <h2>{props.title}</h2>
      <div class="distribution-bars">
        <For each={props.slices.filter((slice) => slice.value > 0)}>
          {(slice, index) => (
            <div class="distribution-row">
              <div>
                <span title={slice.label}>{slice.label}</span>
                <strong>
                  {formatNumber(slice.value)}{' '}
                  <small>
                    {formatPercent(total() ? slice.value / total() : 0)}
                  </small>
                </strong>
              </div>
              <div class="distribution-track">
                <span
                  class={'distribution-tone-' + (index() % 3)}
                  style={{
                    width: (total() ? (slice.value / total()) * 100 : 0) + '%',
                  }}
                />
              </div>
            </div>
          )}
        </For>
        <Show when={!total()}>
          <p class="muted">No observations yet.</p>
        </Show>
      </div>
    </section>
  )
}
interface Column<T> {
  label: string
  key: keyof T
  format?: (value: any) => string
}
export function StatsTable<T extends object>(props: {
  title: string
  rows: T[]
  columns: Column<T>[]
}) {
  const [query, setQuery] = createSignal(''),
    [page, setPage] = createSignal(0)
  const rows = createMemo(() => {
    const needle = query().toLowerCase()
    return needle
      ? props.rows.filter((row) =>
          props.columns.some((column) =>
            displayValue(row[column.key]).toLowerCase().includes(needle),
          ),
        )
      : props.rows
  })
  createEffect(() => {
    if (page() * 25 >= rows().length)
      setPage(Math.max(0, Math.ceil(rows().length / 25) - 1))
  })
  return (
    <section class="panel stack">
      <header class="toolbar">
        <h2 class="grow">{props.title}</h2>
        <Show when={props.rows.length > 10}>
          <label class="field">
            <span class="sr-only">{'Search ' + props.title}</span>
            <input
              type="search"
              placeholder="Filter rows…"
              value={query()}
              onInput={(event) => {
                setQuery(event.currentTarget.value)
                setPage(0)
              }}
            />
          </label>
        </Show>
      </header>
      <div class="table-scroll" tabindex="0" aria-label={props.title}>
        <table>
          <thead>
            <tr>
              <For each={props.columns}>
                {(column) => <th>{column.label}</th>}
              </For>
            </tr>
          </thead>
          <tbody>
            <Index each={rows().slice(page() * 25, (page() + 1) * 25)}>
              {(row) => (
                <tr>
                  <For each={props.columns}>
                    {(column) => (
                      <td title={displayValue(row()[column.key])}>
                        {column.format
                          ? column.format(row()[column.key])
                          : displayValue(row()[column.key])}
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </Index>
          </tbody>
        </table>
      </div>
      <Show when={!rows().length}>
        <p class="muted">No observations yet.</p>
      </Show>
      <Show when={rows().length > 25}>
        <div class="pagination">
          <button
            class="button outlined"
            disabled={!page()}
            onClick={() => setPage(page() - 1)}
          >
            Previous page
          </button>
          <span>{rows().length} rows</span>
          <button
            class="button outlined"
            disabled={(page() + 1) * 25 >= rows().length}
            onClick={() => setPage(page() + 1)}
          >
            Next page
          </button>
        </div>
      </Show>
    </section>
  )
}
