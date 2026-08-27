import { randomBytes } from 'node:crypto'
import type { Context } from 'cordis'
import type { Database } from '@cordisjs/plugin-database'
import {
  sessionFromRow, type IMConversation, type IMMessage, type PlatformSession, type SystemPeer, type SystemPeerProvider,
  SystemPeerService,
} from '@mtproto-relay/bridge'
import { BotRegistry, BotUsernameTakenError, botConversationId, type BotIdentity, type BotOwner, validUsername } from './registry.js'

export const BOT_FATHER_CONVERSATION_ID = 'bridge:botfather'

export { botConversationId, validUsername }

export function registerBotFather(ctx: Context, registry: BotRegistry): void {
  const activeSessionIds = new Set(ctx.imPlatform.sessions.map(({ session }) => session.platformSessionId))
  ctx.systemPeer.register(new BotFatherProvider(ctx.database, registry))
  registry.onChanged(() => ctx.systemPeer.notifyChanged())
  void ctx.database.prepared().then(async () => {
    const rows = await ctx.database.get('mtproto_platform_session', { active: true })
    await Promise.all(rows.filter((row) => !activeSessionIds.has(row.id)).map((row) =>
      ctx.systemPeer.bootstrap(sessionFromRow(row)),
    ))
  }).catch((error) => ctx.logger('telegram-bot-api').warn('BotFather bootstrap recovery failed: %s', String(error)))
}

class BotFatherProvider implements SystemPeerProvider {
  private readonly _flows = new Map<string, { stage: 'name' | 'username', name?: string }>()

  constructor(
    private readonly _database: Database,
    private readonly _registry: BotRegistry,
  ) {}

  async bootstrap(session: PlatformSession, peers: SystemPeerService): Promise<void> {
    const [auth] = await this._database.get('mtproto_auth_session', {
      platformId: session.platformId, platformSessionId: session.platformSessionId,
    })
    const hydrated = { ...session, virtualPhone: auth?.virtualPhone }
    const father = botFatherPeer()
    await peers.emit(hydrated, { type: 'conversation', conversation: father.conversation })
    await peers.emit(hydrated, {
      type: 'message',
      conversation: father.conversation,
      message: systemMessage(father.conversation, 'bridge:botfather:welcome', 'Welcome to BotFather. Send /newbot to create a bot.'),
    })
    for (const bot of await this._registry.list(ownerFrom(hydrated))) {
      if (bot.enabled) await bootstrapBot(hydrated, bot, peers)
    }
  }

  async resolve(session: PlatformSession, conversationId: string): Promise<SystemPeer | undefined> {
    if (conversationId === BOT_FATHER_CONVERSATION_ID) return botFatherPeer()
    const bot = await this._registry.byConversation(session.platformSessionId, conversationId)
    return bot?.enabled ? botPeer(bot) : undefined
  }

  async listBots() {
    const father = botFatherPeer()
    const bots = await this._registry.listAll()
    return [{
      conversationId: father.id,
      title: father.conversation.title,
      username: String(father.conversation.metadata?.username),
      sourcePlugin: '@mtproto-relay/telegram-bot-api',
    }, ...bots.map((bot) => ({
      conversationId: bot.conversationId,
      title: bot.name,
      username: bot.username,
      sourcePlugin: '@mtproto-relay/telegram-bot-api',
    }))]
  }

  async receive(session: PlatformSession, peer: SystemPeer, message: IMMessage, peers: SystemPeerService): Promise<void> {
    if (peer.id !== BOT_FATHER_CONVERSATION_ID || message.outgoing !== true) return
    const text = plainText(message)
    if (text === undefined) return
    const owner = ownerFrom(session)
    if (text === '/cancel') {
      this._flows.delete(session.platformSessionId)
      await reply(session, peer.conversation, 'Cancelled.', peers)
      return
    }
    const flow = this._flows.get(session.platformSessionId)
    if (flow?.stage === 'name') {
      if (!text.trim()) return reply(session, peer.conversation, 'Please send a non-empty bot name.', peers)
      this._flows.set(session.platformSessionId, { stage: 'username', name: text.trim() })
      return reply(session, peer.conversation, 'Now send a username (5-32 letters, digits, or underscores).', peers)
    }
    if (flow?.stage === 'username') {
      if (!validUsername(text)) return reply(session, peer.conversation, 'That username is invalid. Try another one.', peers)
      try {
        const issued = await this._registry.create(owner, flow.name!, text)
        this._flows.delete(session.platformSessionId)
        await bootstrapBot(session, issued.bot, peers)
        await reply(session, peer.conversation, `Bot @${issued.bot.username} created. Use this token: ${issued.token}`, peers)
      } catch (error) {
        if (error instanceof BotUsernameTakenError) {
          return reply(session, peer.conversation, 'That username is already taken. Try another one.', peers)
        }
        throw error
      }
      return
    }
    if (text === '/newbot') {
      this._flows.set(session.platformSessionId, { stage: 'name' })
      return reply(session, peer.conversation, 'What should this bot be called?', peers)
    }
    if (text === '/mybots') {
      const bots = await this._registry.list(owner)
      return reply(session, peer.conversation, bots.length
        ? bots.map((bot) => `@${bot.username}${bot.enabled ? '' : ' (revoked)'}`).join('\n')
        : 'You do not have any bots yet.', peers)
    }
    const command = /^\/(token|revoke)\s+([^\s]+)$/u.exec(text)
    if (command?.[1] === 'token') {
      const issued = await this._registry.reset(owner, command[2])
      if (!issued) return reply(session, peer.conversation, 'Bot not found or unavailable.', peers)
      await reply(session, peer.conversation, `Token reset. Use this new token: ${issued.token}`, peers)
      return
    }
    if (command?.[1] === 'revoke') {
      const bot = await this._registry.revoke(owner, command[2])
      return reply(session, peer.conversation, bot ? `Bot @${bot.username} revoked.` : 'Bot not found or unavailable.', peers)
    }
    return reply(session, peer.conversation, 'Use /newbot, /mybots, /token <username>, /revoke <username>, or /cancel.', peers)
  }
}

function ownerFrom(session: PlatformSession): BotOwner {
  return { platformId: session.platformId, platformSessionId: session.platformSessionId, userId: session.userId }
}

function botFatherPeer(): SystemPeer {
  return {
    id: BOT_FATHER_CONVERSATION_ID,
    conversation: {
      id: BOT_FATHER_CONVERSATION_ID,
      kind: 'direct',
      title: 'BotFather',
      metadata: { bridgeOwned: true, localOnly: true, systemPeer: 'botfather', bot: true, username: 'BotFather' },
    },
  }
}

function botPeer(bot: BotIdentity): SystemPeer {
  return {
    id: bot.conversationId,
    conversation: {
      id: bot.conversationId,
      kind: 'direct',
      title: bot.name,
      metadata: { bridgeOwned: true, localOnly: true, systemPeer: 'bot', bot: true, botIdentityId: bot.id, username: bot.username },
    },
  }
}

async function bootstrapBot(session: PlatformSession, bot: BotIdentity, peers: SystemPeerService): Promise<void> {
  const peer = botPeer(bot)
  await peers.emit(session, { type: 'conversation', conversation: peer.conversation })
  await peers.emit(session, {
    type: 'message',
    conversation: peer.conversation,
    message: systemMessage(peer.conversation, `bridge:bot:${bot.id}:welcome`, `Welcome to @${bot.username}.`),
  })
}

async function reply(session: PlatformSession, conversation: IMConversation, text: string, peers: SystemPeerService): Promise<void> {
  await peers.emit(session, {
    type: 'message',
    conversation,
    message: systemMessage(conversation, `bridge:botfather:reply:${randomBytes(12).toString('hex')}`, text),
  })
}

function systemMessage(conversation: IMConversation, id: string, text: string): IMMessage {
  return {
    id,
    conversationId: conversation.id,
    senderId: conversation.id,
    sender: {
      id: conversation.id,
      firstName: conversation.title,
      username: typeof conversation.metadata?.username === 'string' ? conversation.metadata.username : undefined,
      metadata: conversation.metadata,
    },
    content: { parts: [{ type: 'text', text }] },
    timestamp: Math.floor(Date.now() / 1_000),
    outgoing: false,
  }
}

function plainText(message: IMMessage): string | undefined {
  if (!message.content.parts.length || message.content.parts.some((part) => part.type !== 'text' || part.entities?.length)) return
  return message.content.parts.map((part) => part.type === 'text' ? part.text : '').join('\n')
}
