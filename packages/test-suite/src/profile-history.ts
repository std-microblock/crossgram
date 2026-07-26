import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { TelegramClient, Long, MemoryStorage, type tl } from '@mtcute/node'
import { addPublicKey } from '@mtcute/core/utils.js'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import { generateLoginCode } from '../../bridge/src/login-code.js'
import {
  parseHistoryProfileOptions, percentile, stableSyntheticId, type HistoryProfileOptions,
} from './profile-history-utils.js'

interface AuthRow {
  id: string
  virtualPhone: string
  totpSecret: string
  platformId: string
  platformSessionId: string
}

interface ConversationRow {
  platformConversationId: string
  kind: string
  metadata: string | Record<string, unknown>
}

interface RsaKeyFile {
  publicKeyPem: string
}

interface StoredServerAuthKey {
  key: string
}

type ProfileInputPeer = tl.RawInputPeerChannel | tl.RawInputPeerChat | tl.RawInputPeerUser

function parseStoredMetadata(value: ConversationRow['metadata']): Record<string, unknown> {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string') return {}
  try {
    return JSON.parse(value || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

function inputPeer(specification: string): ProfileInputPeer {
  const match = /^(channel|chat|user):(\d+)$/.exec(specification)
  if (!match) throw new Error('--peer must be channel:<id>, chat:<id>, or user:<id>')
  const id = Number(match[2])
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('--peer id must be a positive safe integer')
  if (match[1] === 'channel') return { _: 'inputPeerChannel', channelId: id, accessHash: Long.ZERO }
  if (match[1] === 'chat') return { _: 'inputPeerChat', chatId: id }
  return { _: 'inputPeerUser', userId: id, accessHash: Long.ZERO }
}

function inputPeerFromPeer(peer: tl.TypePeer): ProfileInputPeer {
  if (peer._ === 'peerChannel') return { _: 'inputPeerChannel', channelId: peer.channelId, accessHash: Long.ZERO }
  if (peer._ === 'peerChat') return { _: 'inputPeerChat', chatId: peer.chatId }
  return { _: 'inputPeerUser', userId: peer.userId, accessHash: Long.ZERO }
}

function loadTarget(options: HistoryProfileOptions): {
  auth: AuthRow
  peer: ProfileInputPeer
  conversation?: string
} {
  const database = new DatabaseSync(options.database, { readOnly: true })
  try {
    const authRows = options.authId
      ? database.prepare('SELECT * FROM mtproto_auth_session WHERE id = ?').all(options.authId) as unknown as AuthRow[]
      : database.prepare('SELECT * FROM mtproto_auth_session ORDER BY id').all() as unknown as AuthRow[]
    if (authRows.length !== 1) {
      throw new Error(options.authId ? 'requested auth session was not found' : 'multiple auth sessions found; pass --auth-id')
    }
    const auth = authRows[0]!
    if (options.peer) return { auth, peer: inputPeer(options.peer) }
    const conversation = database.prepare(`
      SELECT platformConversationId, kind, metadata
      FROM mtproto_im_conversation
      WHERE platformSessionId = ? AND platformConversationId = ?
    `).get(auth.platformSessionId, options.conversation!) as unknown as ConversationRow | undefined
    if (!conversation) throw new Error('conversation was not found for the selected auth session')
    const id = stableSyntheticId(`peer:${conversation.platformConversationId}`)
    const metadata = parseStoredMetadata(conversation.metadata)
    const peer = metadata.virtual === true
      ? inputPeer(`chat:${id}`)
      : conversation.kind === 'direct'
        ? inputPeer(`user:${id}`)
        : inputPeer(`channel:${id}`)
    return { auth, peer, conversation: conversation.platformConversationId }
  } finally {
    database.close()
  }
}

function mediaKinds(result: tl.messages.TypeMessages): Record<string, number> {
  const counts: Record<string, number> = {}
  if (result._ === 'messages.messagesNotModified') return counts
  for (const message of result.messages) {
    const kind = message._ === 'message' ? message.media?._ ?? 'none' : message._
    counts[kind] = (counts[kind] ?? 0) + 1
  }
  return counts
}

export async function profileHistory(options: HistoryProfileOptions): Promise<void> {
  const target = loadTarget(options)
  const rsaKey = JSON.parse(readFileSync(options.rsaKey, 'utf8')) as RsaKeyFile
  if (!rsaKey.publicKeyPem) throw new Error(`RSA public key is missing from ${options.rsaKey}`)
  addPublicKey(new NodeCryptoProvider(), rsaKey.publicKeyPem, false)
  const storage = new MemoryStorage()
  if (options.serverAuthKeyId) {
    const stored = JSON.parse(readFileSync(options.authKeyStore, 'utf8')) as Record<string, StoredServerAuthKey>
    const authKey = stored[options.serverAuthKeyId]
    if (!authKey?.key || !/^[0-9a-f]{512}$/i.test(authKey.key)) {
      throw new Error('requested server auth key was not found or is malformed')
    }
    storage.authKeys.set(1, Buffer.from(authKey.key, 'hex'))
  }
  const dc = { id: 1, ipAddress: options.host, port: options.port }
  const client = new TelegramClient({
    apiId: 1,
    apiHash: 'mtproto-relay-history-profiler',
    storage,
    defaultDcs: { main: dc, media: dc },
    updates: false,
    logLevel: options.logLevel,
  })
  const request = {
    _: 'messages.getHistory' as const,
    peer: target.peer,
    offsetId: options.offsetId,
    offsetDate: options.offsetDate,
    addOffset: options.addOffset,
    limit: options.limit,
    maxId: options.maxId,
    minId: options.minId,
    hash: Long.ZERO,
  }
  try {
    const connectStarted = performance.now()
    if (options.serverAuthKeyId) {
      await client.connect()
    } else {
      await client.start({
        phone: `+${target.auth.virtualPhone}`,
        code: () => generateLoginCode(target.auth.totpSecret),
        codeSentCallback: () => {},
      })
    }
    // Keep the profiled request below mtcute's gzip threshold. The relay does
    // not currently unwrap gzip_packed requests, while a direct getHistory is
    // what Telegram Desktop sends after its connection is initialized.
    await client.call({ _: 'updates.getState' }, { abortSignal: AbortSignal.timeout(options.timeoutMs) })
    process.stdout.write(`${JSON.stringify({
      event: 'connected',
      connectMs: Math.round((performance.now() - connectStarted) * 100) / 100,
      endpoint: `${options.host}:${options.port}`,
      reusedAuthKey: !!options.serverAuthKeyId,
      conversation: target.conversation,
      peerType: target.peer._,
      peerId: target.peer._ === 'inputPeerChannel' ? target.peer.channelId
        : target.peer._ === 'inputPeerChat' ? target.peer.chatId : target.peer.userId,
      request: {
        offsetId: request.offsetId, offsetDate: request.offsetDate, addOffset: request.addOffset,
        limit: request.limit, maxId: request.maxId, minId: request.minId,
      },
    })}\n`)
    if (!options.serverAuthKeyId) {
      const seedStarted = performance.now()
      const peerId = target.peer._ === 'inputPeerChannel' ? target.peer.channelId
        : target.peer._ === 'inputPeerChat' ? target.peer.chatId : target.peer.userId
      let offsetPeer: tl.TypeInputPeer = { _: 'inputPeerEmpty' }
      let seeded = false
      let dialogCount = 0
      let pages = 0
      for (; pages < 100 && !seeded;) {
        pages++
        const dialogs = await client.call({
          _: 'messages.getDialogs', excludePinned: false, folderId: 0,
          offsetDate: 0, offsetId: 0, offsetPeer,
          limit: 100, hash: Long.ZERO,
        }, { abortSignal: AbortSignal.timeout(options.timeoutMs) })
        if (dialogs._ === 'messages.dialogsNotModified') break
        dialogCount += dialogs.dialogs.length
        seeded = [...dialogs.chats, ...dialogs.users].some(peer => peer.id === peerId)
        const last = dialogs.dialogs.at(-1)
        if (seeded || dialogs.dialogs.length < 100 || !last) break
        offsetPeer = inputPeerFromPeer(last.peer)
      }
      process.stdout.write(`${JSON.stringify({
        event: 'dialogs-seeded',
        durationMs: Math.round((performance.now() - seedStarted) * 100) / 100,
        seeded,
        pages,
        dialogs: dialogCount,
      })}\n`)
      if (!seeded) throw new Error('target peer was not returned while paging messages.getDialogs')
    }
    const samples: number[] = []
    for (let index = -options.warmup; index < options.repeat; index++) {
      const started = performance.now()
      const result = await client.call(request, { abortSignal: AbortSignal.timeout(options.timeoutMs) })
      const durationMs = performance.now() - started
      const warmup = index < 0
      const notModified = result._ === 'messages.messagesNotModified'
      if (!warmup) samples.push(durationMs)
      process.stdout.write(`${JSON.stringify({
        event: 'history', warmup, iteration: warmup ? index + options.warmup + 1 : index + 1,
        durationMs: Math.round(durationMs * 100) / 100,
        result: result._,
        count: 'count' in result ? result.count : notModified ? 0 : result.messages.length,
        messages: notModified ? 0 : result.messages.length,
        chats: notModified ? 0 : result.chats.length,
        users: notModified ? 0 : result.users.length,
        mediaKinds: mediaKinds(result),
      })}\n`)
    }
    process.stdout.write(`${JSON.stringify({
      event: 'summary', samples: samples.length,
      minMs: Math.round(Math.min(...samples) * 100) / 100,
      p50Ms: Math.round(percentile(samples, 0.5) * 100) / 100,
      p95Ms: Math.round(percentile(samples, 0.95) * 100) / 100,
      maxMs: Math.round(Math.max(...samples) * 100) / 100,
      averageMs: Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length * 100) / 100,
    })}\n`)
  } finally {
    await client.destroy()
  }
}

async function main(): Promise<void> {
  try {
    await profileHistory(parseHistoryProfileOptions(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main()
