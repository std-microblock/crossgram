/**
 * 平台层上游 IO 的有界超时基础设施。
 *
 * QQ 富媒体 CDN 与本地 bridge 都可能「收下请求却不再回包」：响应头永远不来，
 * 或者响应头回完以后 body 再也不动。平台层过去无界地 await 这些 IO，mtproto
 * 侧的 `upload.getFile` / `crossgram.getFileUrl` 就永远不会返回，客户端那条
 * 下载请求一直挂着（线上表现为「一张图卡住，之后所有图都不出来」）。
 *
 * 这里给出三档预算，并统一做两件事：
 *
 * 1. 超时后 abort 掉底层请求、取消响应体 reader，让 socket 立刻释放；
 * 2. 抛出带明确标识的普通 Error，便于上层识别与日志排查：
 *    - `QQNT bridge request timed out after ...ms`：bridge RPC（含响应体）；
 *    - `QQNT native media request timed out after ...ms`：直连 QQ CDN 的建连 + 首包；
 *    - `QQNT native media body stalled for ...ms`：直连 CDN 的流式 body 停顿。
 */

/** bridge JSON RPC（首包 + 响应体）的总预算。 */
export const QQNT_BRIDGE_REQUEST_TIMEOUT_MS = 20_000
/** 直连 QQ CDN 的建连 + 首包（响应头）预算。 */
export const QQNT_NATIVE_MEDIA_CONNECT_TIMEOUT_MS = 15_000
/** 直连 QQ CDN 流式 body 两帧之间允许的最长停顿；收到数据即重新计时。 */
export const QQNT_NATIVE_MEDIA_BODY_STALL_TIMEOUT_MS = 20_000
/** bridge 侧长任务（语音转写等）的总预算。 */
export const QQNT_LONG_BRIDGE_REQUEST_TIMEOUT_MS = 120_000

export interface QQNTClientTimeouts {
  /** bridge JSON RPC（含响应体）的总预算。 */
  bridgeMs: number
  /** 直连 QQ CDN 的建连 + 首包（响应头）预算。 */
  connectMs: number
  /** 流式 body 两帧之间允许的最长停顿。 */
  bodyStallMs: number
  /** bridge 侧长任务（语音转写等）的总预算。 */
  longBridgeMs: number
}

export const DEFAULT_QQNT_CLIENT_TIMEOUTS: QQNTClientTimeouts = {
  bridgeMs: QQNT_BRIDGE_REQUEST_TIMEOUT_MS,
  connectMs: QQNT_NATIVE_MEDIA_CONNECT_TIMEOUT_MS,
  bodyStallMs: QQNT_NATIVE_MEDIA_BODY_STALL_TIMEOUT_MS,
  longBridgeMs: QQNT_LONG_BRIDGE_REQUEST_TIMEOUT_MS,
}

/**
 * 补齐默认值。0、负数与 NaN 一律退回默认值，避免手滑把「有界」配成「无界」，
 * 那正是本次线上问题的形态。
 */
export function resolveQQNTClientTimeouts(
  input?: Partial<QQNTClientTimeouts> | null,
): QQNTClientTimeouts {
  const pick = (value: number | undefined, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
  return {
    bridgeMs: pick(input?.bridgeMs, DEFAULT_QQNT_CLIENT_TIMEOUTS.bridgeMs),
    connectMs: pick(input?.connectMs, DEFAULT_QQNT_CLIENT_TIMEOUTS.connectMs),
    bodyStallMs: pick(input?.bodyStallMs, DEFAULT_QQNT_CLIENT_TIMEOUTS.bodyStallMs),
    longBridgeMs: pick(input?.longBridgeMs, DEFAULT_QQNT_CLIENT_TIMEOUTS.longBridgeMs),
  }
}

export function bridgeRequestTimedOutError(timeoutMs: number): Error {
  return new Error(`QQNT bridge request timed out after ${timeoutMs}ms`)
}

export function nativeMediaTimedOutError(timeoutMs: number): Error {
  return new Error(`QQNT native media request timed out after ${timeoutMs}ms`)
}

export function nativeMediaBodyStalledError(timeoutMs: number): Error {
  return new Error(`QQNT native media body stalled for ${timeoutMs}ms`)
}

/** 是否是本模块抛出的上游超时：属于暂时性故障，不能当成「媒体越界 / 已失效」。 */
export function isQQNTUpstreamTimeout(error: unknown): boolean {
  return error instanceof Error
    && /^QQNT (?:bridge|native media) (?:request timed out|body stalled)/u.test(error.message)
}

/**
 * 一次逻辑上游请求的截止时间。
 *
 * 把「调用方 signal」与「本模块定时器」合成一个 AbortSignal 交给 fetch，
 * 于是调用方中止与超时都能打断底层 socket；同时记住超时原因，
 * 供 `translate()` 把底层那些含义模糊的 abort 错误翻译成可识别的超时错误。
 */
export class UpstreamDeadline {
  private readonly controller = new AbortController()
  private timer?: NodeJS.Timeout
  private expired?: Error

  constructor(private readonly caller?: AbortSignal) {
    if (!caller) return
    if (caller.aborted) {
      this.forwardAbort()
    } else {
      caller.addEventListener('abort', this.forwardAbort, { once: true })
    }
  }

  private readonly forwardAbort = (): void => {
    // 保持既有语义：调用方中止时优先用它给出的 reason。
    this.controller.abort(this.caller?.reason ?? new Error('download aborted'))
  }

  /** 交给 fetch 的信号：调用方可中断，超时也可中断。 */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** 已经因超时中止时的错误，用于把底层 abort 翻译成可识别的超时错误。 */
  get timedOutError(): Error | undefined {
    return this.expired
  }

  /** 重新武装截止时间；到点后用 `error()` 中止底层请求。 */
  arm(timeoutMs: number, error: () => Error): void {
    this.disarm()
    if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) return
    const timer = setTimeout(() => {
      this.timer = undefined
      this.abortWith(error())
    }, timeoutMs)
    timer.unref?.()
    this.timer = timer
  }

  disarm(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** 主动中止（body 停顿看门狗使用），并记下原因。 */
  abortWith(error: Error): void {
    if (this.controller.signal.aborted) return
    this.expired = error
    this.controller.abort(error)
  }

  /** 结束本次请求：清掉定时器与调用方 abort 监听，避免泄漏。 */
  dispose(): void {
    this.disarm()
    this.caller?.removeEventListener('abort', this.forwardAbort)
  }

  /**
   * 把底层错误翻译成超时 / 调用方中止错误，其它错误原样返回。
   *
   * fetch 被 abort 时抛回来的东西各实现不一（reason 本身、AbortError、
   * TypeError('terminated')…），所以这里以「谁触发的」为准，而不是比对错误类型。
   */
  translate(error: unknown): unknown {
    if (this.expired) return this.expired
    if (this.caller?.aborted) return this.caller.reason ?? new Error('download aborted')
    return error
  }
}

/**
 * 带停顿看门狗的响应体读取器。
 *
 * 每次 `read()` 前重新计时：只要还有数据在流动就一直活着；一旦某次读取
 * 超过 `stallMs` 没有结果，就 abort 掉底层请求、取消 reader，并抛出可识别的错误。
 * 这里同时用 race 兜底：即使某个 fetch 实现不把 abort 传播到 body 上，
 * 调用方也不会无限等待。
 */
export class UpstreamBodyReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>

  constructor(
    stream: ReadableStream<Uint8Array>,
    private readonly deadline: UpstreamDeadline,
    private readonly stallMs: number,
    private readonly stallError: () => Error,
  ) {
    this.reader = stream.getReader()
  }

  async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (!(this.stallMs > 0) || !Number.isFinite(this.stallMs)) {
      return await this.reader.read()
    }
    const stalled = Promise.withResolvers<never>()
    const timer = setTimeout(() => {
      const error = this.stallError()
      // 先让 race 以超时收场，再取消 reader：`cancel()` 会把挂起的 read 解析成
      // `{ done: true }`，若顺序反了，一次停顿就会被上层当成正常 EOF。
      stalled.reject(error)
      this.deadline.abortWith(error)
      void this.reader.cancel(error).catch(() => undefined)
    }, this.stallMs)
    timer.unref?.()
    try {
      const result = await Promise.race([this.reader.read(), stalled.promise])
      // race 已经判定超时但 read 恰好同时收尾时，仍然必须报超时而不是 EOF。
      const expired = this.deadline.timedOutError
      if (expired) throw expired
      return result
    } catch (error) {
      throw this.deadline.translate(error)
    } finally {
      clearTimeout(timer)
    }
  }

  /** 读完剩余 body（JSON、错误体、单分片 range 等）。 */
  async bytes(): Promise<Uint8Array> {
    const chunks: Buffer[] = []
    let size = 0
    while (true) {
      const { done, value } = await this.read()
      if (done) break
      if (!value?.length) continue
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
      size += value.byteLength
    }
    return Buffer.concat(chunks, size)
  }

  /** 读完剩余 body 并解码为文本。 */
  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes())
  }

  async cancel(reason?: unknown): Promise<void> {
    await this.reader.cancel(reason).catch(() => undefined)
  }

  releaseLock(): void {
    try {
      this.reader.releaseLock()
    } catch {
      // reader 已因 abort 释放时忽略，调用方不应因此失败。
    }
  }
}

/**
 * 一次有界上游请求：持有截止时间，并把 body 读取包上停顿看门狗。
 *
 * 生命周期由调用方负责——成功或失败都必须在 `finally` 里 `dispose()`。
 */
export class BoundedResponse {
  constructor(
    readonly response: Response,
    private readonly deadline: UpstreamDeadline,
    private readonly stallMs: number,
    private readonly stallError: () => Error,
  ) {}

  get status(): number {
    return this.response.status
  }

  get statusText(): string {
    return this.response.statusText
  }

  get ok(): boolean {
    return this.response.ok
  }

  header(name: string): string | null {
    return this.response.headers.get(name)
  }

  /** 打开带停顿看门狗的 reader；响应没有 body 时返回 undefined。 */
  stream(): UpstreamBodyReader | undefined {
    return this.response.body
      ? new UpstreamBodyReader(this.response.body, this.deadline, this.stallMs, this.stallError)
      : undefined
  }

  /** 读完整个 body；超时 / 中止会 abort 底层请求。 */
  async bytes(): Promise<Uint8Array> {
    const stream = this.stream()
    if (!stream) return new Uint8Array()
    try {
      return await stream.bytes()
    } finally {
      stream.releaseLock()
    }
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes())
  }

  async json<T>(): Promise<T> {
    return JSON.parse(await this.text()) as T
  }

  /** 丢掉不关心的 body，立刻释放连接。 */
  async discard(): Promise<void> {
    const body = this.response.body
    if (!body || this.response.bodyUsed) return
    await body.cancel().catch(() => undefined)
  }

  /** 结束本次请求：清定时器、摘除调用方 abort 监听。 */
  dispose(): void {
    this.deadline.dispose()
  }

  translate(error: unknown): unknown {
    return this.deadline.translate(error)
  }
}
