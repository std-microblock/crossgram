import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import type { tl } from '@mtcute/core'
import {
  MessageProjectionPipeline,
  type MessageProjectionInput,
  type MessageProjectionPlanInput,
} from './message-projection.js'
import type { IMConversation, IMMessage, PlatformSession } from './platform.js'

const session: PlatformSession = {
  platformId: 'test', platformSessionId: 'projection-session', userId: 'self',
  credentials: {}, metadata: {},
}

const conversation: IMConversation = {
  id: 'projection-conversation', kind: 'group', title: 'Projection',
}

const source: IMMessage = {
  id: 'projection-message', conversationId: conversation.id, senderId: 'alice', timestamp: 1,
  content: { parts: [{ type: 'text', text: 'original' }] },
}

function planInput(allocation: 'live' | 'history' = 'live'): MessageProjectionPlanInput {
  return { session, conversation, source, allocation }
}

function projectInput(mode: 'history' | 'update'): MessageProjectionInput {
  return {
    mode, session, conversation, tlMessageId: 100, ordinal: 0,
    draft: { source, chats: [] },
  }
}

function rendered(input: MessageProjectionInput): tl.RawMessage {
  const text = input.draft.source.content.parts
    .flatMap((part) => part.type === 'text' ? [part.text] : [])
    .join('\n')
  return {
    _: 'message', id: input.tlMessageId,
    peerId: { _: 'peerChannel', channelId: 1 }, date: 1, message: text,
    media: input.draft.media, entities: input.draft.entities,
  }
}

describe('MessageProjectionPipeline', () => {
  it('composes durable projection planning as an ordered Cordis waterfall', async () => {
    const ctx = new Context()
    const pipeline = new MessageProjectionPipeline(ctx)
    const order: string[] = []
    ctx.on('bridge/message/project-plan', async (input, next) => {
      order.push(`outer:${input.allocation}:before`)
      const plan = await next()
      order.push('outer:after')
      return { ...plan, grouped: true }
    })
    ctx.on('bridge/message/project-plan', async (_input, next) => {
      order.push('inner:before')
      const plan = await next()
      order.push('inner:after')
      return { ...plan, parts: [...plan.parts, {}] }
    })

    await expect(pipeline.plan(planInput('history'), () => {
      order.push('fallback')
      return { parts: [{}], grouped: false }
    })).resolves.toEqual({ parts: [{}, {}], grouped: true })
    expect(order).toEqual([
      'outer:history:before', 'inner:before', 'fallback', 'inner:after', 'outer:after',
    ])
  })

  it.each(['history', 'update'] as const)(
    'lets feature middleware mutate the %s draft before the shared default renderer',
    async (mode) => {
      const ctx = new Context()
      const pipeline = new MessageProjectionPipeline(ctx)
      const loadConversation = vi.fn(async () => [])
      ctx.on('bridge/message/project', async (input, next) => {
        expect(input.mode).toBe(mode)
        expect(input.loadConversation).toBe(loadConversation)
        input.draft.source = {
          ...input.draft.source,
          content: { parts: [{ type: 'text', text: `projected:${input.mode}` }] },
        }
        input.draft.media = { _: 'messageMediaUnsupported' }
        input.draft.chats.push({
          _: 'chat', id: 42, title: 'Synthetic', left: true,
          photo: { _: 'chatPhotoEmpty' }, participantsCount: 1, date: 0, version: 1,
        })
        return next()
      })
      const input = { ...projectInput(mode), loadConversation }

      await expect(pipeline.project(input, () => ({
        message: rendered(input), chats: input.draft.chats,
      }))).resolves.toMatchObject({
        message: { _: 'message', message: `projected:${mode}`, media: { _: 'messageMediaUnsupported' } },
        chats: [{ _: 'chat', id: 42, title: 'Synthetic' }],
      })
    },
  )

  it('removes projection middleware with its owning Cordis plugin scope', async () => {
    const ctx = new Context()
    const pipeline = new MessageProjectionPipeline(ctx)
    const middleware = vi.fn(async (_input: MessageProjectionPlanInput, next: () => Promise<{
      parts: Array<Record<string, never>>
      grouped: boolean
    }>) => {
      const plan = await next()
      return { ...plan, parts: [...plan.parts, {}] }
    })
    const owner = ctx.plugin((scope) => {
      scope.on('bridge/message/project-plan', middleware)
    })
    await owner

    await expect(pipeline.plan(planInput(), () => ({ parts: [{}], grouped: false })))
      .resolves.toMatchObject({ parts: [{}, {}] })
    expect(middleware).toHaveBeenCalledOnce()

    await owner.dispose()

    await expect(pipeline.plan(planInput(), () => ({ parts: [{}], grouped: false })))
      .resolves.toEqual({ parts: [{}], grouped: false })
    expect(middleware).toHaveBeenCalledOnce()
  })
})
