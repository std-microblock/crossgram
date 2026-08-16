import { randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Logger, type Message } from 'cordis'
import Server from '@cordisjs/plugin-server'

interface Fixture { ctx: Context, server: Server, messages: Message[], stop(): Promise<void> }
const fixtures: Fixture[] = []

afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.stop())) })

async function createFixture(): Promise<Fixture> {
  const ctx = new Context()
  const messages: Message[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => messages.push(message) })
  const plugin = ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await plugin
  await new Promise((resolve) => setTimeout(resolve, 25))
  const server = ctx.server
  const fixture = { ctx, server, messages, async stop() { await plugin.dispose() } }
  fixtures.push(fixture)
  return fixture
}

function output(messages: Message[]): string {
  return messages.map((message) => Logger.format({ colors: false, export() {} }, message)).join('\n')
}

async function openWebSocket(baseUrl: string, path: string): Promise<Socket> {
  const url = new URL(baseUrl)
  const socket = connect(Number(url.port), url.hostname)
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write([
        `GET ${path} HTTP/1.1`, `Host: ${url.host}`, 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', '', '',
      ].join('\r\n'))
    })
    socket.on('data', (data) => {
      if (!data.toString('utf8').includes('101 Switching Protocols')) return
      socket.off('error', reject)
      resolve()
    })
  })
  return socket
}

describe('installed @cordisjs/plugin-server URL log redaction', () => {
  it('redacts raw, encoded, and double-encoded credentials from request, response, and route logs', async () => {
    const fixture = await createFixture()
    fixture.server.get('/bot:token/:method', async () => {})
    await new Promise((resolve) => setTimeout(resolve, 25))
    const rawToken = '123456:raw-token'
    const rawSecret = 'top:secret'
    const encodedSecret = 'top%25253Asecret'
    const apiKey = 'api-key-value'
    const response = await fetch(new URL(`/bot${rawToken.replace(':', '%253A')}/getMe?secret=${encodedSecret}&api_key=${apiKey}&safe=visible`, fixture.server.baseUrl))
    expect(response.status).toBeGreaterThanOrEqual(200)
    const logs = output(fixture.messages)
    expect(logs).toContain('<redacted>')
    expect(logs).toContain('safe=visible')
    for (const leaked of [rawToken, rawSecret, encodedSecret, 'top%253Asecret', 'top%3Asecret', apiKey]) expect(logs).not.toContain(leaked)
    expect(fixture.messages.map((message) => message.name)).toEqual(expect.arrayContaining(['server:request', 'server:response', 'server:route']))
  })

  it('redacts encoded credentials from generic route parameters', async () => {
    const fixture = await createFixture()
    fixture.server.get('/value/:credential', async () => {})
    await new Promise((resolve) => setTimeout(resolve, 25))
    const token = '123456:raw-token'
    const response = await fetch(new URL(`/value/${encodeURIComponent(encodeURIComponent(token))}`, fixture.server.baseUrl))
    expect(response.status).toBeGreaterThanOrEqual(200)
    const logs = output(fixture.messages.filter((message) => message.name === 'server:route'))
    expect(logs).toContain('<redacted>')
    for (const leaked of [token, '123456%253Araw-token', '123456%3Araw-token']) expect(logs).not.toContain(leaked)
  })

  it('redacts token and query secrets from WebSocket lifecycle logs', async () => {
    const fixture = await createFixture()
    fixture.server.ws('/socket/:token', async (_req, accept) => { await accept() })
    await new Promise((resolve) => setTimeout(resolve, 25))
    const token = '123456:raw-token'
    const socket = await openWebSocket(
      fixture.server.baseUrl,
      `/socket/${encodeURIComponent(encodeURIComponent(token))}?secret=top%25253Asecret&view=public`,
    )
    socket.destroy()
    await new Promise((resolve) => setTimeout(resolve, 25))
    const logs = output(fixture.messages.filter((message) => message.name === 'server:ws'))
    expect(logs).toContain('<redacted>')
    expect(logs).toContain('view=public')
    for (const leaked of [token, '123456%253Araw-token', '123456%3Araw-token', 'top%25253Asecret', 'top%253Asecret', 'top%3Asecret']) expect(logs).not.toContain(leaked)
  })

  it('fails closed for malformed encoding without erasing ordinary URLs', async () => {
    const fixture = await createFixture()
    fixture.server.get('/health', async () => {})
    await new Promise((resolve) => setTimeout(resolve, 25))
    const healthy = await fetch(new URL('/health?view=public', fixture.server.baseUrl))
    expect(healthy.status).toBeGreaterThanOrEqual(200)
    expect(output(fixture.messages)).toContain('/health?view=public')
    fixture.messages.length = 0
    const malformed = await fetch(new URL('/health?token=%ZZ', fixture.server.baseUrl))
    expect(malformed.status).toBeGreaterThanOrEqual(200)
    const logs = output(fixture.messages)
    expect(logs).toContain('<redacted>')
    expect(logs).not.toContain('%ZZ')
  })
})
