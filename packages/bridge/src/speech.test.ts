import { Context } from 'cordis'
import Long from 'long'
import { describe, expect, it, vi } from 'vitest'
import {
  SpeechPipeline,
  type SpeechSynthesisInput,
  type SpeechTranscriptionInput,
} from './speech.js'
import { DialogRpc, stableId } from './dialogs.js'

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

  it('serves messages.transcribeAudio from a stored voice through the provider waterfall', async () => {
    const ctx = new Context()
    const speech = new SpeechPipeline(ctx)
    const session = { platformId: 'qq', platformSessionId: 's', userId: 'self', credentials: {}, metadata: {} }
    const conversation = { id: 'group', kind: 'group' as const, title: 'Group' }
    const message = {
      id: 'voice-message', conversationId: conversation.id, senderId: 'peer', timestamp: 1,
      content: { parts: [{ type: 'media' as const, media: {
        id: 'voice', kind: 'file' as const, voice: true,
      } }] },
    }
    const store = {
      peerRevision: 0,
      getUser: vi.fn(async () => ({
        id: 1, platformId: 'qq', platformUserId: 'self', firstName: 'Self',
        lastName: null, username: null, avatar: null, metadata: {},
      })),
      listConversations: vi.fn(async () => [conversation]),
      readUsers: vi.fn(async () => []),
      findProjectedByTlId: vi.fn(async () => ({
        source: message, parts: [{ tlMessageId: 42, ordinal: 0 }], media: [],
      })),
    }
    const platform = { capabilities: {}, subscribe: async () => () => {} } as never
    const rpc = new DialogRpc(platform, session, store as never)
    ctx.on('bridge/speech/transcribe', async () => ({ text: '转写成功', provider: 'qq-native' }))

    await expect(rpc.transcribeAudio({
      _: 'messages.transcribeAudio',
      peer: { _: 'inputPeerChannel', channelId: stableId('peer:group'), accessHash: Long.ONE },
      msgId: 42,
    }, speech)).resolves.toMatchObject({
      _: 'messages.transcribedAudio', pending: false, text: '转写成功',
    })
  })
})
