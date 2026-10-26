import { describe, expect, it } from 'vitest'
import { LarkApiError, LarkClient } from './client.js'

describe('LarkClient', () => {
  it('sends OAuth token exchange as form and unwraps data payloads', async () => {
    const requests: Array<{ url: string, init: RequestInit }> = []
    const client = createClient(async (input, init) => {
      requests.push({ url: String(input), init: init! })
      return json({ code: 0, msg: 'ok', data: { access_token: 'u-1', expires_in: 100, refresh_token: 'r-1', refresh_token_expires_in: 200 } })
    })
    const token = await client.exchangeCode('code-1', 'https://relay.test/lark/lark/oauth/callback')
    expect(token).toEqual({ access_token: 'u-1', expires_in: 100, refresh_token: 'r-1', refresh_token_expires_in: 200 })
    // OAuth token 接口自带 client_secret，不再预取 tenant token
    expect(requests).toHaveLength(1)
    const form = requests[0]!.init.body as FormData
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('code-1')
    expect(requests[0]!.url).toBe('https://open.feishu.cn/open-apis/authen/v2/oauth/token')
  })

  it('carries the user token as Bearer and JSON-escapes message content', async () => {
    const seen: Array<{ url: URL, auth: string, body?: unknown }> = []
    const client = createClient(async (input, init) => {
      seen.push({
        url: new URL(String(input)),
        auth: (init!.headers as Headers).get('authorization')!,
        body: init!.body ? JSON.parse(String(init!.body)) : undefined,
      })
      return json({ code: 0, data: { message_id: 'om_1' } })
    })
    await client.sendMessage('u-token', {
      receiveId: 'oc_1',
      msgType: 'text',
      content: '{"text":"hi \\"quoted\\""}',
      replyToMessageId: 'om_0',
    })
    expect(seen[0]).toMatchObject({
      auth: 'Bearer u-token',
      body: {
        receive_id: 'oc_1',
        msg_type: 'text',
        content: '{"text":"hi \\"quoted\\""}',
        reply_to_message_id: 'om_0',
      },
    })
    expect(seen[0]!.url.pathname).toBe('/open-apis/im/v1/messages')
    expect(seen[0]!.url.searchParams.get('receive_id_type')).toBe('chat_id')
  })

  it('throws LarkApiError on non-zero code and retries 429 then succeeds', async () => {
    let calls = 0
    const client = createClient(async () => {
      calls++
      if (calls === 1) return json({ code: 99991400, msg: 'too many request' }, { status: 429 })
      return json({ code: 0, data: { items: [], has_more: false } })
    })
    const result = await client.getChats('u-token')
    expect(result.items).toEqual([])
    expect(calls).toBe(2)
  })

  it('does not retry non-retriable business errors', async () => {
    let calls = 0
    const client = createClient(async () => {
      calls++
      return json({ code: 230027, msg: 'no permission' }, { status: 403 })
    })
    await expect(client.recallMessage('u-token', 'om_1')).rejects.toMatchObject({
      name: 'LarkApiError',
      code: 230027,
    })
    expect(calls).toBe(1)
  })

  it('normalizes REST msg_type and millisecond timestamps, and maps chat 230002 to null', async () => {
    let call = 0
    const client = createClient(async (input) => {
      call++
      const url = new URL(String(input))
      if (url.pathname.endsWith('/messages/om_1')) {
        return json({
          code: 0,
          data: {
            message_id: 'om_1', chat_id: 'oc_1', msg_type: 'text',
            create_time: '1700000000000', body: { content: '{"text":"x"}' },
            sender: { id: 'ou_2', id_type: 'open_id', sender_type: 'user' },
          },
        })
      }
      return json({ code: 230002, msg: 'Bot is not in the chat' }, { status: 400 })
    })
    const message = await client.getMessage('u-token', 'om_1')
    expect(message).toMatchObject({ messageType: 'text', sender: { sender_id: { open_id: 'ou_2' } } })
    const chat = await client.getChat('u-token', 'oc_missing')
    expect(chat).toBeNull()
    expect(call).toBe(2)
  })
})

function createClient(fetch: typeof globalThis.fetch): LarkClient {
  return new LarkClient({
    baseUrl: 'https://open.feishu.cn',
    appId: 'cli_test',
    appSecret: 'secret',
    fetch,
  })
}

function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init)
}
