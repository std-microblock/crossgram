import { describe, expect, it } from 'vitest'
import type { tl } from '@mtcute/core'
import Long from 'long'
import type { ServerRpcContext } from './context.js'
import { RpcDispatcher, unwrapRpcRequest } from './dispatcher.js'

function makeContext(): ServerRpcContext {
  return {
    connection: {} as ServerRpcContext['connection'],
    apiLayer: null,
    authKeyId: null,
    sessionId: Long.ZERO,
    isAuthorized: true,
    sendUpdate() {},
    getPlatformData: <T>() => null as T,
    setPlatformData() {},
  }
}

describe('RpcDispatcher API layers', () => {
  it('returns invokeWithLayer explicitly while unwrapping the request', () => {
    const unwrapped = unwrapRpcRequest({
      _: 'invokeWithLayer', layer: 225,
      query: { _: 'help.getAppConfig', hash: 0 },
    } as tl.RpcMethod)
    expect(unwrapped.apiLayer).toBe(225)
    expect(unwrapped.request).toEqual({ _: 'help.getAppConfig', hash: 0 })
  })

  it('does not erase a retained layer for later unwrapped calls', async () => {
    const dispatcher = new RpcDispatcher()
    const context = { ...makeContext(), apiLayer: 224 }
    dispatcher.register('help.getAppConfig', async (ctx) => ({
      _: 'help.appConfig', hash: ctx.apiLayer ?? 0, config: { _: 'jsonObject', value: [] },
    }))

    const result = await dispatcher.dispatch(context, {
      _: 'help.getAppConfig', hash: 0,
    } as tl.RpcMethod) as tl.help.RawAppConfig

    expect(result.hash).toBe(224)
    expect(context.apiLayer).toBe(224)
  })
})
