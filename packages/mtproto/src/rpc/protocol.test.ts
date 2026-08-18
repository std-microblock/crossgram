import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import Long from 'long'
import type { ServerRpcContext } from './context.js'
import { isRpcRequestObject, unwrapRpcRequest } from './protocol.js'
import { invokeRpc, registerRpcRoute } from './router.js'

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

describe('Cordis RPC routing', () => {
  it('returns METHOD_NOT_IMPLEMENTED for unregistered methods', async () => {
    const ctx = new Context()

    await expect(invokeRpc(ctx, makeContext(), {
      _: 'help.getNearestDc',
    } as tl.RpcMethod)).resolves.toEqual({
      _: 'mt_rpc_error',
      errorCode: 500,
      errorMessage: 'METHOD_NOT_IMPLEMENTED: help.getNearestDc',
    })
  })

  it('returns invokeWithLayer explicitly while unwrapping the request', () => {
    const unwrapped = unwrapRpcRequest({
      _: 'invokeWithLayer', layer: 225,
      query: { _: 'help.getAppConfig', hash: 0 },
    } as tl.RpcMethod)
    expect(unwrapped.apiLayer).toBe(225)
    expect(unwrapped.request).toEqual({ _: 'help.getAppConfig', hash: 0 })
    expect(unwrapped.afterMessageIds).toEqual([])
  })

  it('retains invokeAfterMsg dependencies through nested initialization wrappers', () => {
    const dependency = Long.fromString('7666904576833745920')
    const unwrapped = unwrapRpcRequest({
      _: 'invokeAfterMsg',
      msgId: dependency,
      query: {
        _: 'invokeWithLayer', layer: 228,
        query: {
          _: 'initConnection', apiId: 1, deviceModel: 'Android', systemVersion: 'test',
          appVersion: 'test', systemLangCode: 'en', langPack: 'android', langCode: 'en',
          query: { _: 'messages.sendMessage', peer: { _: 'inputPeerSelf' }, message: 'hello', randomId: Long.ONE },
        },
      },
    } as unknown as tl.RpcMethod)

    expect(unwrapped.apiLayer).toBe(228)
    expect(unwrapped.request._).toBe('messages.sendMessage')
    expect(unwrapped.afterMessageIds).toEqual([dependency])
  })

  it('collects every invokeAfterMsgs dependency in wire order', () => {
    const dependencies = [Long.fromInt(10), Long.fromInt(20), Long.fromInt(30)]
    const unwrapped = unwrapRpcRequest({
      _: 'invokeAfterMsgs', msgIds: dependencies,
      query: { _: 'help.getConfig' },
    } as unknown as tl.RpcMethod)

    expect(unwrapped.request).toEqual({ _: 'help.getConfig' })
    expect(unwrapped.afterMessageIds).toEqual(dependencies)
  })

  it('recognizes every supported RPC wrapper without prefix guessing', () => {
    expect(isRpcRequestObject('messages.sendMessage')).toBe(true)
    expect(isRpcRequestObject('invokeAfterMsg')).toBe(true)
    expect(isRpcRequestObject('invokeAfterMsgs')).toBe(true)
    expect(isRpcRequestObject('invokeWithoutUpdates')).toBe(true)
    expect(isRpcRequestObject('mt_ping')).toBe(false)
  })

  it('does not erase a retained layer for later unwrapped calls', async () => {
    const ctx = new Context()
    const context = { ...makeContext(), apiLayer: 224 }
    const dispose = registerRpcRoute(ctx, 'help.getAppConfig', async (rpc) => ({
      _: 'help.appConfig', hash: rpc.apiLayer ?? 0, config: { _: 'jsonObject', value: [] },
    }))

    const result = await invokeRpc(ctx, context, {
      _: 'help.getAppConfig', hash: 0,
    } as tl.RpcMethod) as tl.help.RawAppConfig

    expect(result.hash).toBe(224)
    expect(context.apiLayer).toBe(224)
    dispose()
  })
})
