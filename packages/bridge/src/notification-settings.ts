import type { Database } from '@cordisjs/plugin-database'
import type { tl } from '@mtcute/core'
import Long from 'long'
import type { JsonObject } from './platform.js'

export const MUTE_FOREVER = 0x7fffffff

export type NotificationTarget =
  | { type: 'users' }
  | { type: 'chats' }
  | { type: 'broadcasts' }
  | { type: 'peer', peerId: string }
  | { type: 'topic', peerId: string, topMsgId: number }

interface StoredNotificationSound extends JsonObject {
  type: 'default' | 'none' | 'local' | 'ringtone'
  title?: string
  data?: string
  id?: string
}

interface StoredNotificationSettings extends JsonObject {
  showPreviews?: boolean
  silent?: boolean
  muteUntil?: number
  sound?: StoredNotificationSound
  storiesMuted?: boolean
  storiesHideSender?: boolean
  storiesSound?: StoredNotificationSound
}

/** Durable Telegram notification preferences shared by every auth key for one bridged account. */
export class NotificationSettingsStore {
  private readonly _cache = new Map<string, Promise<Map<string, StoredNotificationSettings>>>()

  constructor(
    private readonly _database: Database,
    private readonly _autoMuteGroupChats = true,
  ) {}

  async get(platformSessionId: string, target: NotificationTarget): Promise<tl.RawPeerNotifySettings> {
    const stored = (await this._settings(platformSessionId)).get(settingScope(target))
    return makePeerNotifySettings(stored ?? this._defaultSettings(target))
  }

  async update(
    platformSessionId: string,
    target: NotificationTarget,
    settings: tl.TypeInputPeerNotifySettings,
  ): Promise<tl.RawPeerNotifySettings> {
    const stored = storeInputSettings(settings)
    const id = settingId(platformSessionId, target)
    const cache = await this._settings(platformSessionId)
    if (!Object.keys(stored).length) {
      await this._database.remove('mtproto_notification_settings', { id })
      cache.delete(settingScope(target))
    } else {
      await this._database.upsert('mtproto_notification_settings', [{
        id,
        platformSessionId,
        scope: settingScope(target),
        settings: stored,
        updatedAt: new Date(),
      }])
      cache.set(settingScope(target), stored)
    }
    return makePeerNotifySettings(Object.keys(stored).length ? stored : this._defaultSettings(target))
  }

  async reset(platformSessionId: string): Promise<void> {
    await this._database.remove('mtproto_notification_settings', { platformSessionId })
    this._cache.set(platformSessionId, Promise.resolve(new Map()))
  }

  async listOverrides(platformSessionId: string): Promise<Array<{
    target: Extract<NotificationTarget, { type: 'peer' | 'topic' }>
    settings: tl.RawPeerNotifySettings
  }>> {
    const settings = await this._settings(platformSessionId)
    return [...settings].flatMap(([scope, stored]) => {
      const target = parseOverrideScope(scope)
      return target ? [{
        target,
        settings: makePeerNotifySettings(stored),
      }] : []
    })
  }

  private _settings(platformSessionId: string): Promise<Map<string, StoredNotificationSettings>> {
    let pending = this._cache.get(platformSessionId)
    if (!pending) {
      pending = this._database.get('mtproto_notification_settings', { platformSessionId })
        .then(rows => new Map(rows.map(row => [
          row.scope,
          row.settings as StoredNotificationSettings,
        ])))
      this._cache.set(platformSessionId, pending)
      pending.catch(() => {
        if (this._cache.get(platformSessionId) === pending) this._cache.delete(platformSessionId)
      })
    }
    return pending
  }

  private _defaultSettings(target: NotificationTarget): StoredNotificationSettings {
    if (target.type === 'peer' || target.type === 'topic') return {}
    return {
      showPreviews: true,
      silent: false,
      muteUntil: target.type === 'chats' && this._autoMuteGroupChats ? MUTE_FOREVER : 0,
      sound: { type: 'default' },
      storiesMuted: false,
      storiesHideSender: false,
      storiesSound: { type: 'default' },
    }
  }
}

function settingId(platformSessionId: string, target: NotificationTarget): string {
  return JSON.stringify([platformSessionId, settingScope(target)])
}

function settingScope(target: NotificationTarget): string {
  if (target.type === 'peer') return `peer:${target.peerId}`
  if (target.type === 'topic') return `topic:${target.peerId}:${target.topMsgId}`
  return target.type
}

function parseOverrideScope(
  scope: string,
): Extract<NotificationTarget, { type: 'peer' | 'topic' }> | undefined {
  if (scope.startsWith('peer:')) return { type: 'peer', peerId: scope.slice('peer:'.length) }
  if (!scope.startsWith('topic:')) return
  const separator = scope.lastIndexOf(':')
  const topMsgId = Number(scope.slice(separator + 1))
  if (separator <= 'topic:'.length || !Number.isSafeInteger(topMsgId)) return
  return { type: 'topic', peerId: scope.slice('topic:'.length, separator), topMsgId }
}

function storeInputSettings(settings: tl.TypeInputPeerNotifySettings): StoredNotificationSettings {
  return {
    ...(settings.showPreviews !== undefined ? { showPreviews: settings.showPreviews } : {}),
    ...(settings.silent !== undefined ? { silent: settings.silent } : {}),
    ...(settings.muteUntil !== undefined ? { muteUntil: settings.muteUntil } : {}),
    ...(settings.sound !== undefined ? { sound: storeSound(settings.sound) } : {}),
    ...(settings.storiesMuted !== undefined ? { storiesMuted: settings.storiesMuted } : {}),
    ...(settings.storiesHideSender !== undefined ? { storiesHideSender: settings.storiesHideSender } : {}),
    ...(settings.storiesSound !== undefined ? { storiesSound: storeSound(settings.storiesSound) } : {}),
  }
}

function storeSound(sound: tl.TypeNotificationSound): StoredNotificationSound {
  if (sound._ === 'notificationSoundLocal') {
    return { type: 'local', title: sound.title, data: sound.data }
  }
  if (sound._ === 'notificationSoundRingtone') {
    return { type: 'ringtone', id: sound.id.toString() }
  }
  return { type: sound._ === 'notificationSoundNone' ? 'none' : 'default' }
}

function loadSound(sound: StoredNotificationSound): tl.TypeNotificationSound {
  if (sound.type === 'none') return { _: 'notificationSoundNone' }
  if (sound.type === 'local') {
    return { _: 'notificationSoundLocal', title: sound.title ?? '', data: sound.data ?? '' }
  }
  if (sound.type === 'ringtone') {
    return { _: 'notificationSoundRingtone', id: Long.fromString(sound.id ?? '0') }
  }
  return { _: 'notificationSoundDefault' }
}

function makePeerNotifySettings(settings: StoredNotificationSettings): tl.RawPeerNotifySettings {
  const sound = settings.sound ? loadSound(settings.sound) : undefined
  const storiesSound = settings.storiesSound ? loadSound(settings.storiesSound) : undefined
  return {
    _: 'peerNotifySettings',
    ...(settings.showPreviews !== undefined ? { showPreviews: settings.showPreviews } : {}),
    ...(settings.silent !== undefined ? { silent: settings.silent } : {}),
    ...(settings.muteUntil !== undefined ? { muteUntil: settings.muteUntil } : {}),
    ...(sound ? { iosSound: sound, androidSound: sound, otherSound: sound } : {}),
    ...(settings.storiesMuted !== undefined ? { storiesMuted: settings.storiesMuted } : {}),
    ...(settings.storiesHideSender !== undefined ? { storiesHideSender: settings.storiesHideSender } : {}),
    ...(storiesSound ? {
      storiesIosSound: storiesSound,
      storiesAndroidSound: storiesSound,
      storiesOtherSound: storiesSound,
    } : {}),
  }
}
