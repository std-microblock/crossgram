import { describe, expect, it } from 'vitest'
import {
  BoundedResponse, bridgeRequestTimedOutError, DEFAULT_QQNT_CLIENT_TIMEOUTS, isQQNTUpstreamTimeout,
  nativeMediaBodyStalledError, nativeMediaTimedOutError, resolveQQNTClientTimeouts, UpstreamBodyReader,
  UpstreamDeadline,
} from './upstream-timeout.js'

async function waitUntil(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('QQNT upstream timeout budget', () => {
  it('keeps bounded defaults and refuses to disable a budget with a bad value', () => {
    expect(resolveQQNTClientTimeouts()).toEqual(DEFAULT_QQNT_CLIENT_TIMEOUTS)
    expect(DEFAULT_QQNT_CLIENT_TIMEOUTS).toEqual({
      bridgeMs: 20_000, connectMs: 15_000, bodyStallMs: 20_000, longBridgeMs: 120_000,
    })
    // 0 / 负数 / NaN / Infinity 都不能把「有界」配成「无界」。
    expect(resolveQQNTClientTimeouts({
      bridgeMs: 0,
      connectMs: -1,
      bodyStallMs: Number.NaN,
      longBridgeMs: Number.POSITIVE_INFINITY,
    })).toEqual(DEFAULT_QQNT_CLIENT_TIMEOUTS)
    expect(resolveQQNTClientTimeouts({ bridgeMs: 1234.9 })).toEqual({
      ...DEFAULT_QQNT_CLIENT_TIMEOUTS, bridgeMs: 1234,
    })
  })

  it('builds identifiable timeout errors and never confuses them with EOF or unavailable media', () => {
    expect(bridgeRequestTimedOutError(20_000).message).toBe('QQNT bridge request timed out after 20000ms')
    expect(nativeMediaTimedOutError(15_000).message).toBe('QQNT native media request timed out after 15000ms')
    expect(nativeMediaBodyStalledError(20_000).message).toBe('QQNT native media body stalled for 20000ms')

    expect(isQQNTUpstreamTimeout(bridgeRequestTimedOutError(20_000))).toBe(true)
    expect(isQQNTUpstreamTimeout(nativeMediaTimedOutError(15_000))).toBe(true)
    expect(isQQNTUpstreamTimeout(nativeMediaBodyStalledError(20_000))).toBe(true)

    // 越界 Range（QQ 用 400/416 表示 EOF）与「媒体已失效」都不能被认成超时。
    expect(isQQNTUpstreamTimeout(new Error('QQNT bridge 416: Range Not Satisfiable'))).toBe(false)
    expect(isQQNTUpstreamTimeout(new Error('{"retcode":-5503008}'))).toBe(false)
    expect(isQQNTUpstreamTimeout(new Error('QQNT native media 404: Not Found'))).toBe(false)
    expect(isQQNTUpstreamTimeout(new Error('QQNT media locator has no remote direct-link identity'))).toBe(false)
    expect(isQQNTUpstreamTimeout('QQNT bridge request timed out after 1ms')).toBe(false)
  })
})

describe('UpstreamDeadline', () => {
  it('aborts with the timeout error and reports it through translate', async () => {
    const deadline = new UpstreamDeadline()
    const error = bridgeRequestTimedOutError(20)
    deadline.arm(20, () => error)
    try {
      expect(deadline.signal.aborted).toBe(false)
      await waitUntil(() => deadline.signal.aborted)
      expect(deadline.signal.reason).toBe(error)
      expect(deadline.timedOutError).toBe(error)
      // fetch 各实现抛回来的东西不同，translate 以「谁触发的」为准。
      expect(deadline.translate(new TypeError('terminated'))).toBe(error)
      expect(deadline.translate(error)).toBe(error)
    } finally {
      deadline.dispose()
    }
  })

  it('composes the caller signal and prefers its reason over a later timeout', async () => {
    const controller = new AbortController()
    const reason = new Error('telegram requester went away')
    const deadline = new UpstreamDeadline(controller.signal)
    const error = bridgeRequestTimedOutError(20)
    deadline.arm(20, () => error)
    controller.abort(reason)
    try {
      expect(deadline.signal.aborted).toBe(true)
      expect(deadline.signal.reason).toBe(reason)
      expect(deadline.translate(new Error('fetch failed'))).toBe(reason)
      // 计时器随后到点也不能把调用方中止改写成超时。
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(deadline.timedOutError).toBeUndefined()
      expect(deadline.translate(new Error('fetch failed'))).toBe(reason)
    } finally {
      deadline.dispose()
    }
  })

  it('starts aborted when the caller signal is already aborted', () => {
    const controller = new AbortController()
    const reason = new Error('already gone')
    controller.abort(reason)
    const deadline = new UpstreamDeadline(controller.signal)
    try {
      expect(deadline.signal.aborted).toBe(true)
      expect(deadline.signal.reason).toBe(reason)
    } finally {
      deadline.dispose()
    }
  })

  it('stops pending timers once disposed', async () => {
    const deadline = new UpstreamDeadline()
    deadline.arm(20, () => bridgeRequestTimedOutError(20))
    deadline.dispose()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(deadline.signal.aborted).toBe(false)
  })
})

describe('UpstreamBodyReader', () => {
  it('fails a stalled read, aborts the request, and cancels the stream', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
      },
      cancel() {
        cancelled = true
      },
    })
    const deadline = new UpstreamDeadline()
    const reader = new UpstreamBodyReader(stream, deadline, 60, () => nativeMediaBodyStalledError(60))
    try {
      await expect(reader.read()).resolves.toMatchObject({ done: false })
      await expect(reader.read()).rejects.toThrow('QQNT native media body stalled for 60ms')
      await waitUntil(() => cancelled)
      expect(deadline.signal.aborted).toBe(true)
      expect(deadline.timedOutError?.message).toBe('QQNT native media body stalled for 60ms')
    } finally {
      reader.releaseLock()
      deadline.dispose()
    }
  })

  it('resets the stall budget whenever a chunk arrives', async () => {
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent === 8) {
          controller.close()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
        sent++
        controller.enqueue(Uint8Array.of(sent))
      },
    })
    const deadline = new UpstreamDeadline()
    const reader = new UpstreamBodyReader(stream, deadline, 120, () => nativeMediaBodyStalledError(120))
    try {
      // 整体耗时 160ms 远超 120ms 预算，但每一帧间隔都只有 20ms，所以不该超时。
      await expect(reader.bytes().then((bytes) => [...bytes])).resolves.toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(deadline.timedOutError).toBeUndefined()
    } finally {
      reader.releaseLock()
      deadline.dispose()
    }
  })

  it('reports the caller abort reason instead of the stall message when both happen', async () => {
    const controller = new AbortController()
    const reason = new Error('download aborted by client')
    const stream = new ReadableStream<Uint8Array>({})
    const deadline = new UpstreamDeadline(controller.signal)
    const reader = new UpstreamBodyReader(stream, deadline, 60, () => nativeMediaBodyStalledError(60))
    try {
      controller.abort(reason)
      await expect(reader.read()).rejects.toThrow('download aborted by client')
    } finally {
      await reader.cancel()
      reader.releaseLock()
      deadline.dispose()
    }
  })
})

describe('BoundedResponse', () => {
  it('reads json and text bodies without leaving the deadline armed', async () => {
    const deadline = new UpstreamDeadline()
    const bounded = new BoundedResponse(
      Response.json({ protocolVersion: 36 }), deadline, 1_000, () => nativeMediaBodyStalledError(1_000),
    )
    await expect(bounded.json<{ protocolVersion: number }>()).resolves.toEqual({ protocolVersion: 36 })
    bounded.dispose()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(deadline.timedOutError).toBeUndefined()
  })

  it('treats a body-less response as empty instead of failing', async () => {
    const deadline = new UpstreamDeadline()
    const bounded = new BoundedResponse(
      new Response(null, { status: 204 }), deadline, 1_000, () => nativeMediaBodyStalledError(1_000),
    )
    try {
      await expect(bounded.text()).resolves.toBe('')
      await expect(bounded.discard()).resolves.toBeUndefined()
    } finally {
      bounded.dispose()
    }
  })
})
