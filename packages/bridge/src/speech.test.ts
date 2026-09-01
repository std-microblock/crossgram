import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  SpeechPipeline,
  type SpeechSynthesisInput,
  type SpeechTranscriptionInput,
} from './speech.js'

describe('SpeechPipeline', () => {
  it('allows a provider to handle transcription through the Cordis waterfall', async () => {
    const ctx = new Context()
    const speech = new SpeechPipeline(ctx)
    const input: SpeechTranscriptionInput = {
      platform: {} as never,
      session: { platformId: 'qq', platformSessionId: 's', userId: 'u', credentials: {}, metadata: {} },
      media: { id: 'voice', kind: 'file', voice: true },
      automatic: true,
    }
    const provider = vi.fn(async (_request: SpeechTranscriptionInput, next: () => Promise<never>) => {
      await next()
      return { text: '你好', provider: 'test' }
    })
    ctx.on('bridge/speech/transcribe', provider)

    await expect(speech.transcribe(input)).resolves.toEqual({ text: '你好', provider: 'test' })
    expect(provider).toHaveBeenCalledOnce()
  })

  it('returns undefined when no synthesis provider handles the request', async () => {
    const ctx = new Context()
    const speech = new SpeechPipeline(ctx)
    const input: SpeechSynthesisInput = {
      platform: {} as never,
      session: { platformId: 'qq', platformSessionId: 's', userId: 'u', credentials: {}, metadata: {} },
      text: 'hello',
    }
    await expect(speech.synthesize(input)).resolves.toBeUndefined()
  })
})
