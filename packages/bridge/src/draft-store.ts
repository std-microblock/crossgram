import type { Database } from '@cordisjs/plugin-database'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'

export interface StoredDraft {
  conversationId: string
  topMsgId: number
  draft: tl.RawDraftMessage
}

/** Durable, platform-independent storage for Telegram client drafts. */
export class DraftStore {
  constructor(private readonly _database: Database) {}

  async get(
    platformSessionId: string,
    conversationId: string,
    topMsgId = 0,
  ): Promise<StoredDraft | undefined> {
    const [row] = await this._database.get('mtproto_draft', {
      platformSessionId,
      platformConversationId: conversationId,
      topMsgId,
    })
    return row ? decodeRow(row) : undefined
  }

  async list(platformSessionId: string): Promise<StoredDraft[]> {
    const rows = await this._database.select('mtproto_draft', { platformSessionId })
      .orderBy('date', 'desc').execute()
    return rows.map(decodeRow)
  }

  async save(
    platformSessionId: string,
    conversationId: string,
    topMsgId: number,
    draft: tl.RawDraftMessage,
  ): Promise<void> {
    await this._database.withTransaction(async (database) => {
      const query = {
        platformSessionId,
        platformConversationId: conversationId,
        topMsgId,
      }
      await database.remove('mtproto_draft', query)
      await database.create('mtproto_draft', {
        ...query,
        payload: encodeDraft(draft),
        date: draft.date,
      })
    })
  }

  async remove(platformSessionId: string, conversationId: string, topMsgId = 0): Promise<void> {
    await this._database.remove('mtproto_draft', {
      platformSessionId,
      platformConversationId: conversationId,
      topMsgId,
    })
  }
}

function encodeDraft(draft: tl.RawDraftMessage): ArrayBuffer {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, draft)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function decodeRow(row: {
  platformConversationId: string
  topMsgId: number
  payload: ArrayBuffer
}): StoredDraft {
  const bytes = new Uint8Array(row.payload)
  const draft = new TlBinaryReader(__tlReaderMap, bytes).object() as tl.TlObject
  if (draft._ !== 'draftMessage') throw new Error(`invalid persisted draft constructor: ${draft._}`)
  return {
    conversationId: row.platformConversationId,
    topMsgId: row.topMsgId,
    draft,
  }
}
