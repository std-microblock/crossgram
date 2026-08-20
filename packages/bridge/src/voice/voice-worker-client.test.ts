import { mkdtemp, rm, stat } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import Long from 'long'
import type { tl } from '@mtcute/core'
import { afterEach, describe, expect, it } from 'vitest'
import { CallRegistry, VoiceCallError, type VoiceWorkerCall } from './call-registry.js'
import {
  VOICE_WORKER_MAX_FRAME_BYTES,
  VoiceWorkerSocketClient,
  decodeVoiceWorkerResponse,
  encodeVoiceWorkerRequest,
} from './voice-worker-client.js'

const describeUnix = process.platform === 'win32' ? describe.skip : describe

const protocol: tl.RawPhoneCallProtocol = {
  _: 'phoneCallProtocol', udpP2p: false, udpReflector: false,
  minLayer: 65, maxLayer: 92, libraryVersions: ['5.0.0'],
}
const mediaStartConfig = {
  initializationTimeoutMs: 1, receiveTimeoutMs: 1,
  enableP2p: false, allowTcp: true, protocolV1: true, enableAec: true, enableNs: true, enableAgc: true,
  endpoints: [{
    id: Long.fromInt(1), ipv4: '127.0.0.1', ipv6: '', port: 443, kind: 'udp-relay' as const, peerTag: new Uint8Array(16),
  }],
}
const call: VoiceWorkerCall = {
  callId: 'transient-telegram-call', callerId: 1, participantId: 2, telegramRole: 'caller', protocol, mediaStartConfig,
}

const servers: Array<{ server: Server, directory: string }> = []
const workerProcesses: Array<{ process: ChildProcess, directory: string }> = []
let fakeWorkerBuild: Promise<void> | undefined

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async ({ server, directory }) => {
    server.close()
    await rm(directory, { recursive: true, force: true })
  }))
  await Promise.all(workerProcesses.splice(0).map(async ({ process, directory }) => {
    process.kill()
    await once(process, 'exit').catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }))
})

function response(payload: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(4 + payload.length)
  frame.writeUInt32BE(payload.length, 0)
  Buffer.from(payload).copy(frame, 4)
  return frame
}

function i64le(value: Long): Buffer {
  const output = Buffer.allocUnsafe(8)
  output.writeInt32LE(value.low, 0)
  output.writeInt32LE(value.high, 4)
  return output
}

async function fakeServer(handler: (request: Buffer, socket: Socket) => void): Promise<{ path: string, requests: Buffer[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'crossgram-voice-worker-'))
  const path = join(directory, 'worker.sock')
  const requests: Buffer[] = []
  const server = createServer((socket) => {
    socket.on('error', () => {})
    let received = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
      if (received.length < 4) return
      const length = received.readUInt32BE(0)
      if (received.length !== length + 4) return socket.destroy()
      requests.push(received)
      handler(received, socket)
    })
  })
  servers.push({ server, directory })
  server.listen(path)
  await once(server, 'listening')
  return { path, requests }
}

async function rustFakeWorker(): Promise<string> {
  fakeWorkerBuild ??= new Promise<void>((resolve, reject) => {
    const build = spawn('cargo', [
      'build', '--quiet', '--locked', '--manifest-path',
      join(process.cwd(), 'packages/voice-worker/Cargo.toml'), '--features', 'test-fake',
    ], { stdio: 'ignore' })
    build.once('error', reject)
    build.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Rust fake worker did not build')))
  })
  await fakeWorkerBuild
  const directory = await mkdtemp(join(tmpdir(), 'crossgram-voice-worker-rust-'))
  const path = join(directory, 'worker.sock')
  const child = spawn(join(process.cwd(), 'packages/voice-worker/target/debug/crossgram-voice-worker'), ['--unix-fake', path], {
    stdio: 'ignore',
  })
  workerProcesses.push({ process: child, directory })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      await stat(path)
      return path
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw new Error('Rust worker did not start')
}

function tag(request: Buffer): number {
  return request[5]!
}

function callId(request: Buffer): bigint {
  return request.readBigUInt64BE(6)
}

function signalRequestId(request: Buffer): bigint {
  return request.readBigUInt64BE(14)
}

function openSocketCount(client: VoiceWorkerSocketClient): number {
  return (client as unknown as { _sockets: Set<Socket> })._sockets.size
}

describe('voice worker IPC v3 codec', () => {
  it('advertises the exact protocol implemented by the pinned native tgcalls adapter', () => {
    const client = new VoiceWorkerSocketClient({ socketPath: '/unused/worker.sock' })

    expect(client.protocol).toEqual({
      _: 'phoneCallProtocol', udpP2p: true, udpReflector: false,
      minLayer: 65, maxLayer: 92, libraryVersions: ['5.0.0'],
    })
    client.close()
  })

  it('encodes fixed-width v3 request fields and rejects malformed responses', () => {
    const frame = encodeVoiceWorkerRequest({
      tag: 0x04, callId: 9n, gA: new Uint8Array(256).fill(3), expectedFingerprint: Long.NEG_ONE,
      config: {
        initializationTimeoutMs: 1, receiveTimeoutMs: 1,
        enableP2p: false, allowTcp: true, protocolV1: true, enableAec: true, enableNs: true, enableAgc: true,
        endpoints: [{
          id: Long.fromInt(9), ipv4: '127.0.0.1', ipv6: '', port: 443, kind: 'udp-relay', peerTag: new Uint8Array(16),
        }],
      },
    })
    expect(frame.readUInt32BE(0)).toBe(326)
    expect([...frame.subarray(4, 6)]).toEqual([3, 0x04])
    expect(frame.readBigUInt64BE(6)).toBe(9n)
    expect(frame.subarray(4 + 2 + 8 + 256, 4 + 2 + 8 + 256 + 8))
      .toEqual(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))
    expect(frame[4 + 2 + 8 + 256 + 8 + 1 + 4 + 4]! & 1).toBe(0)
    expect(() => decodeVoiceWorkerResponse(Uint8Array.of(1, 0x86))).toThrow(VoiceCallError)
    expect(() => decodeVoiceWorkerResponse(Uint8Array.of(3, 0x86, 0))).toThrow(VoiceCallError)
    expect(() => decodeVoiceWorkerResponse(Uint8Array.of(3, 0xff, 0))).toThrow(VoiceCallError)
  })

  it('encodes bounded TURN REST credentials for the native worker', () => {
    const frame = encodeVoiceWorkerRequest({
      tag: 0x03, callId: 11n, gB: new Uint8Array(256).fill(4),
      config: {
        initializationTimeoutMs: 5_000, receiveTimeoutMs: 5_000,
        enableP2p: true, allowTcp: false, protocolV1: true,
        enableAec: true, enableNs: true, enableAgc: true, endpoints: [],
        rtcServers: [{
          id: 7, host: 'turn.example.test', port: 3478,
          username: '1900000000:call', password: 'credential', turn: true, tcp: false,
        }],
      },
    })

    expect(frame[4]).toBe(3)
    expect(frame[4 + 2 + 8 + 256 + 11]).toBe(1)
    expect(frame.includes(Buffer.from('turn.example.test'))).toBe(true)
    expect(frame.includes(Buffer.from('1900000000:call'))).toBe(true)
    expect(frame.includes(Buffer.from('credential'))).toBe(true)
  })
})

describeUnix('VoiceWorkerSocketClient', () => {
  it('attaches fixed PCM ingress only after the Rust fake backend is active', async () => {
    const caller = new VoiceWorkerSocketClient({ socketPath: await rustFakeWorker() })
    const recipient = new VoiceWorkerSocketClient({ socketPath: await rustFakeWorker() })
    const callerPreparation = await caller.prepareTelegramCaller(call)
    const recipientPreparation = await recipient.prepareTelegramRecipient(call, callerPreparation.gAHash)

    await expect(recipient.attachMedia(call)).rejects.toMatchObject({ code: 'CALL_STATE_INVALID' })
    const completion = await caller.completeTelegramCaller(call, recipientPreparation.gB)
    const endpoint = await caller.attachMedia(call)
    const controller = new AbortController()
    const pcm = {
      format: {
        encoding: 's16le' as const, sampleRate: 48_000 as const, channels: 1 as const, durationMs: 20 as const,
        samplesPerFrame: 960 as const, bytesPerFrame: 1_920 as const,
      },
      data: new Uint8Array(1_920).fill(5),
    }

    await endpoint.send(pcm, { signal: controller.signal })
    await endpoint.close()

    expect(completion.state).toBe('media-active')
    await expect(caller.attachMedia(call)).rejects.toMatchObject({ code: 'CALL_STATE_INVALID' })
  })

  it('maps every worker operation to one strict Unix request/response exchange', async () => {
    const gaHash = new Uint8Array(32).fill(1)
    const gB = new Uint8Array(256).fill(2)
    const gA = new Uint8Array(256).fill(3)
    const fingerprint = Long.fromInt(-7)
    const server = await fakeServer((request, socket) => {
      switch (tag(request)) {
        case 0x01: socket.end(response(Buffer.concat([Buffer.from([3, 0x81]), Buffer.from(gaHash)]))); break
        case 0x02: socket.end(response(Buffer.concat([Buffer.from([3, 0x82]), Buffer.from(gB)]))); break
        case 0x03: socket.end(response(Buffer.concat([Buffer.from([3, 0x83]), Buffer.from(gA), i64le(fingerprint)]))); break
        case 0x04: socket.end(response(Buffer.concat([Buffer.from([3, 0x84]), i64le(fingerprint)]))); break
        case 0x05: socket.end(response(Buffer.concat([Buffer.from([3, 0x85]), request.subarray(14, 22)]))); break
        case 0x06: socket.end(response(Uint8Array.of(3, 0x86))); break
        default: socket.destroy()
      }
    })
    const client = new VoiceWorkerSocketClient({ socketPath: server.path })

    await expect(client.prepareTelegramCaller(call)).resolves.toEqual({ state: 'ready', gAHash: gaHash })
    await expect(client.prepareTelegramRecipient(call, gaHash)).resolves.toEqual({ state: 'ready', gB })
    await expect(client.completeTelegramCaller(call, gB)).resolves.toEqual({
      state: 'media-active', gA, keyFingerprint: fingerprint,
    })
    await expect(client.completeTelegramRecipient(call, gA, fingerprint)).resolves.toEqual({
      state: 'media-active', keyFingerprint: fingerprint,
    })
    await expect(client.sendSignalingData(call, Uint8Array.of(4, 5))).resolves.toBeUndefined()
    await expect(client.discardCall(call)).resolves.toBeUndefined()

    expect(server.requests.map(tag)).toEqual([0x01, 0x02, 0x03, 0x04, 0x05, 0x06])
    expect(server.requests.map(callId)).toEqual([1n, 1n, 1n, 1n, 1n, 1n])
    expect(server.requests[4]!.readBigUInt64BE(14)).toBe(1n)
    expect(server.requests).toHaveLength(6)
  })

  it('delivers one outbound event before acknowledging a lost acknowledgement exactly once', async () => {
    const delivered = Promise.withResolvers<void>()
    const acknowledged = Promise.withResolvers<void>()
    let deliveries = 0
    let handlerAttempts = 0
    let ackRequests = 0
    let workerAcknowledged = false
    const server = await fakeServer((request, socket) => {
      switch (tag(request)) {
        case 0x03:
          socket.end(response(Buffer.concat([Buffer.from([3, 0x83]), Buffer.alloc(256, 7), i64le(Long.ONE)])))
          return
        case 0x0b:
          if (workerAcknowledged) {
            socket.end(response(Buffer.from([3, 0x8d])))
            return
          }
          socket.end(response(Buffer.from([3, 0x8c, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 2, 4, 5])))
          return
        case 0x0c:
          ackRequests++
          if (ackRequests === 1) {
            socket.end()
            return
          }
          workerAcknowledged = true
          acknowledged.resolve()
          socket.end(response(Buffer.from([3, 0x8e, 0, 0, 0, 0, 0, 0, 0, 1])))
          return
        default:
          socket.destroy()
      }
    })
    const client = new VoiceWorkerSocketClient({
      socketPath: server.path,
      onEvent: async (_call, event) => {
        expect(event).toEqual({ kind: 'outbound-signal', data: Uint8Array.of(4, 5) })
        handlerAttempts++
        if (handlerAttempts <= 9) throw new Error('no live authorized client')
        deliveries++
        delivered.resolve()
      },
    })

    await client.completeTelegramCaller(call, new Uint8Array(256).fill(3))
    await delivered.promise
    await acknowledged.promise
    client.close()

    expect(handlerAttempts).toBe(10)
    expect(deliveries).toBe(1)
    expect(ackRequests).toBe(2)
  })

  it('cancels a retrying event pump promptly when the client closes', async () => {
    const attempted = Promise.withResolvers<void>()
    let polls = 0
    const server = await fakeServer((request, socket) => {
      switch (tag(request)) {
        case 0x03:
          socket.end(response(Buffer.concat([Buffer.from([3, 0x83]), Buffer.alloc(256, 7), i64le(Long.ONE)])))
          return
        case 0x0b:
          polls++
          socket.end(response(Buffer.from([3, 0x8c, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 4])))
          return
        default:
          socket.destroy()
      }
    })
    const client = new VoiceWorkerSocketClient({
      socketPath: server.path,
      onEvent: async () => {
        attempted.resolve()
        throw new Error('no authorized recipient')
      },
    })

    await client.completeTelegramCaller(call, new Uint8Array(256).fill(3))
    await attempted.promise
    client.close()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(polls).toBe(1)
  })

  it('aborts a held PollEvent socket before promptly sending Hangup', async () => {
    const pollOpened = Promise.withResolvers<void>()
    const pollClosed = Promise.withResolvers<void>()
    const hangupSeen = Promise.withResolvers<void>()
    let eventDeliveries = 0
    const server = await fakeServer((request, socket) => {
      switch (tag(request)) {
        case 0x03:
          socket.end(response(Buffer.concat([Buffer.from([3, 0x83]), Buffer.alloc(256, 7), i64le(Long.ONE)])))
          return
        case 0x0b:
          socket.once('close', () => pollClosed.resolve())
          pollOpened.resolve()
          return
        case 0x06:
          hangupSeen.resolve()
          socket.end(response(Buffer.from([3, 0x86])))
          return
        default:
          socket.destroy()
      }
    })
    const client = new VoiceWorkerSocketClient({
      socketPath: server.path,
      timeoutMs: 5_000,
      onEvent: async () => { eventDeliveries++ },
    })

    await client.completeTelegramCaller(call, new Uint8Array(256).fill(3))
    await pollOpened.promise
    await Promise.race([
      client.discardCall(call),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Hangup timed out')), 500)),
    ])
    await pollClosed.promise
    await hangupSeen.promise

    expect(server.requests.map(tag)).toEqual([0x03, 0x0b, 0x06])
    expect(eventDeliveries).toBe(0)
    expect(openSocketCount(client)).toBe(0)
  })

  it('retries one lost signaling acknowledgement with exactly the same Unix frame', async () => {
    const forwardedRequestIds = new Set<bigint>()
    let forwardSideEffects = 0
    let requestCount = 0
    const server = await fakeServer((request, socket) => {
      requestCount++
      expect(tag(request)).toBe(0x05)
      const requestId = signalRequestId(request)
      if (!forwardedRequestIds.has(requestId)) {
        forwardedRequestIds.add(requestId)
        forwardSideEffects++
      }
      if (requestCount === 1) {
        socket.end()
        return
      }
      socket.end(response(Buffer.concat([Buffer.from([3, 0x85]), request.subarray(14, 22)])))
    })
    const client = new VoiceWorkerSocketClient({ socketPath: server.path })

    await expect(client.sendSignalingData(call, Uint8Array.of(4, 5))).resolves.toBeUndefined()

    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]).toEqual(server.requests[0])
    expect(signalRequestId(server.requests[1]!)).toBe(signalRequestId(server.requests[0]!))
    expect(forwardSideEffects).toBe(1)
    expect(openSocketCount(client)).toBe(0)
  })

  it('retries a lost PCM attach acknowledgement without duplicating the one-use endpoint', async () => {
    const capability = Buffer.alloc(32, 7)
    let attachSideEffects = 0
    const attachedRequestIds = new Set<bigint>()
    const server = await fakeServer((request, socket) => {
      switch (tag(request)) {
        case 0x07: {
          const requestId = request.readBigUInt64BE(14)
          if (!attachedRequestIds.has(requestId)) {
            attachedRequestIds.add(requestId)
            attachSideEffects++
            socket.end()
            return
          }
          socket.end(response(Buffer.concat([Buffer.from([3, 0x87]), request.subarray(14, 22), capability])))
          return
        }
        case 0x08:
          expect(request.subarray(14, 46)).toEqual(capability)
          socket.end(response(Uint8Array.of(3, 0x88)))
          return
        case 0x09:
          socket.end(response(Buffer.concat([Buffer.from([3, 0x89]), Buffer.alloc(1_920, 4)])))
          return
        case 0x0a:
          socket.end(response(Uint8Array.of(3, 0x8b)))
          return
        default:
          socket.destroy()
      }
    })
    const client = new VoiceWorkerSocketClient({ socketPath: server.path })
    const endpoint = await client.attachMedia(call)
    const controller = new AbortController()
    const pcm = {
      format: {
        encoding: 's16le' as const, sampleRate: 48_000 as const, channels: 1 as const, durationMs: 20 as const,
        samplesPerFrame: 960 as const, bytesPerFrame: 1_920 as const,
      },
      data: new Uint8Array(1_920).fill(3),
    }

    await endpoint.send(pcm, { signal: controller.signal })
    const received = await endpoint.receive({ signal: controller.signal })[Symbol.asyncIterator]().next()
    await endpoint.close()

    expect(attachSideEffects).toBe(1)
    expect(server.requests.slice(0, 2)).toEqual([server.requests[0], server.requests[0]])
    expect(received.value?.data).toEqual(new Uint8Array(1_920).fill(4))
    expect(server.requests.map(tag)).toEqual([0x07, 0x07, 0x08, 0x09, 0x0a])
    expect(openSocketCount(client)).toBe(0)
  })

  it('does not retry signaling worker errors or invalid responses', async () => {
    const cases: Array<{ reply: Buffer, code: string }> = [
      { reply: response(Uint8Array.of(3, 0xff, 2)), code: 'CALL_OCCUPY_FAILED' },
      { reply: response(Uint8Array.of(3, 0x85)), code: 'CALL_MEDIA_UNAVAILABLE' },
    ]
    for (const testCase of cases) {
      const server = await fakeServer((_request, socket) => socket.end(testCase.reply))
      const client = new VoiceWorkerSocketClient({ socketPath: server.path })

      await expect(client.sendSignalingData(call, Uint8Array.of(4, 5)))
        .rejects.toMatchObject({ code: testCase.code })
      expect(server.requests).toHaveLength(1)
      expect(openSocketCount(client)).toBe(0)
    }

    const truncated = await fakeServer((_request, socket) => {
      socket.end(Buffer.from([0, 0, 0, 2, 2]))
    })
    const client = new VoiceWorkerSocketClient({ socketPath: truncated.path })
    await expect(client.sendSignalingData(call, Uint8Array.of(4, 5)))
      .rejects.toMatchObject({ code: 'CALL_MEDIA_UNAVAILABLE' })
    expect(truncated.requests).toHaveLength(1)
    expect(openSocketCount(client)).toBe(0)
  })

  it('retries one empty prepare-caller timeout with the same Unix frame', async () => {
    const gaHash = new Uint8Array(32).fill(6)
    let requestCount = 0
    const server = await fakeServer((_request, socket) => {
      requestCount++
      if (requestCount === 1) return
      socket.end(response(Buffer.concat([Buffer.from([3, 0x81]), Buffer.from(gaHash)])))
    })
    const client = new VoiceWorkerSocketClient({ socketPath: server.path, timeoutMs: 20 })

    await expect(client.prepareTelegramCaller(call)).resolves.toEqual({ state: 'ready', gAHash: gaHash })

    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]).toEqual(server.requests[0])
    expect(openSocketCount(client)).toBe(0)
  })

  it('retries one empty timeout after connecting and cleans up each socket', async () => {
    let requestCount = 0
    const server = await fakeServer((request, socket) => {
      requestCount++
      if (requestCount === 1) return
      socket.end(response(Buffer.concat([Buffer.from([3, 0x85]), request.subarray(14, 22)])))
    })
    const client = new VoiceWorkerSocketClient({ socketPath: server.path, timeoutMs: 1_000 })

    await expect(client.sendSignalingData(call, Uint8Array.of(4, 5))).resolves.toBeUndefined()

    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]).toEqual(server.requests[0])
    expect(openSocketCount(client)).toBe(0)
  })

  it('preserves the unavailable result when signaling cannot connect', async () => {
    const client = new VoiceWorkerSocketClient({
      socketPath: join(tmpdir(), 'crossgram-missing-voice-worker.sock'), timeoutMs: 20,
    })

    await expect(client.sendSignalingData(call, Uint8Array.of(4, 5)))
      .rejects.toMatchObject({ code: 'CALL_MEDIA_UNAVAILABLE' })
    expect(openSocketCount(client)).toBe(0)
  })

  it('reports redacted final prepare-caller failures', async () => {
    const cases: Array<{ reply: (socket: Socket) => void, diagnosticCode: string, errorCode: string, requests: number }> = [
      { reply: (socket) => socket.end(), diagnosticCode: 'TRANSPORT_RETRYABLE', errorCode: 'CALL_MEDIA_UNAVAILABLE', requests: 2 },
      { reply: (socket) => socket.end(Buffer.from([0, 0, 0, 2, 2])), diagnosticCode: 'TRANSPORT_TERMINAL', errorCode: 'CALL_MEDIA_UNAVAILABLE', requests: 1 },
      { reply: (socket) => socket.end(response(Uint8Array.of(3, 0xff, 2))), diagnosticCode: 'CALL_OCCUPY_FAILED', errorCode: 'CALL_OCCUPY_FAILED', requests: 1 },
    ]
    for (const testCase of cases) {
      const diagnostics: Array<[string, string]> = []
      const server = await fakeServer((_request, socket) => testCase.reply(socket))
      const client = new VoiceWorkerSocketClient({
        socketPath: server.path,
        timeoutMs: 20,
        onDiagnostic: (phase, code) => diagnostics.push([phase, code]),
      })

      await expect(client.prepareTelegramCaller(call)).rejects.toMatchObject({ code: testCase.errorCode })

      expect(diagnostics).toEqual([['prepare-caller', testCase.diagnosticCode]])
      expect(server.requests).toHaveLength(testCase.requests)
    }
  })

  it('diagnoses client disposal exactly once despite diagnostic reentry', () => {
    const diagnostics: Array<[string, string]> = []
    let client: VoiceWorkerSocketClient
    client = new VoiceWorkerSocketClient({
      socketPath: '/unused/worker.sock',
      onDiagnostic: (phase, code) => {
        diagnostics.push([phase, code])
        client.close()
      },
    })

    client.close()
    client.close()

    expect(diagnostics).toEqual([['client-close', 'DISPOSED']])
  })

  it('diagnoses prepare-caller after client close', async () => {
    const diagnostics: Array<[string, string]> = []
    const client = new VoiceWorkerSocketClient({
      socketPath: '/unused/worker.sock',
      onDiagnostic: (phase, code) => diagnostics.push([phase, code]),
    })
    client.close()

    await expect(client.prepareTelegramCaller(call)).rejects.toMatchObject({ code: 'CALL_MEDIA_UNAVAILABLE' })

    expect(diagnostics).toEqual([['client-close', 'DISPOSED'], ['prepare-caller', 'CLIENT_CLOSED']])
  })

  it('diagnoses an invalid prepare-caller identity once', async () => {
    const diagnostics: Array<[string, string]> = []
    const client = new VoiceWorkerSocketClient({
      socketPath: '/unused/worker.sock',
      onDiagnostic: (phase, code) => diagnostics.push([phase, code]),
    })

    await expect(client.prepareTelegramCaller({ ...call, callId: '' }))
      .rejects.toMatchObject({ code: 'CALL_MEDIA_UNAVAILABLE' })

    expect(diagnostics).toEqual([['prepare-caller', 'CALL_MEDIA_UNAVAILABLE']])
  })

  it('fails closed for worker errors, bad frames, short reads, timeouts, and aborts', async () => {
    const cases: Array<{ reply: (socket: Socket) => void, timeoutMs?: number, abort?: boolean, code: string }> = [
      { reply: (socket) => socket.end(response(Uint8Array.of(3, 0xff, 2))), code: 'CALL_OCCUPY_FAILED' },
      { reply: (socket) => socket.end(Buffer.from([0, 1, 0, 1, 2])), code: 'CALL_MEDIA_UNAVAILABLE' },
      { reply: (socket) => socket.end(Buffer.from([0, 0, 0, 2, 2])), code: 'CALL_MEDIA_UNAVAILABLE' },
      { reply: () => {}, timeoutMs: 20, code: 'CALL_MEDIA_UNAVAILABLE' },
      { reply: () => {}, abort: true, code: 'CALL_MEDIA_UNAVAILABLE' },
    ]
    for (const testCase of cases) {
      const server = await fakeServer((_request, socket) => testCase.reply(socket))
      const client = new VoiceWorkerSocketClient({ socketPath: server.path, timeoutMs: testCase.timeoutMs ?? 1_000 })
      const pending = client.prepareTelegramCaller(call)
      if (testCase.abort) client.close()
      await expect(pending).rejects.toMatchObject({ code: testCase.code })
    }

    const unavailable = new VoiceWorkerSocketClient({ socketPath: join(tmpdir(), 'crossgram-missing-voice-worker.sock'), timeoutMs: 20 })
    await expect(unavailable.prepareTelegramCaller(call)).rejects.toMatchObject({ code: 'CALL_MEDIA_UNAVAILABLE' })
  })

  it('uses the configured socket client with CallRegistry without fabricating active media', async () => {
    const gB = new Uint8Array(256).fill(7)
    const server = await fakeServer((request, socket) => {
      expect(tag(request)).toBe(0x02)
      socket.end(response(Buffer.concat([Buffer.from([3, 0x82]), Buffer.from(gB)])))
    })
    const registry = new CallRegistry({ worker: new VoiceWorkerSocketClient({ socketPath: server.path }) })

    const result = await registry.request({
      session: {
        platformSessionId: 'bridge-composition', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
      },
      selfId: 1, participantId: 2, randomId: 3, gAHash: new Uint8Array(32).fill(6), protocol,
    })

    expect(result.phoneCall).toMatchObject({ _: 'phoneCallRequested', gAHash: new Uint8Array(32).fill(6) })
    expect(result.phoneCall._).not.toBe('phoneCall')
    expect(server.requests).toHaveLength(1)
  })

  it('rejects oversized response frames before allocation', async () => {
    const server = await fakeServer((_request, socket) => {
      const header = Buffer.allocUnsafe(4)
      header.writeUInt32BE(VOICE_WORKER_MAX_FRAME_BYTES + 1)
      socket.end(header)
    })
    const client = new VoiceWorkerSocketClient({ socketPath: server.path })
    await expect(client.prepareTelegramCaller(call)).rejects.toMatchObject({ code: 'CALL_MEDIA_UNAVAILABLE' })
  })
})
