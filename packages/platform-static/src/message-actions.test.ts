import { describe, expect, it } from 'vitest'
import type { IMMedia, PlatformSession } from '@mtproto-relay/bridge'
import { StaticPlatform, type StaticMediaLocator } from './index.js'

const session: PlatformSession = {
  platformSessionId: 'actions-session', platformId: 'static', userId: 'self', credentials: {},
  metadata: { firstName: 'Current', username: 'current' },
}

async function bytes(platform: StaticPlatform, media: IMMedia<StaticMediaLocator>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of platform.downloadMedia(session, media)) chunks.push(chunk)
  return Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))
}

describe('StaticPlatform administrative domain', () => {
  it('returns paginated members with owner, administrator, and granular permissions', async () => {
    const platform = new StaticPlatform({ instanceId: 'members', historySize: 0 })
    const first = await platform.getConversationMembers(session, { id: 'qq-group' }, { limit: 2 })
    expect(first).toMatchObject({ total: 4, nextCursor: '2' })
    expect(first.members).toMatchObject([
      { user: { id: 'self' }, role: 'owner', permissions: { deleteAnyMessage: true, editAnyMessage: true } },
      { user: { id: 'alice' }, role: 'administrator', title: 'Moderator', permissions: { deleteAnyMessage: true } },
    ])
    const second = await platform.getConversationMembers(session, { id: 'qq-group' }, { cursor: first.nextCursor, limit: 2 })
    expect(second.members.map((member) => member.user.id)).toEqual(['bob', 'carol'])
    await expect(platform.getConversationMember(session, { id: 'qq-group' }, 'alice'))
      .resolves.toMatchObject({ role: 'administrator' })
    await expect(platform.getConversationMember(session, { id: 'qq-group' }, 'missing')).resolves.toBeNull()
  })

  it('persists administrator promotion and demotion for subsequent member reads', async () => {
    const platform = new StaticPlatform({ instanceId: 'member-roles', historySize: 0 })

    await platform.setConversationMemberRole(session, { id: 'qq-group' }, 'bob', 'administrator')
    await expect(platform.getConversationMember(session, { id: 'qq-group' }, 'bob'))
      .resolves.toMatchObject({ role: 'administrator' })

    await platform.setConversationMemberRole(session, { id: 'qq-group' }, 'bob', 'member')
    await expect(platform.getConversationMember(session, { id: 'qq-group' }, 'bob'))
      .resolves.toMatchObject({ role: 'member' })
    await expect(platform.setConversationMemberRole(session, { id: 'qq-group' }, 'self', 'member'))
      .rejects.toThrow('owner role cannot be changed')
  })

  it('exposes user and conversation avatars through typed IMMedia locators', async () => {
    const platform = new StaticPlatform({ instanceId: 'avatars', historySize: 0 })
    const user = await platform.getUser(session, 'alice')
    const dialogs = await platform.getDialogs(session, { limit: 100 })
    const group = dialogs.dialogs.find((dialog) => dialog.conversation.id === 'qq-group')?.conversation
    expect(user?.avatar?.locator).toEqual({ mediaId: 'avatar:user:alice' } satisfies StaticMediaLocator)
    expect(user?.about).toBe('Static Alice signature')
    expect(group?.avatar?.locator).toEqual({ mediaId: 'avatar:conversation:qq-group' } satisfies StaticMediaLocator)
    expect(await bytes(platform, user!.avatar!)).toEqual(await bytes(platform, group!.avatar!))
  })
})

describe('StaticPlatform message actions', () => {
  it('edits in place, deletes by a physical alias, and forwards with provenance', async () => {
    const platform = new StaticPlatform({ instanceId: 'mutations', now: () => 1_800_000_000, historySize: 0 })
    const sent = await platform.sendMessage(session, { id: 'qq-group' }, {
      parts: [{ type: 'text', text: 'before' }],
    })
    const edited = await platform.editMessage(session, {
      conversationId: 'qq-group', messageId: sent.id, targetId: sent.id,
    }, { parts: [{ type: 'text', text: 'after' }] })
    expect(edited).toMatchObject({ id: sent.id, content: { parts: [{ text: 'after' }] } })

    const [forwarded] = await platform.forwardMessages(
      session, { id: 'qq-group' }, [sent.id], { id: 'group-c' },
    )
    expect(forwarded).toMatchObject({
      conversationId: 'group-c', senderId: 'self', outgoing: true,
      metadata: { forwardedFromConversationId: 'qq-group', forwardedFromMessageId: sent.id },
    })
    expect(forwarded.id).not.toBe(sent.id)

    await platform.deleteMessages(session, { id: 'qq-group' }, [sent.id], { forEveryone: true })
    const history = await platform.getHistory(session, { id: 'qq-group' }, { limit: 100 })
    expect(history.messages.some((message) => message.id === sent.id)).toBe(false)
  })
})
