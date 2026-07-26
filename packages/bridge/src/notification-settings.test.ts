import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import { defineModels } from './models.js'
import { MUTE_FOREVER, NotificationSettingsStore } from './notification-settings.js'

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map(dispose => dispose()))
})

async function createStore(autoMuteGroupChats = true) {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise(resolve => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return { ctx, store: new NotificationSettingsStore(ctx.database, autoMuteGroupChats) }
}

describe('NotificationSettingsStore', () => {
  it('mutes group chats by default without muting users or broadcast channels', async () => {
    const { store } = await createStore()

    await expect(store.get('session', { type: 'chats' })).resolves.toMatchObject({
      _: 'peerNotifySettings', muteUntil: MUTE_FOREVER, showPreviews: true,
    })
    await expect(store.get('session', { type: 'users' })).resolves.toMatchObject({
      _: 'peerNotifySettings', muteUntil: 0,
    })
    await expect(store.get('session', { type: 'broadcasts' })).resolves.toMatchObject({
      _: 'peerNotifySettings', muteUntil: 0,
    })
    await expect(store.get('session', { type: 'peer', peerId: 'group-1' })).resolves.toEqual({
      _: 'peerNotifySettings',
    })
  })

  it('persists complete per-chat overrides and removes them when reset to inherited defaults', async () => {
    const { ctx, store } = await createStore()
    const target = { type: 'peer' as const, peerId: 'group-1' }

    await store.update('session', target, {
      _: 'inputPeerNotifySettings', muteUntil: 0, showPreviews: false, silent: true,
      sound: { _: 'notificationSoundRingtone', id: Long.fromNumber(42) },
      storiesMuted: true,
      storiesSound: { _: 'notificationSoundLocal', title: 'Quiet', data: 'quiet.caf' },
    })

    const resumed = new NotificationSettingsStore(ctx.database, true)
    await expect(resumed.get('session', target)).resolves.toEqual({
      _: 'peerNotifySettings', muteUntil: 0, showPreviews: false, silent: true,
      iosSound: { _: 'notificationSoundRingtone', id: Long.fromNumber(42) },
      androidSound: { _: 'notificationSoundRingtone', id: Long.fromNumber(42) },
      otherSound: { _: 'notificationSoundRingtone', id: Long.fromNumber(42) },
      storiesMuted: true,
      storiesIosSound: { _: 'notificationSoundLocal', title: 'Quiet', data: 'quiet.caf' },
      storiesAndroidSound: { _: 'notificationSoundLocal', title: 'Quiet', data: 'quiet.caf' },
      storiesOtherSound: { _: 'notificationSoundLocal', title: 'Quiet', data: 'quiet.caf' },
    })

    await resumed.update('session', target, { _: 'inputPeerNotifySettings' })
    await expect(resumed.get('session', target)).resolves.toEqual({ _: 'peerNotifySettings' })
  })

  it('allows a user override for group defaults and restores configured defaults on reset', async () => {
    const { store } = await createStore()

    await store.update('session', { type: 'chats' }, {
      _: 'inputPeerNotifySettings', muteUntil: 0,
    })
    await expect(store.get('session', { type: 'chats' })).resolves.toMatchObject({ muteUntil: 0 })

    await store.update('session', { type: 'peer', peerId: 'group-1' }, {
      _: 'inputPeerNotifySettings', muteUntil: 0,
    })
    await store.reset('session')

    await expect(store.get('session', { type: 'chats' })).resolves.toMatchObject({
      muteUntil: MUTE_FOREVER,
    })
    await expect(store.get('session', { type: 'peer', peerId: 'group-1' })).resolves.toEqual({
      _: 'peerNotifySettings',
    })
  })

  it('can disable automatic group muting through bridge configuration', async () => {
    const { store } = await createStore(false)
    await expect(store.get('session', { type: 'chats' })).resolves.toMatchObject({ muteUntil: 0 })
  })
})
