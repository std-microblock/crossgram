import { describe, expect, it, vi } from 'vitest'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import { getApiLayerWriterMap } from '../../mtproto/src/rpc/api-layer.js'
import { getServerReaderMap } from '../../mtproto/src/rpc/server-reader-map.js'
import { DialogRpc } from './dialogs.js'
import type { IMDialogPage, IMMessage, IMPlatform, IMUser, PlatformSession } from './platform.js'

/** Constructor ids the patched clients hardcode for the poke feature. */
const GET_FEATURES_CONSTRUCTOR = 0xc3e6b915
const SEND_POKE_CONSTRUCTOR = 0x9a2d47f0

const session: PlatformSession = {
  platformId: 'poke-e2e',
  platformSessionId: 'poke-e2e',
  userId: 'me',
  credentials: {},
  metadata: { firstName: 'Current' },
}

const notice: IMMessage = {
  id: 'poke-notice',
  conversationId: 'group',
  senderId: 'me',
  timestamp: 1_800_000_000,
  outgoing: true,
  content: { parts: [], serviceAction: { type: 'custom', text: '你戳了戳Alice' } },
}

class PokePlatform implements IMPlatform {
  readonly capabilities: IMPlatform['capabilities'] = {
    history: true,
    send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 },
    conversations: { groups: true, channels: false, subchannels: false },
    poke: { maxCount: 10 },
  }
  readonly pokeCalls: Array<{ conversationId: string, userId: string, count: number }> = []

  async subscribe() { return () => {} }
  async getHistory() { return { messages: [] } }
  async sendMessage(): Promise<IMMessage> { throw new Error('unused') }
  async getDialogs(): Promise<IMDialogPage> {
    return { dialogs: [
      { conversation: { id: 'alice', kind: 'direct', title: 'Alice' }, unreadCount: 0 },
      { conversation: { id: 'group', kind: 'group', title: 'Test Group' }, unreadCount: 0 },
    ] }
  }
  async getContacts(): Promise<{ users: IMUser[] }> {
    return { users: [
      { id: 'me', firstName: 'Current' },
      { id: 'alice', firstName: 'Alice' },
    ] }
  }
  async getUser(_session: PlatformSession, id: string): Promise<IMUser | null> {
    return { id, firstName: id === 'me' ? 'Current' : id }
  }
  async sendPoke(
    _session: PlatformSession,
    conversation: { id: string },
    target: { userId: string },
    count: number,
  ): Promise<IMMessage | undefined> {
    this.pokeCalls.push({ conversationId: conversation.id, userId: target.userId, count })
    return { ...notice, conversationId: conversation.id }
  }
}

function decodeRequest(bytes: Uint8Array): tl.RpcMethod {
  return new TlBinaryReader(getServerReaderMap(), bytes).object() as tl.RpcMethod
}

function encodePeer(peer: tl.TypeInputPeer): Uint8Array {
  return TlBinaryWriter.serializeObject(__tlWriterMap, peer as unknown as tl.TlObject)
}

function encodeInputUser(user: tl.TypeInputUser): Uint8Array {
  return TlBinaryWriter.serializeObject(__tlWriterMap, user as unknown as tl.TlObject)
}

/**
 * Serialize an RPC result the way the server does, including the bare Bool
 * constructors that never reach the generated writer map.
 */
function roundTripResponse(result: tl.TlObject, layer: number): unknown {
  const kind = (result as { _: string })._
  if (kind === 'boolTrue' || kind === 'boolFalse') {
    const bool = TlBinaryWriter.manual(4)
    bool.uint(kind === 'boolTrue' ? 0x997275b5 : 0xbc799737)
    return new TlBinaryReader(__tlReaderMap, bool.result()).object()
  }
  const bytes = TlBinaryWriter.serializeObject(getApiLayerWriterMap(__tlWriterMap, layer), result)
  return new TlBinaryReader(__tlReaderMap, bytes).object()
}

describe('poke RPC wire contract', () => {
  it('answers a peer-scoped feature query with a client-readable dataJSON payload', async () => {
    const platform = new PokePlatform()
    const rpc = new DialogRpc(platform, session)
    await rpc.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })

    const peer = encodePeer({
      _: 'inputPeerUser', userId: rpc.peerTlId('alice'), accessHash: Long.ZERO,
    })
    const request = TlBinaryWriter.manual(8 + peer.length)
    request.uint(GET_FEATURES_CONSTRUCTOR)
    request.int(1)
    request.raw(peer)

    const decoded = decodeRequest(request.result())
    expect(decoded).toMatchObject({
      _: 'crossgram.getFeatures',
      peer: { _: 'inputPeerUser', userId: rpc.peerTlId('alice') },
    })

    const response = await rpc.getFeatures(
      decoded as unknown as Parameters<DialogRpc['getFeatures']>[0],
    )
    for (const layer of [228, 223, 180]) {
      const roundTripped = roundTripResponse(response, layer) as { _: string, data: string }
      expect(roundTripped._, layer).toBe('dataJSON')
      expect(JSON.parse(roundTripped.data), String(layer)).toEqual({ poke: { maxCount: 10 } })
    }
  })

  it('answers a poke with a bare bool and forwards the burst to the platform', async () => {
    const platform = new PokePlatform()
    const rpc = new DialogRpc(platform, session)
    await rpc.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })

    const peer = encodePeer({
      _: 'inputPeerChannel', channelId: rpc.peerTlId('group'), accessHash: Long.ONE,
    })
    const user = encodeInputUser({
      _: 'inputUser', userId: rpc.peerTlId('alice'), accessHash: Long.ZERO,
    })
    const request = TlBinaryWriter.manual(8 + peer.length + user.length + 4)
    request.uint(SEND_POKE_CONSTRUCTOR)
    request.raw(peer)
    request.raw(user)
    request.int(5)

    const decoded = decodeRequest(request.result())
    expect(decoded).toMatchObject({
      _: 'crossgram.sendPoke',
      peer: { _: 'inputPeerChannel', channelId: rpc.peerTlId('group') },
      userId: { _: 'inputUser', userId: rpc.peerTlId('alice') },
      count: 5,
    })

    const response = await rpc.sendPoke(
      decoded as unknown as Parameters<DialogRpc['sendPoke']>[0],
    )
    expect(platform.pokeCalls).toEqual([{ conversationId: 'group', userId: 'alice', count: 5 }])
    for (const layer of [228, 223, 180]) {
      // mtcute models the bare Bool constructor as a JavaScript boolean.
      expect(roundTripResponse(response, layer), String(layer)).toBe(true)
    }
  })
})
