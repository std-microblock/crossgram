import { useEffect, useId, useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatNumber } from 'cordis-webui-react/components'
import { formatPercent } from './statistics-model.js'

export type ChartTone = 'primary' | 'secondary' | 'tertiary' | 'error'

interface TooltipPayload {
  value?: number | string
  payload?: { label?: string }
}

interface ChartColors {
  tone: Record<ChartTone, string>
  grid: string
  muted: string
  surface: string
  hover: string
  text: string
}

const fallback: ChartColors = {
  tone: {
    primary: '#48632f',
    secondary: '#1d4e63',
    tertiary: '#5b2b3d',
    error: '#b3261e',
  },
  grid: '#e3e5dd',
  muted: '#6b7168',
  surface: '#ffffff',
  hover: '#f1f3ec',
  text: '#1b1f1c',
}

/** Recharts takes concrete colors, so resolve the DSH tokens whenever the theme changes. */
function readColors(): ChartColors {
  if (typeof document === 'undefined') return fallback
  const style = getComputedStyle(document.documentElement)
  const token = (name: string, value: string) =>
    style.getPropertyValue(name).trim() || value
  return {
    tone: {
      primary: token('--primary', fallback.tone.primary),
      secondary: token('--on-secondary-container', fallback.tone.secondary),
      tertiary: token('--on-tertiary-container', fallback.tone.tertiary),
      error: token('--error', fallback.tone.error),
    },
    grid: token('--outline-variant', fallback.grid),
    muted: token('--on-surface-muted', fallback.muted),
    surface: token('--surface', fallback.surface),
    hover: token('--surface-container', fallback.hover),
    text: token('--on-surface', fallback.text),
  }
}

export function useChartColors(): ChartColors {
  const [colors, setColors] = useState(readColors)
  useEffect(() => {
    const update = () => setColors(readColors())
    const media = matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', update)
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-appearance'],
    })
    return () => {
      media.removeEventListener('change', update)
      observer.disconnect()
    }
  }, [])
  return colors
}

function SparkTooltip(props: {
  active?: boolean
  payload?: TooltipPayload[]
  format?: (value: number) => string
}) {
  if (!props.active || !props.payload?.length) return null
  const value = Number(props.payload[0]?.value ?? 0)
  return (
    <div className="chart-tooltip">
      {props.format ? props.format(value) : formatNumber(value)}
    </div>
  )
}

/** A compact trend line for a metric card. */
export function Sparkline(props: {
  values?: number[]
  tone?: ChartTone
  label: string
  format?: (value: number) => string
}) {
  const colors = useChartColors()
  const gradient = 'spark-' + useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const data = useMemo(
    () => (props.values ?? []).map((value, index) => ({ index, value })),
    [props.values],
  )
  if (!data.length) return null
  const color = colors.tone[props.tone ?? 'primary']
  return (
    <div className="stat-spark" role="img" aria-label={props.label + ' history'}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 6, right: 0, bottom: 0, left: 0 }}
        >
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.26} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <XAxis dataKey="index" hide />
          <YAxis hide domain={['auto', 'auto']} />
          <Tooltip
            content={(tip: any) => (
              <SparkTooltip {...tip} format={props.format} />
            )}
            cursor={{
              stroke: colors.muted,
              strokeOpacity: 0.4,
              strokeDasharray: '3 3',
            }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.6}
            fill={'url(#' + gradient + ')'}
            dot={false}
            activeDot={{ r: 3, fill: color, stroke: colors.surface, strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function SliceTooltip(props: {
  active?: boolean
  payload?: TooltipPayload[]
  total: number
}) {
  const item = props.payload?.[0]
  if (!props.active || !item) return null
  const value = Number(item.value ?? 0)
  return (
    <div className="chart-tooltip">
      <strong>{item.payload?.label}</strong>
      <span>
        {formatNumber(value)} ·{' '}
        {formatPercent(props.total ? value / props.total : 0)}
      </span>
    </div>
  )
}

/** Horizontal distribution bars driven by the chart library. */
export function DistributionChart(props: {
  slices: { label: string; value: number }[]
}) {
  const colors = useChartColors()
  const rows = props.slices.filter((slice) => slice.value > 0)
  const total = rows.reduce((sum, slice) => sum + slice.value, 0)
  if (!rows.length)
    return <p className="muted">No observations yet.</p>
  return (
    <div
      className="distribution-chart"
      style={{ height: Math.max(96, rows.length * 32) }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 0, right: 46, bottom: 0, left: 0 }}
          barCategoryGap={10}
        >
          <XAxis type="number" hide domain={[0, total || 1]} />
          <YAxis
            type="category"
            dataKey="label"
            width={126}
            axisLine={false}
            tickLine={false}
            tick={{ fill: colors.muted, fontSize: 11 }}
            tickFormatter={(value: string) =>
              value.length > 21 ? value.slice(0, 20) + '…' : value
            }
          />
          <Tooltip
            cursor={{ fill: colors.hover, opacity: 0.7 }}
            content={(tip: any) => <SliceTooltip {...tip} total={total} />}
          />
          <Bar
            dataKey="value"
            fill={colors.tone.primary}
            radius={[0, 6, 6, 0]}
            barSize={12}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="value"
              position="right"
              formatter={(value) => formatNumber(Number(value))}
              fill={colors.muted}
              fontSize={11}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
