import { describe, expect, it, vi } from 'vitest'
import Long from 'long'
import {
  stableId,
  type IMMedia,
  type IMMessageBundle,
  type IMMessageSnapshot,
  type IMPlatform,
  type PlatformSession,
} from '@mtproto-relay/bridge'
import { makeMergedForwardProvider } from './index.js'

const session: PlatformSession = {
  platformId: 'test', platformSessionId: 'avatar-session', userId: 'self',
  credentials: {}, metadata: {},
}

const bundle: IMMessageBundle = {
  id: 'bundle:avatars', title: '群聊的聊天记录', locator: { root: 'forward-avatar' },
}

function media(id: string, extra: Partial<IMMedia> = {}): IMMedia<any> {
  return { id, kind: 'image', mimeType: 'image/jpeg', locator: { id }, ...extra }
}

function platform(avatar?: IMMedia<any>): IMPlatform {
  return {
    capabilities: {
      history: true,
      send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
      conversations: { groups: true, channels: false, subchannels: false },
    },
    messageBundles: {
      async load() { return [] },
      ...(avatar ? { avatar: async () => avatar } : {}),
    },
    async subscribe() { return () => {} },
    async sendMessage() { throw new Error('unused') },
  }
}

function snapshot(senderId: string, avatar?: IMMedia<any>): IMMessageSnapshot {
  return {
    id: `inner-${senderId}`, senderId, timestamp: 1,
    sender: { id: senderId, firstName: senderId, avatar },
    content: { parts: [{ type: 'text', text: senderId }] },
  }
}

function state(): any {
  return { session }
}

describe('merged-forward avatars', () => {
  it('projects the archived sender avatar as the temporary user photo', () => {
    const projection = makeMergedForwardProvider(3)
    const sender = media('avatar:user:alice:original-v1')
    const user = projection.makeBundleUser(state(), snapshot('alice', sender))
    const photoId = stableId(`avatar:${sender.id}`)

    expect(user.photo).toMatchObject({
      _: 'userProfilePhoto', dcId: 3, photoId: Long.fromNumber(photoId),
    })
    expect(projection.resolveAvatarLocation(session.platformSessionId, {
      _: 'inputPeerPhotoFileLocation', big: true,
      peer: { _: 'inputPeerUser', userId: user.id, accessHash: Long.ONE },
      photoId: Long.fromNumber(photoId),
    })?.media).toBe(sender)
  })

  it('keeps the empty photo when the archive carries no sender avatar', () => {
    const projection = makeMergedForwardProvider()
    const user = projection.makeBundleUser(state(), snapshot('bob'))
    expect(user.photo).toEqual({ _: 'userProfilePhotoEmpty' })
  })

  it('does not answer photo locations of other peers or sessions', () => {
    const projection = makeMergedForwardProvider()
    const sender = media('avatar:user:carol:original-v1')
    const user = projection.makeBundleUser(state(), snapshot('carol', sender))
    const photoId = Long.fromNumber(stableId(`avatar:${sender.id}`))

    expect(projection.resolveAvatarLocation(session.platformSessionId, {
      _: 'inputPeerPhotoFileLocation', big: false,
      peer: { _: 'inputPeerUser', userId: user.id + 1, accessHash: Long.ONE },
      photoId,
    })).toBeUndefined()
    expect(projection.resolveAvatarLocation('other-session', {
      _: 'inputPeerPhotoFileLocation', big: false,
      peer: { _: 'inputPeerUser', userId: user.id, accessHash: Long.ONE },
      photoId,
    })).toBeUndefined()
    expect(projection.resolveAvatarLocation(session.platformSessionId, {
      _: 'inputPhotoFileLocation',
      id: photoId, accessHash: Long.ONE, fileReference: new Uint8Array(), thumbSize: 'x',
    })).toBeUndefined()
  })

  it('gives the synthetic chat and its card the archived chat avatar', async () => {
    const adapter = platform(media('avatar:group:1234:original-v1', { width: 640, height: 640 }))
    const projection = makeMergedForwardProvider(2)
    const record = projection.remember(session.platformSessionId, bundle)
    const input = { platform: adapter, session }
    const avatar = await projection.loadAvatar(input, record)
    const chat = projection.makeChat(record, [], avatar)
    const photoId = Long.fromNumber(stableId(`avatar:${avatar!.id}`))

    expect(chat.photo).toMatchObject({ _: 'chatPhoto', photoId, dcId: 2 })
    expect(projection.resolveAvatarLocation(session.platformSessionId, {
      _: 'inputPeerPhotoFileLocation', big: false,
      peer: { _: 'inputPeerChat', chatId: chat.id },
      photoId,
    })?.media).toBe(avatar)

    const preview = projection.makePreview(record, 42, avatar)
    expect(preview.webpage.photo).toMatchObject({
      _: 'photo', id: photoId, dcId: 2,
      sizes: [
        { _: 'photoSize', type: 'm', w: 640, h: 640 },
        { _: 'photoSize', type: 'x', w: 640, h: 640 },
      ],
    })
    const photo = preview.webpage.photo!
    if (photo._ !== 'photo') throw new Error('preview photo missing')
    expect(projection.resolveAvatarLocation(session.platformSessionId, {
      _: 'inputPhotoFileLocation',
      id: photo.id, accessHash: photo.accessHash,
      fileReference: photo.fileReference, thumbSize: 'x',
    })?.media).toBe(avatar)
  })

  it('loads the bundle avatar once and tolerates adapters without the hook', async () => {
    const avatar = media('avatar:group:99:original-v1')
    const lookup = vi.fn(async () => avatar)
    const adapter = platform(avatar)
    adapter.messageBundles = { load: async () => [], avatar: lookup }
    const projection = makeMergedForwardProvider()
    const record = projection.remember(session.platformSessionId, bundle)

    await expect(projection.loadAvatar({ platform: adapter, session }, record)).resolves.toBe(avatar)
    await expect(projection.loadAvatar({ platform: adapter, session }, record)).resolves.toBe(avatar)
    expect(lookup).toHaveBeenCalledOnce()

    const bare = projection.remember(session.platformSessionId, { ...bundle, id: 'bundle:bare' })
    await expect(projection.loadAvatar({ platform: platform(), session }, bare)).resolves.toBeUndefined()
  })

  it('survives a failing adapter avatar lookup and retries it later', async () => {
    const attempts = vi.fn(() => {
      throw new Error('adapter exploded')
    })
    const broken = platform()
    broken.messageBundles = { load: async () => [], avatar: attempts as never }
    const projection = makeMergedForwardProvider()
    const record = projection.remember(session.platformSessionId, bundle)

    await expect(projection.loadAvatar({ platform: broken, session }, record)).resolves.toBeUndefined()
    await expect(projection.loadAvatar({ platform: broken, session }, record)).resolves.toBeUndefined()
    expect(attempts).toHaveBeenCalledTimes(2)

    const rejecting = platform()
    rejecting.messageBundles = {
      load: async () => [],
      avatar: async () => {
        throw new Error('bridge offline')
      },
    }
    const second = projection.remember(session.platformSessionId, { ...bundle, id: 'bundle:rejecting' })
    await expect(projection.loadAvatar({ platform: rejecting, session }, second)).resolves.toBeUndefined()

    const recovered = platform(media('avatar:group:7:original-v1'))
    await expect(projection.loadAvatar({ platform: recovered, session }, second))
      .resolves.toMatchObject({ id: 'avatar:group:7:original-v1' })
  })

  it('keeps one avatar media addressable from every transcript that uses it', () => {
    const projection = makeMergedForwardProvider()
    const shared = media('avatar:group:shared:original-v1')
    const first = projection.remember(session.platformSessionId, { ...bundle, id: 'bundle:first' })
    const second = projection.remember(session.platformSessionId, { ...bundle, id: 'bundle:second' })
    const firstChat = projection.makeChat(first, [], shared)
    const secondChat = projection.makeChat(second, [], shared)
    const photoId = Long.fromNumber(stableId(`avatar:${shared.id}`))

    expect(firstChat.id).not.toBe(secondChat.id)
    for (const chat of [firstChat, secondChat]) {
      expect(projection.resolveAvatarLocation(session.platformSessionId, {
        _: 'inputPeerPhotoFileLocation', big: false,
        peer: { _: 'inputPeerChat', chatId: chat.id },
        photoId,
      })?.media).toBe(shared)
    }
  })

  it('routes only file locations it knows back to this feature', () => {
    const projection = makeMergedForwardProvider()
    const peerPhotoId = Long.fromNumber(stableId('avatar:avatar:user:erin:original-v1'))
    const photoReference = new TextEncoder().encode('crossgram-merged-forward-avatar:v1')

    // Nothing is registered yet, so even the file reference this feature uses
    // is not enough to claim a request.
    expect(projection.mightServeLocation({
      _: 'inputPhotoFileLocation', id: Long.ONE, accessHash: Long.ONE,
      fileReference: photoReference, thumbSize: 'x',
    })).toBe(false)

    projection.makeBundleUser(state(), snapshot('erin', media('avatar:user:erin:original-v1')))
    expect(projection.mightServeLocation({
      _: 'inputPeerPhotoFileLocation', big: false,
      peer: { _: 'inputPeerUser', userId: 1, accessHash: Long.ONE }, photoId: peerPhotoId,
    })).toBe(true)
    expect(projection.mightServeLocation({
      _: 'inputPeerPhotoFileLocation', big: false,
      peer: { _: 'inputPeerUser', userId: 1, accessHash: Long.ONE },
      photoId: Long.fromNumber(peerPhotoId.toNumber() + 1),
    })).toBe(false)
    expect(projection.mightServeLocation({
      _: 'inputPhotoFileLocation', id: peerPhotoId, accessHash: Long.ONE,
      fileReference: new TextEncoder().encode('bridge-card-thumbnail:v1'), thumbSize: 'x',
    })).toBe(false)
    expect(projection.mightServeLocation({
      _: 'inputPhotoFileLocation', id: peerPhotoId, accessHash: Long.ONE,
      fileReference: photoReference, thumbSize: 'x',
    })).toBe(true)
    expect(projection.mightServeLocation({
      _: 'inputDocumentFileLocation', id: Long.ONE, accessHash: Long.ONE,
      fileReference: new Uint8Array(), thumbSize: 'x',
    })).toBe(false)
  })

  it('drops remembered photos when the feature is unloaded', () => {
    const projection = makeMergedForwardProvider()
    const sender = media('avatar:user:dan:original-v1')
    const user = projection.makeBundleUser(state(), snapshot('dan', sender))
    const photoId = Long.fromNumber(stableId(`avatar:${sender.id}`))
    const location = {
      _: 'inputPeerPhotoFileLocation' as const, big: false,
      peer: { _: 'inputPeerUser' as const, userId: user.id, accessHash: Long.ONE },
      photoId,
    }
    expect(projection.resolveAvatarLocation(session.platformSessionId, location)).toBeDefined()
    projection.clear()
    expect(projection.resolveAvatarLocation(session.platformSessionId, location)).toBeUndefined()
  })
})
