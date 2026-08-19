import type { PlatformSession } from '../platform.js'
import type { VoiceWorkerCall } from './call-registry.js'

/** One 20 ms 48 kHz mono signed-16-bit-little-endian PCM frame. */
export interface VoicePcmFrame {
  readonly format: {
    readonly encoding: 's16le'
    readonly sampleRate: 48_000
    readonly channels: 1
    readonly durationMs: 20
    readonly samplesPerFrame: 960
    readonly bytesPerFrame: 1_920
  }
  readonly data: Uint8Array
}

/** The QQ-side media session. Token ownership belongs to its provider. */
export interface VoiceMediaSession {
  send(frame: VoicePcmFrame, options?: { signal?: AbortSignal }): void
  receive(options?: { signal?: AbortSignal }): Promise<VoicePcmFrame>
  close(): Promise<void>
  readonly finished: Promise<void>
}

/** A confirmed native-worker PCM endpoint for a single call. */
export interface VoiceWorkerMediaEndpoint {
  send(frame: VoicePcmFrame, options: { signal: AbortSignal }): Promise<void>
  receive(options: { signal: AbortSignal }): AsyncIterable<VoicePcmFrame>
  close(): Promise<void> | void
}

/** Platform seam which consumes a one-use media lease after worker endpoint confirmation. */
export interface VoiceCallMediaProvider {
  start(
    call: VoiceWorkerCall,
    session: PlatformSession,
    endpoint: VoiceWorkerMediaEndpoint,
  ): Promise<VoiceMediaSession>
}

/**
 * Keeps one worker endpoint and one platform PCM session bidirectionally linked.
 * It owns neither keys nor lease tokens, and treats either side becoming terminal
 * as a reason to close both sides.
 */
export class VoiceMediaAttachment {
  private readonly controller = new AbortController()
  private readonly completed = Promise.withResolvers<void>()
  private readonly loops: Promise<void>[]
  private closing?: Promise<void>
  private terminalReported = false

  constructor(
    private readonly media: VoiceMediaSession,
    private readonly worker: VoiceWorkerMediaEndpoint,
    private readonly onTerminal?: (phase: VoiceMediaTerminalPhase, code: string) => void,
  ) {
    this.loops = [this.copyWorkerToMedia(), this.copyMediaToWorker()]
    void media.finished.then(
      () => { this.reportTerminal('platform-finished', 'CLOSED'); return this.close() },
      (error) => { this.reportTerminal('platform-finished', terminalCode(error)); return this.close() },
    )
  }

  /** Resolves after both media resources and both copy loops are terminal. */
  get finished(): Promise<void> {
    return this.completed.promise
  }

  close(): Promise<void> {
    return this.closing ??= this.closeImpl()
  }

  private async copyWorkerToMedia(): Promise<void> {
    try {
      for await (const frame of this.worker.receive({ signal: this.controller.signal })) {
        if (this.controller.signal.aborted) return
        this.media.send(copyFrame(frame), { signal: this.controller.signal })
      }
    } catch (error) {
      // The terminal path below deliberately exposes no platform or worker data.
      if (!this.controller.signal.aborted) this.reportTerminal('worker-receive', terminalCode(error))
    } finally {
      void this.close()
    }
  }

  private async copyMediaToWorker(): Promise<void> {
    try {
      while (!this.controller.signal.aborted) {
        const frame = await this.media.receive({ signal: this.controller.signal })
        await abortable(this.worker.send(copyFrame(frame), { signal: this.controller.signal }), this.controller.signal)
      }
    } catch (error) {
      // The terminal path below deliberately exposes no platform or worker data.
      if (!this.controller.signal.aborted) this.reportTerminal('worker-send', terminalCode(error))
    } finally {
      void this.close()
    }
  }

  private async closeImpl(): Promise<void> {
    this.controller.abort()
    await Promise.allSettled([this.media.close(), this.worker.close()])
    await Promise.allSettled(this.loops)
    this.completed.resolve()
  }

  private reportTerminal(phase: VoiceMediaTerminalPhase, code: string): void {
    if (this.terminalReported) return
    this.terminalReported = true
    try {
      this.onTerminal?.(phase, code)
    } catch {
      // Diagnostics must never change media lifecycle behavior.
    }
  }
}

export type VoiceMediaTerminalPhase = 'platform-finished' | 'worker-receive' | 'worker-send'

function terminalCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UNKNOWN'
}

function copyFrame(frame: VoicePcmFrame): VoicePcmFrame {
  return { format: frame.format, data: new Uint8Array(frame.data) }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
