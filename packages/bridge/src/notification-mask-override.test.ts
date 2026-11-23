import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import { DialogRpc, peerTlSeed, stableId } from './dialogs.js'
import { defineModels } from './models.js'
import { MUTE_FOREVER, NotificationSettingsStore } from './notification-settings.js'
import type { IMConversation, IMPlatform, PlatformSession } from './platform.js'

const session: PlatformSession = {
  platformSessionId: 'mask-override',
  platformId: 'test',
  userId: 'self',
  credentials: {},
  metadata: {},
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map(dispose => dispose()))
})

async function createSettings(autoMuteGroupChats = true): Promise<NotificationSettingsStore> {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise(resolve => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return new NotificationSettingsStore(ctx.database, autoMuteGroupChats)
}

function basePlatform(conversations: IMConversation[], extra: Partial<IMPlatform> = {}): IMPlatform {
  return {
    capabilities: {
      history: true,
      send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
      conversations: { groups: true, channels: true, subchannels: false },
    },
    async subscribe() { return () => {} },
    async getDialogs() {
      return { dialogs: conversations.map(conversation => ({ conversation, unreadCount: 0 })) }
    },
    async getHistory() { return { messages: [] } },
    async getUser(_session, id) { return { id, firstName: id } },
    async sendMessage() { throw new Error('send is disabled') },
    ...extra,
  } as IMPlatform
}

async function loadDialogs(
  platform: IMPlatform,
  settings: NotificationSettingsStore,
): Promise<DialogRpc> {
  const dialogs = new DialogRpc(platform, session, undefined, { notificationSettings: settings })
  await dialogs.getDialogs({
    _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
    offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
  })
  return dialogs
}

/** Telegram ids are scoped to the platform session (see `peerTlSeed`). */
function peerChannelId(platformPeerId: string): number {
  return stableId(peerTlSeed(session.platformSessionId, platformPeerId))
}

function notifyPeer(conversationId: string) {
  return {
    _: 'inputNotifyPeer' as const,
    peer: {
      _: 'inputPeerChannel' as const,
      channelId: peerChannelId(conversationId),
      accessHash: Long.ONE,
    },
  }
}

async function muteForever(dialogs: DialogRpc, conversationId: string, muteUntil: number) {
  return dialogs.updateNotifySettings({
    _: 'account.updateNotifySettings',
    peer: notifyPeer(conversationId),
    settings: { _: 'inputPeerNotifySettings', muteUntil },
  })
}

async function readSettings(dialogs: DialogRpc, conversationId: string) {
  return dialogs.getNotifySettings({
    _: 'account.getNotifySettings', peer: notifyPeer(conversationId),
  })
}

function qqGroup(id: string, mask: 0 | 1 | 2 | 3 | 4): IMConversation {
  return {
    id, kind: 'group', title: id,
    metadata: { qqGroupMsgMask: mask, qq: '1058754719', chatType: 2 },
  }
}

describe('Telegram notify settings over the QQ group message mask', () => {
  it('keeps a mute the user set in Telegram', async () => {
    const platform = basePlatform([qqGroup('qq', 1)])
    const settings = await createSettings()
    const dialogs = await loadDialogs(platform, settings)

    // QQ reports "notify", but the user muted the chat in Telegram: the override
    // has to win, otherwise the answer below is 0 and the client unmutes it.
    const changed = await muteForever(dialogs, 'qq', MUTE_FOREVER)
    expect(changed.settings.muteUntil).toBe(MUTE_FOREVER)
    await expect(readSettings(dialogs, 'qq')).resolves.toMatchObject({ muteUntil: MUTE_FOREVER })

    const page = await dialogs.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })
    if (page._ === 'messages.dialogsNotModified') throw new Error('expected materialized dialogs')
    expect(page.dialogs[0]).toMatchObject({
      _: 'dialog', notifySettings: { _: 'peerNotifySettings', muteUntil: MUTE_FOREVER },
    })
  })

  it('keeps the mute when the QQ writeback fails', async () => {
    const maskWrites: Array<{ conversationId: string, mask: number }> = []
    const platform = basePlatform([qqGroup('qq', 1)], {
      async setConversationNotificationMask(_session, conversationId, mask) {
        maskWrites.push({ conversationId, mask })
        throw new Error('qqnt-bridge has no notification-mask route')
      },
    })
    const settings = await createSettings()
    const dialogs = await loadDialogs(platform, settings)

    const changed = await muteForever(dialogs, 'qq', MUTE_FOREVER)
    expect(maskWrites).toEqual([{ conversationId: 'qq', mask: 4 }])
    expect(changed.settings.muteUntil).toBe(MUTE_FOREVER)
    await expect(readSettings(dialogs, 'qq')).resolves.toMatchObject({ muteUntil: MUTE_FOREVER })
  })

  it('lets the user unmute a group the QQ mask mutes', async () => {
    const platform = basePlatform([qqGroup('qq', 4)])
    const settings = await createSettings()
    const dialogs = await loadDialogs(platform, settings)

    await expect(readSettings(dialogs, 'qq')).resolves.toMatchObject({ muteUntil: MUTE_FOREVER })
    const changed = await muteForever(dialogs, 'qq', 0)
    expect(changed.settings.muteUntil).toBe(0)
    await expect(readSettings(dialogs, 'qq')).resolves.toMatchObject({ muteUntil: 0 })
  })

  it('still follows the QQ mask for a peer the user never touched', async () => {
    const notifyGroup = qqGroup('notify', 1)
    const receiveGroup = qqGroup('receive', 4)
    const platform = basePlatform([notifyGroup, receiveGroup])
    const settings = await createSettings()
    const dialogs = await loadDialogs(platform, settings)

    // Group chats are muted by default, so "notify" in QQ is what unmutes it.
    await expect(readSettings(dialogs, 'notify')).resolves.toMatchObject({ muteUntil: 0 })
    await expect(readSettings(dialogs, 'receive')).resolves.toMatchObject({
      muteUntil: MUTE_FOREVER,
    })
  })

  it('keeps the QQ mute when only other fields were overridden', async () => {
    const platform = basePlatform([qqGroup('qq', 4)])
    const settings = await createSettings()
    const dialogs = await loadDialogs(platform, settings)

    await dialogs.updateNotifySettings({
      _: 'account.updateNotifySettings',
      peer: notifyPeer('qq'),
      settings: { _: 'inputPeerNotifySettings', showPreviews: false },
    })
    await expect(readSettings(dialogs, 'qq')).resolves.toMatchObject({
      muteUntil: MUTE_FOREVER, showPreviews: false,
    })
  })
})
