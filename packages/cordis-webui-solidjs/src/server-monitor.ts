import type { Context } from 'cordis'
import type { Route } from '@cordisjs/plugin-server'
import z from 'schemastery'
import type SolidWebUI from './index.js'
export interface ServerRoute {
  id: string
  method: string
  path: string
  interceptPath?: string
  plugin?: string
  requests: number
  totalLatency: number
  avgLatency: number
  lastStatus?: number
}
export interface ServerRequest {
  id: number
  startTime: number
  endTime?: number
  method: string
  path: string
  status: number
  bytesIn?: number
  bytesOut?: number
  remote?: string
  route?: string
  plugin?: string
  aborted?: boolean
}
export interface Data {
  listening: boolean
  host: string
  port: number
  baseUrl: string
  routes: Record<string, ServerRoute>
  requests: ServerRequest[]
  requestLimit: number
  clear(): Promise<void>
}
export const name = 'webui-solidjs-server'
export const inject = ['server', 'webui']
export const Config = z.object({
  requestLimit: z.natural().max(2000).default(500),
})
export function apply(ctx: Context, config: { requestLimit?: number } = {}) {
  const limit = Math.max(0, Math.min(2000, config.requestLimit ?? 500))
  const webui = ctx.get('webui') as unknown as SolidWebUI
  const active = new WeakMap<object, ServerRequest>(),
    cleanup = new Set<() => void>()
  let sequence = 0,
    stopped = false,
    refreshTimer: ReturnType<typeof setTimeout> | undefined
  const routeInfo = (route: Route) => {
    const method = 'method' in route ? String(route.method).toUpperCase() : 'WS'
    const path = String(route.path),
      interceptPath = route.config?.path
    return {
      id: method + ' ' + (interceptPath ?? '') + path,
      method,
      path,
      interceptPath,
      plugin: route.fiber ? ctx.get('loader')?.locate(route.fiber) : undefined,
    }
  }
  const collect = (previous: Record<string, ServerRoute>) =>
    Object.fromEntries(
      [...ctx.server.httpRoutes, ...ctx.server.wsRoutes].map((route) => {
        const info = routeInfo(route),
          old = previous[info.id]
        return [
          info.id,
          {
            requests: old?.requests ?? 0,
            totalLatency: old?.totalLatency ?? 0,
            avgLatency: old?.avgLatency ?? 0,
            lastStatus: old?.lastStatus,
            ...info,
          },
        ]
      }),
    )
  const data: Data = {
    listening: !!ctx.server.port,
    host: ctx.server.host,
    port: ctx.server.port,
    baseUrl: ctx.server.baseUrl,
    routes: collect({}),
    requests: [],
    requestLimit: limit,
    async clear() {
      entry.mutate((value) => {
        value.requests = []
        for (const route of Object.values(value.routes)) {
          route.requests = 0
          route.totalLatency = 0
          route.avgLatency = 0
          delete route.lastStatus
        }
      })
    },
  }
  const entry = webui.addEntry<Data>(
    {
      baseUrl: import.meta.url,
      client: 'server',
      routes: ['/server/routes', '/server/requests'],
    },
    data,
  )
  const begin = (req: {
    _req: object
    method: string
    path: string
    headers: Headers
  }) => {
    const record: ServerRequest = {
      id: ++sequence,
      startTime: Date.now(),
      method: req.method,
      path: req.path,
      status: 0,
      bytesIn: size(req.headers.get('content-length')),
      remote: (req._req as any).socket?.remoteAddress,
    }
    active.set(req._req, record)
    entry.mutate((value) => {
      if (limit) {
        value.requests.push(record)
        if (value.requests.length > limit)
          value.requests.splice(0, value.requests.length - limit)
      }
    })
    return record
  }
  const finish = (
    record: ServerRequest,
    status: number,
    bytesOut?: number,
    aborted = false,
  ) => {
    if (stopped || record.endTime) return
    const endTime = Date.now()
    entry.mutate((value) => {
      const row = value.requests.find((row) => row.id === record.id)
      if (row)
        Object.assign(row, {
          endTime,
          status,
          bytesOut,
          aborted,
          route: record.route,
          plugin: record.plugin,
        })
      const route = record.route ? value.routes[record.route] : undefined
      if (route) {
        route.requests++
        route.totalLatency += endTime - record.startTime
        route.avgLatency = route.totalLatency / route.requests
        route.lastStatus = status
      }
    })
    // A record can already have aged out of the bounded UI window.
    record.endTime = endTime
  }
  // Prepend is essential: normal routes often finish without calling later middleware.
  ctx.on(
    'server/request',
    async (req, res, next) => {
      const record = begin(req)
      const dispose = () => {
        res._res.off('finish', completed)
        res._res.off('close', closed)
        cleanup.delete(dispose)
      }
      const completed = () => {
        dispose()
        finish(
          record,
          res._res.statusCode,
          size(res._res.getHeader('content-length')),
        )
      }
      const closed = () => {
        dispose()
        finish(
          record,
          res._res.statusCode,
          size(res._res.getHeader('content-length')),
          !res._res.writableFinished,
        )
      }
      cleanup.add(dispose)
      res._res.once('finish', completed)
      res._res.once('close', closed)
      await next()
    },
    { prepend: true },
  )
  ctx.on(
    'server/route-request',
    async (req, res, route, next) => {
      const record = active.get(req._req)
      const assign = () => {
        if (record && !record.route) {
          // Inner handlers claim first; do not attribute their work to an outer SPA fallback.
          const info = routeInfo(route)
          record.route = info.id
          record.plugin = info.plugin
        }
      }
      try {
        const response = await next()
        if (response || res.claimed) assign()
        return response
      } catch (error) {
        assign()
        throw error
      }
    },
    { prepend: true },
  )
  ctx.on(
    'server/upgrade',
    async (req, next) => {
      const record = begin(req)
      record.method = 'WS'
      const matched = [...ctx.server.wsRoutes].find((route) => route.check(req))
      const before = new Set(matched?.clients)
      if (matched) {
        const info = routeInfo(matched)
        record.route = info.id
        record.plugin = info.plugin
      }
      try {
        await next()
        const socket = [...(matched?.clients ?? [])].find(
          (client) => !before.has(client),
        )
        if (!socket) {
          finish(record, 400)
          return
        }
        entry.mutate((value) => {
          const row = value.requests.find((row) => row.id === record.id)
          if (row) {
            row.method = 'WS'
            row.status = 101
            row.route = record.route
          }
        })
        const closed = () => {
          dispose()
          finish(record, 101)
        }
        const dispose = () => {
          socket.off('close', closed)
          cleanup.delete(dispose)
        }
        cleanup.add(dispose)
        socket.once('close', closed)
        if (socket.readyState >= 2) closed()
      } catch (error) {
        finish(record, 500)
        throw error
      }
    },
    { prepend: true },
  )
  const scheduleRefresh = () => {
    refreshTimer ??= setTimeout(() => {
      refreshTimer = undefined
      if (!stopped)
        entry.mutate((value) => {
          value.routes = collect(value.routes)
        })
    }, 0)
  }
  ctx.on('internal/plugin', scheduleRefresh)
  ctx.on('internal/status', scheduleRefresh)
  ctx.effect(
    () => () => {
      stopped = true
      clearTimeout(refreshTimer)
      for (const dispose of cleanup) dispose()
      cleanup.clear()
    },
    'webui-solidjs.server-monitor',
  )
}
function size(value: unknown): number | undefined {
  const number = Number(value)
  return value !== null &&
    value !== undefined &&
    Number.isFinite(number) &&
    number >= 0
    ? number
    : undefined
}
