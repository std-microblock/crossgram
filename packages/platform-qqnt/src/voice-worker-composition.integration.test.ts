import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import net, { type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { VoiceWorkerCall } from '@mtproto-relay/bridge'
import { VoiceMediaAttachment, VoiceWorkerSocketClient } from '@mtproto-relay/bridge'
import { Context } from 'cordis'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { QQNTPlatform } from './index.js'
import { QQVoiceMedia } from './voice-media.js'

const describeUnix = process.platform === 'win32' ? describe.skip : describe

const execFile = promisify(execFileCallback)
const root = resolve(import.meta.dirname, '../../..')
const workerDirectory = join(root, 'packages/voice-worker')
const workerTarget = join(workerDirectory, 'target')
const workerBinary = join(workerTarget, 'debug/crossgram-voice-worker')
const token = new Uint8Array(32).fill(0x71)
const leaseId = '0123456789abcdef0123456789abcdef'
const session = {
  platformSessionId: 'voice-worker-composition', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}
const config = {
  initializationTimeoutMs: 1_000,
  receiveTimeoutMs: 1_000,
  enableP2p: true,
  allowTcp: false,
  protocolV1: true,
  enableAec: true,
  enableNs: true,
  enableAgc: true,
  endpoints: [],
}

function call(callId: string, telegramRole: 'caller' | 'recipient'): VoiceWorkerCall {
  return {
    callId,
    callerId: 1,
    participantId: 2,
    telegramRole,
    protocol: {
      _: 'phoneCallProtocol', udpP2p: true, udpReflector: false,
      minLayer: 100, maxLayer: 100, libraryVersions: ['crossgram-voice-worker-v2'],
    },
    mediaStartConfig: config,
  }
}

function pcm(value: number): Uint8Array {
  return new Uint8Array(1_920).fill(value)
}

function pcmFrame(value: number) {
  return {
    format: {
      encoding: 's16le' as const, sampleRate: 48_000 as const, channels: 1 as const,
      durationMs: 20 as const, samplesPerFrame: 960 as const, bytesPerFrame: 1_920 as const,
    },
    data: pcm(value),
  }
}

function frame(type: number, payload: Uint8Array): Buffer {
  const output = Buffer.allocUnsafe(5 + payload.byteLength)
  output[0] = type
  output.writeUInt32BE(payload.byteLength, 1)
  output.set(payload, 5)
  return output
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function waitForSocket(path: string): Promise<void> {
  await waitFor(() => existsSync(path), `Unix socket did not appear: ${path}`)
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      exited,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('voice worker did not exit')), 2_000)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const TEST_CALL_ID = 1n

async function fakeControl(socketPath: string, tag: 0x0d | 0x0e | 0x0f, data?: Uint8Array): Promise<Buffer> {
  const payload = Buffer.allocUnsafe(2 + 8 + (data?.byteLength ?? 0))
  payload[0] = 2
  payload[1] = tag
  payload.writeBigUInt64BE(TEST_CALL_ID, 2)
  if (data) payload.set(data, 10)
  const request = Buffer.allocUnsafe(4 + payload.byteLength)
  request.writeUInt32BE(payload.byteLength, 0)
  request.set(payload, 4)
  payload.fill(0)
  return await new Promise<Buffer>((resolve, reject) => {
    let received = Buffer.alloc(0)
    let expected: number | undefined
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const socket = net.createConnection(socketPath)
    const finish = (error?: Error, response?: Buffer) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      request.fill(0)
      received.fill(0)
      if (error) reject(error)
      else resolve(response!)
    }
    socket.once('error', () => finish(new Error('fake worker control failed')))
    socket.once('connect', () => socket.write(request, (error) => {
      if (error) finish(new Error('fake worker control failed'))
    }))
    socket.on('data', (chunk) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      if (received.byteLength + bytes.byteLength > 4 + 2 + 1_920) return finish(new Error('fake worker control response is oversized'))
      received = received.byteLength ? Buffer.concat([received, bytes]) : Buffer.from(bytes)
      if (expected === undefined && received.byteLength >= 4) {
        expected = received.readUInt32BE(0)
        if (expected < 2 || expected > 2 + 1_920) return finish(new Error('fake worker control response is invalid'))
      }
    })
    socket.once('end', () => {
      if (expected === undefined || received.byteLength !== expected + 4) return finish(new Error('fake worker control response is truncated'))
      finish(undefined, Buffer.from(received.subarray(4)))
    })
    timer = setTimeout(() => finish(new Error('fake worker control timed out')), 2_000)
    timer.unref()
  })
}

async function takeCapture(socketPath: string): Promise<Uint8Array | undefined> {
  const response = await fakeControl(socketPath, 0x0d)
  try {
    if (response.equals(Buffer.from([2, 0x8a]))) return
    if (response.byteLength === 2 + 1_920 && response[0] === 2 && response[1] === 0x89) {
      return new Uint8Array(response.subarray(2))
    }
    throw new Error('fake worker capture response is invalid')
  } finally {
    response.fill(0)
  }
}

async function waitForCapture(socketPath: string): Promise<Uint8Array> {
  const deadline = Date.now() + 2_000
  while (true) {
    const captured = await takeCapture(socketPath)
    if (captured) return captured
    if (Date.now() >= deadline) throw new Error('fake worker did not capture PCM')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function injectPlayout(socketPath: string, value: Uint8Array): Promise<void> {
  const response = await fakeControl(socketPath, 0x0e, value)
  try {
    expect(response).toEqual(Buffer.from([2, 0x88]))
  } finally {
    response.fill(0)
  }
}

async function fakeStats(socketPath: string): Promise<{ captured: number, playout: number }> {
  const response = await fakeControl(socketPath, 0x0f)
  try {
    if (response.byteLength !== 10 || response[0] !== 2 || response[1] !== 0x8f) {
      throw new Error('fake worker stats response is invalid')
    }
    return { captured: response.readUInt32BE(2), playout: response.readUInt32BE(6) }
  } finally {
    response.fill(0)
  }
}

interface Gateway {
  socketPath: string
  readonly authentications: Buffer[]
  readonly uplinks: Buffer[]
  readonly connections: Set<Socket>
  sendDownlink(frame: Uint8Array): void
  close(): Promise<void>
}

async function gateway(directory: string): Promise<Gateway> {
  const socketPath = join(directory, 'qq-media.sock')
  const authentications: Buffer[] = []
  const uplinks: Buffer[] = []
  const connections = new Set<Socket>()
  const server = net.createServer((socket) => {
    connections.add(socket)
    let pending = Buffer.alloc(0)
    socket.on('close', () => connections.delete(socket))
    socket.on('data', (chunk) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      pending = pending.length ? Buffer.concat([pending, bytes]) : Buffer.from(bytes)
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1)
        if (length > 1_920 || pending.length < 5 + length) return
        const type = pending[0]!
        const payload = pending.subarray(5, 5 + length)
        pending = pending.subarray(5 + length)
        if (type === 0x01) {
          authentications.push(Buffer.from(payload))
          socket.write(frame(0x80, Uint8Array.of(1)))
        } else if (type === 0x02) {
          uplinks.push(Buffer.from(payload))
        } else {
          socket.destroy()
        }
      }
    })
  })
  server.listen(socketPath)
  await once(server, 'listening')
  return {
    socketPath,
    authentications,
    uplinks,
    connections,
    sendDownlink(value) {
      for (const socket of connections) socket.write(frame(0x81, value))
    },
    async close() {
      for (const socket of connections) socket.destroy()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    },
  }
}

describeUnix('voice worker to QQ PCM composition', () => {
  beforeAll(async () => {
    await execFile('cargo', ['build', '--features', 'test-fake'], {
      cwd: workerDirectory,
      env: { ...process.env, CARGO_TARGET_DIR: workerTarget },
    })
  }, 120_000)

  const cleanup: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.allSettled(cleanup.splice(0).reverse().map((operation) => operation()))
  })

  it('authenticates one local lease and carries fixed PCM frames through the real Unix worker endpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crossgram-voice-composition-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const qqGateway = await gateway(directory)
    cleanup.push(() => qqGateway.close())

    const callerPath = join(directory, 'caller.sock')
    const recipientPath = join(directory, 'recipient.sock')
    const callerProcess = spawn(workerBinary, ['--unix-fake', callerPath], { stdio: 'ignore' })
    const recipientProcess = spawn(workerBinary, ['--unix-fake', recipientPath], { stdio: 'ignore' })
    cleanup.push(() => terminate(recipientProcess))
    cleanup.push(() => terminate(callerProcess))
    await Promise.all([waitForSocket(callerPath), waitForSocket(recipientPath)])

    const caller = new VoiceWorkerSocketClient({ socketPath: callerPath })
    const recipient = new VoiceWorkerSocketClient({ socketPath: recipientPath })
    cleanup.push(async () => { caller.close(); recipient.close() })
    const callerCall = call('caller-call', 'recipient')
    const recipientCall = call('recipient-call', 'caller')
    const prepared = await caller.prepareTelegramCaller(callerCall)
    expect(prepared.gAHash).toHaveLength(32)
    const recipientPrepared = await recipient.prepareTelegramRecipient(recipientCall, prepared.gAHash!)
    const completed = await caller.completeTelegramCaller(callerCall, recipientPrepared.gB!)
    expect(completed.state).toBe('media-active')
    const accepted = await recipient.completeTelegramRecipient(recipientCall, completed.gA!, completed.keyFingerprint!)
    expect(accepted.keyFingerprint).toEqual(completed.keyFingerprint)
    await caller.sendSignalingData(callerCall, Uint8Array.of(0x09))

    const callerEndpoint = await caller.attachMedia(callerCall)
    const recipientEndpoint = await recipient.attachMedia(recipientCall)
    expect(callerProcess.pid).toBeTypeOf('number')
    expect(recipientProcess.pid).toBeTypeOf('number')
    expect(callerProcess.pid).not.toBe(recipientProcess.pid)
    expect(await takeCapture(callerPath)).toBeUndefined()
    expect(await takeCapture(recipientPath)).toBeUndefined()

    const mediaService = new QQVoiceMedia(new Context())
    cleanup.push(() => mediaService.close())
    const platform = new QQNTPlatform({}, 'qqnt:stickers', undefined, mediaService)
    const leaseToken = new Uint8Array(token)
    const mediaLease = vi.spyOn(platform.client, 'mediaLease').mockResolvedValue({
      version: 1,
      socketPath: qqGateway.socketPath,
      leaseId,
      token: leaseToken,
      expiry: 1,
    })

    const media = await platform.voiceMedia!.start(callerCall, session, callerEndpoint)
    expect(mediaLease).toHaveBeenCalledTimes(1)
    expect(qqGateway.authentications).toEqual([
      Buffer.concat([Buffer.from([1]), Buffer.from(leaseId, 'hex'), Buffer.from(token)]),
    ])
    expect(leaseToken).toEqual(new Uint8Array(32))

    const attachment = new VoiceMediaAttachment(media, callerEndpoint)
    cleanup.push(() => attachment.close())
    const workerOriginated = pcm(0x11)
    await injectPlayout(callerPath, workerOriginated)
    await waitFor(() => qqGateway.uplinks.length === 1, 'worker playout frame was not delivered to QQ')
    expect(qqGateway.uplinks[0]).toEqual(Buffer.from(workerOriginated))
    expect(await takeCapture(callerPath)).toBeUndefined()

    const qqOriginated = pcm(0x22)
    qqGateway.sendDownlink(qqOriginated)
    const capturedByCaller = await waitForCapture(callerPath)
    expect(capturedByCaller).toEqual(qqOriginated)
    await injectPlayout(recipientPath, capturedByCaller!)
    capturedByCaller?.fill(0)
    const recipientPlayout = recipientEndpoint.receive({ signal: new AbortController().signal })[Symbol.asyncIterator]()
    expect((await recipientPlayout.next()).value?.data).toEqual(qqOriginated)
    expect(await takeCapture(recipientPath)).toBeUndefined()

    const recipientCaptured = pcm(0x33)
    await recipientEndpoint.send(pcmFrame(0x33), { signal: new AbortController().signal })
    const capturedByRecipient = await takeCapture(recipientPath)
    expect(capturedByRecipient).toEqual(recipientCaptured)
    await injectPlayout(callerPath, capturedByRecipient!)
    capturedByRecipient?.fill(0)
    await waitFor(() => qqGateway.uplinks.length === 2, 'recipient capture was not delivered through caller playout')
    expect(qqGateway.uplinks[1]).toEqual(Buffer.from(recipientCaptured))

    for (let value = 0x40; value < 0x46; value++) await injectPlayout(recipientPath, pcm(value))
    expect(await fakeStats(recipientPath)).toEqual({ captured: 0, playout: 2 })
    for (const value of [0x42, 0x43, 0x44, 0x45]) {
      const frame = (await recipientPlayout.next()).value?.data
      expect(frame).toHaveLength(1_920)
      expect(frame).toEqual(pcm(value))
    }
    for (let value = 0x50; value < 0x56; value++) {
      await recipientEndpoint.send(pcmFrame(value), { signal: new AbortController().signal })
    }
    expect(await fakeStats(recipientPath)).toEqual({ captured: 2, playout: 2 })
    for (const value of [0x52, 0x53, 0x54, 0x55]) {
      const captured = await takeCapture(recipientPath)
      expect(captured).toHaveLength(1_920)
      expect(captured).toEqual(pcm(value))
      captured?.fill(0)
    }

    await attachment.close()
    await waitFor(() => qqGateway.connections.size === 0, 'QQ gateway connection was not closed')
    await caller.discardCall(callerCall).catch(() => {})
    await recipient.discardCall(recipientCall)
    caller.close()
    recipient.close()
    await Promise.all([terminate(callerProcess), terminate(recipientProcess)])
    expect(callerProcess.exitCode ?? callerProcess.signalCode).not.toBeNull()
    expect(recipientProcess.exitCode ?? recipientProcess.signalCode).not.toBeNull()
    await expect(stat(callerPath)).resolves.toBeDefined()
    await Promise.all([rm(callerPath), rm(recipientPath)])
    expect(existsSync(callerPath)).toBe(false)
    expect(existsSync(recipientPath)).toBe(false)
  })
})
