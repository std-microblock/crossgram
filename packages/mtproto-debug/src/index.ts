import type { Context } from 'cordis'
import type { MtprotoDebugEvent } from '@mtproto-relay/mtproto'
import z from 'schemastery'
import { serializeDebugEvent } from './serialize.js'
import type { CapturedMtprotoEvent, MtprotoDebugData } from './types.js'

export const name = 'mtproto-debug'
export const inject = ['mtproto', 'webui', 'timer']

export interface Config {
  maxEvents?: number
  initiallyPaused?: boolean
}

export const Config = z.object({
  maxEvents: z.natural().min(100).max(20_000).default(2_000)
    .description('Maximum number of decoded MTProto events retained in memory.'),
  initiallyPaused: z.boolean().default(false)
    .description('Wait for the user to start capture after startup.'),
})

export function apply(ctx: Context, config: Config = {}): void {
  const maxEvents = config.maxEvents ?? 2_000
  let nextId = 0
  let pending: CapturedMtprotoEvent[] = []

  const data: MtprotoDebugData = {
    capturing: !(config.initiallyPaused ?? false),
    events: [],
    dropped: 0,
    maxEvents,
    async start() {
      entry.mutate(value => { value.capturing = true })
    },
    async pause() {
      flush()
      entry.mutate(value => { value.capturing = false })
    },
    async clear() {
      pending = []
      entry.mutate((value) => {
        value.events.splice(0)
        value.dropped = 0
      })
    },
  }

  const entry = ctx.webui.addEntry({
    baseUrl: import.meta.url,
    source: '../client/index.ts',
    manifest: '../dist/manifest.json',
    routes: ['/mtproto-debug'],
  }, data)

  const flush = () => {
    if (!pending.length) return
    const batch = pending
    pending = []
    entry.mutate((value) => {
      value.events.push(...batch)
      const overflow = value.events.length - maxEvents
      if (overflow > 0) {
        value.events.splice(0, overflow)
        value.dropped += overflow
      }
    })
  }
  const scheduleFlush = ctx.throttle(flush, 50)
  const onDebug = (event: MtprotoDebugEvent) => {
    if (!data.capturing) return
    pending.push(serializeDebugEvent(event, ++nextId))
    scheduleFlush()
  }

  ctx.mtproto.onDebug.add(onDebug)
  ctx.effect(() => () => {
    ctx.mtproto.onDebug.remove(onDebug)
    pending = []
  }, 'mtproto-debug.capture')
}

export type { CapturedMtprotoEvent, MtprotoDebugData } from './types.js'
export { serializeDebugEvent, toDebugJson } from './serialize.js'

export default Object.assign(apply, { inject })
