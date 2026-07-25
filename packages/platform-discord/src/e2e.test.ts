import { afterAll, describe, expect, it } from 'vitest'
import type { PlatformSession } from '@mtproto-relay/bridge'
import { DiscordPlatform } from './index.js'

const enabled = process.env.DISCORD_USERBOT_E2E === '1'
const token = process.env.DISCORD_USER_TOKEN
const channelId = process.env.DISCORD_E2E_CHANNEL_ID
const platform = new DiscordPlatform({ token })

const session: PlatformSession = {
  platformSessionId: 'live-discord-userbot', platformId: 'discord', userId: 'pending',
  credentials: {}, metadata: {},
}

afterAll(() => platform.stop())

describe.skipIf(!enabled)('DiscordPlatform live userbot E2E', () => {
  it('logs in as a normal user and discovers the configured channel in paginated dialogs', async () => {
    if (!token || !channelId) throw new Error('DISCORD_USER_TOKEN and DISCORD_E2E_CHANNEL_ID are required')
    const account = await platform.getAccount()
    expect(account.user.id).toMatch(/^\d+$/)
    expect(account.user.metadata).not.toHaveProperty('discordBot', true)
    session.userId = account.user.id

    const ids: string[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await platform.getDialogs(session, { cursor, limit: 25 })
      ids.push(...page.dialogs.map((dialog) => dialog.conversation.id))
      cursor = page.nextCursor
      if (cursor) {
        expect(seen.has(cursor)).toBe(false)
        seen.add(cursor)
      }
    } while (cursor && ids.length < 10_000)
    expect(ids).toContain(channelId)
    expect(new Set(ids).size).toBe(ids.length)
  }, 120_000)

  it('round-trips send, history, edit, reaction, read state, and delete', async () => {
    if (!token || !channelId) throw new Error('DISCORD_USER_TOKEN and DISCORD_E2E_CHANNEL_ID are required')
    const account = await platform.getAccount()
    session.userId = account.user.id
    const marker = `CrossGram Discord userbot e2e ${Date.now()}`
    const sent = await platform.sendMessage(session, { id: channelId }, {
      parts: [{ type: 'text', text: marker }],
    })
    try {
      expect(sent.outgoing).toBe(true)
      const history = await platform.getHistory(session, { id: channelId }, { limit: 20 })
      expect(history.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: sent.id, senderId: account.user.id }),
      ]))

      const edited = await platform.editMessage(session, {
        conversationId: channelId, messageId: sent.id, targetId: sent.id,
      }, { parts: [{ type: 'text', text: `${marker} edited` }] })
      expect(edited.content.parts).toMatchObject([{ type: 'text', text: `${marker} edited` }])

      const reactions = await platform.setMessageReactions(session, {
        conversationId: channelId, messageId: sent.id, targetId: sent.id,
      }, ['unicode:👍'])
      expect(reactions.reactions).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'unicode:👍', selected: true }),
      ]))

      await platform.markRead(session, { conversationId: channelId, messageId: sent.id })
    } finally {
      await platform.deleteMessages(session, { id: channelId }, [sent.id])
    }
  }, 120_000)
})
