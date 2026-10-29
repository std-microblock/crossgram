import { fetch as undiciFetch, ProxyAgent as UndiciProxyAgent } from 'undici'
import type { LarkMessageReceiveEvent, LarkMessageRecalledEvent } from './types.js'

/** SDK 解包后 header 与 event 已平铺合并（见 EventDispatcher.parse）。 */
export type LarkReceiveEventData = LarkMessageReceiveEvent & { event_id?: string }
export type LarkRecalledEventData = LarkMessageRecalledEvent & { event_id?: string }

export interface LarkEventSink {
  onMessage(data: LarkReceiveEventData): Promise<void>
  onRecalled(data: LarkRecalledEventData): Promise<void>
}

export interface LarkWsClientLike {
  start(params: { eventDispatcher: unknown }): Promise<void>
  close(params?: { force?: boolean }): void
}

export interface LarkEventPumpOptions {
  appId: string
  appSecret: string
  /** 开放平台地址（SDK 默认连 Lark 国际版，飞书应用必须显式指定）。 */
  baseUrl: string
  /** 可选 HTTP(S) 代理：endpoint 发现与 WS 数据通道都走它（国际版在国内网络的必要配置）。 */
  proxy?: string
  /** 测试注入伪造 WS 客户端。 */
  createWsClient?: (options: { appId: string, appSecret: string }) => LarkWsClientLike
  createEventDispatcher?: () => {
    register: (handles: Record<string, (data: never) => unknown>) => unknown
  }
}

/**
 * 串行事件泵：Lark WS 回调必须在 3 秒内返回，因此 SDK 回调只入队，
 * 由队列逐条 await 下游（保住 subscribe 的背压语义）；close 时等队列排空。
 */
export class LarkEventPump {
  private readonly sink: LarkEventSink
  private readonly options: LarkEventPumpOptions
  private readonly logger?: { warn: (format: string, ...args: unknown[]) => void }
  private wsClient?: LarkWsClientLike
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(sink: LarkEventSink, options: LarkEventPumpOptions, logger?: LarkEventPump['logger']) {
    this.sink = sink
    this.options = options
    this.logger = logger
  }

  async start(): Promise<void> {
    const { WSClient, EventDispatcher, LoggerLevel } = await import('@larksuiteoapi/node-sdk')
    const { HttpsProxyAgent } = await import('https-proxy-agent')
    const proxyExtras = this.options.proxy
      ? {
        httpInstance: createProxyHttpInstance(this.options.proxy),
        agent: new HttpsProxyAgent(this.options.proxy),
      }
      : {}
    const createWsClient = this.options.createWsClient
      ?? ((opts: { appId: string, appSecret: string }) => new WSClient({
        appId: opts.appId,
        appSecret: opts.appSecret,
        domain: this.options.baseUrl,
        loggerLevel: LoggerLevel.warn,
        ...proxyExtras,
      }) as unknown as LarkWsClientLike)
    const createDispatcher = this.options.createEventDispatcher
      ?? (() => new EventDispatcher({}))
    const dispatcher = createDispatcher()
    dispatcher.register({
      'im.message.receive_v1': (data: never) => {
        this.enqueue(() => this.sink.onMessage(data as unknown as LarkReceiveEventData))
      },
      'im.message.message-recalled_v1': (data: never) => {
        this.enqueue(() => this.sink.onRecalled(data as unknown as LarkRecalledEventData))
      },
    })
    this.wsClient = createWsClient({ appId: this.options.appId, appSecret: this.options.appSecret })
    await this.wsClient.start({ eventDispatcher: dispatcher })
  }

  private enqueue(work: () => Promise<void>): void {
    if (this.closed) return
    this.tail = this.tail.then(work).catch((error: unknown) => {
      this.logger?.warn('Lark event processing failed: %s', String(error))
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.tail.catch(() => {})
    this.wsClient?.close()
    this.wsClient = undefined
  }
}

/** SDK 的 endpoint 发现走 httpInstance.request（axios 风格）；代理模式下用 undici 实现。 */
function createProxyHttpInstance(proxy: string) {
  const dispatcher = new UndiciProxyAgent(proxy)
  const request = async (options: {
    method?: string
    url: string
    data?: unknown
    headers?: Record<string, string>
    timeout?: number
  }): Promise<unknown> => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) }
    let body: string | undefined
    if (options.data !== undefined) {
      headers['content-type'] = 'application/json'
      body = typeof options.data === 'string' ? options.data : JSON.stringify(options.data)
    }
    const response = await undiciFetch(options.url, {
      method: options.method ?? 'POST',
      headers,
      body,
      dispatcher,
      signal: AbortSignal.timeout(options.timeout ?? 15_000),
    })
    return response.json()
  }
  return { request } as unknown as import('@larksuiteoapi/node-sdk').HttpInstance
}
