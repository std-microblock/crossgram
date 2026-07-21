import type { tl } from '@mtcute/core'
import Long from 'long'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'

/**
 * 加载由 `telegram-tgs-assets` 抓取并生成的官方 Telegram 资源（reactions / 大 emoji /
 * 特效的 TGS 字节 + index.json 元数据），以「对官方 MTProto 响应做忠实回放」的方式对外提供：
 *
 * - `availableReactions()`    -> `messages.availableReactions`
 * - `stickerSet(kind)`        -> `messages.stickerSet`（AnimatedEmoji / Animations / Generic）
 * - `availableEffects()`      -> `messages.availableEffects`
 * - `getFile(docId)`          -> 按真实 doc id 从本地返回 TGS 字节
 *
 * 所有 Document 元数据都来自 Telegram 真实返回（id / access_hash / file_reference / dc_id /
 * mime / attributes / thumbs），客户端按 doc id 缓存、通过 `upload.getFile` 取字节，与我们无关。
 */

interface DocMeta {
  _: 'document'
  id: string
  accessHash: string
  fileReference: string // hex
  date: number
  mimeType: string
  size: number
  dcId: number
  attributes: unknown[]
  thumbs: unknown[]
  videoThumbs?: unknown[]
}

export interface AssetRef {
  file: string
  doc: DocMeta
}

interface ReactionEntry {
  emoji: string
  title: string
  slug: string
  premium: boolean
  inactive: boolean
  assets: Record<string, AssetRef>
}

interface EmojiEntry {
  emoji: string
  slug: string
  assets: AssetRef[]
}

interface EffectEntry {
  id: string
  emoticon: string
  slug: string
  premium_required: boolean
  assets: Record<string, AssetRef>
}

interface IndexFile {
  generated_at: string
  source: string
  feeds: Record<string, number>
  reactions: ReactionEntry[]
  emoji: EmojiEntry[]
  emoji_animations: EmojiEntry[]
  emoji_generic: EmojiEntry[]
  effects: EffectEntry[]
  counts: Record<string, number>
}

export type StickerKind = 'emoji' | 'emoji_animations' | 'emoji_generic'

function assetsOf(item: { assets: AssetRef[] | Record<string, AssetRef> }): AssetRef[] {
  return Array.isArray(item.assets) ? item.assets : Object.values(item.assets)
}

export class TelegramResources {
  private readonly _index: IndexFile
  private readonly _assetsBase: URL
  private readonly _idToFile = new Map<string, string>()
  private readonly _idToMeta = new Map<string, DocMeta>()

  constructor(assetsBase: URL = new URL('./assets/', import.meta.url)) {
    this._assetsBase = assetsBase
    const raw = readFileSync(new URL('index.json', assetsBase), 'utf-8')
    this._index = JSON.parse(raw) as IndexFile
    for (const cat of ['reactions', 'emoji', 'emoji_animations', 'emoji_generic', 'effects'] as const) {
      for (const item of this._index[cat]) {
        for (const a of assetsOf(item)) {
          this._idToFile.set(a.doc.id, a.file)
          this._idToMeta.set(a.doc.id, a.doc)
        }
      }
    }
  }

  private _toDoc(meta?: DocMeta): tl.RawDocument | undefined {
    if (!meta) return undefined
    return {
      _: 'document',
      id: Long.fromString(meta.id),
      accessHash: Long.fromString(meta.accessHash),
      fileReference: Buffer.from(meta.fileReference, 'hex'),
      date: meta.date,
      mimeType: meta.mimeType,
      size: meta.size,
      dcId: meta.dcId,
      attributes: meta.attributes as unknown as tl.TypeDocumentAttribute[],
      thumbs: meta.thumbs as unknown as tl.TypePhotoSize[],
      videoThumbs: (meta.videoThumbs ?? []) as unknown as tl.TypeVideoSize[],
    }
  }

  private _collectDocs(entries: { assets: AssetRef[] | Record<string, AssetRef> }[]): tl.RawDocument[] {
    const out: tl.RawDocument[] = []
    const seen = new Set<string>()
    for (const e of entries) {
      for (const a of assetsOf(e)) {
        if (seen.has(a.doc.id)) continue
        seen.add(a.doc.id)
        const d = this._toDoc(a.doc)
        if (d) out.push(d)
      }
    }
    return out
  }

  availableReactions(): tl.messages.RawAvailableReactions {
    return {
      _: 'messages.availableReactions',
      hash: this._index.feeds.reactions ?? 0,
      reactions: this._index.reactions.map((r) => ({
        _: 'availableReaction',
        flags: (r.inactive ? 1 : 0) | (r.premium ? 4 : 0),
        reaction: r.emoji,
        title: r.title,
        staticIcon: this._toDoc(r.assets.static_icon?.doc),
        appearAnimation: this._toDoc(r.assets.appear_animation?.doc),
        selectAnimation: this._toDoc(r.assets.select_animation?.doc),
        activateAnimation: this._toDoc(r.assets.activate_animation?.doc),
        effectAnimation: this._toDoc(r.assets.effect_animation?.doc),
        aroundAnimation: this._toDoc(r.assets.around_animation?.doc),
        centerIcon: this._toDoc(r.assets.center_icon?.doc),
      })),
    }
  }

  stickerSet(kind: StickerKind): tl.messages.RawStickerSet {
    const items = this._index[kind]
    const documents = this._collectDocs(items)
    const packs = items.map((it) => ({
      _: 'stickerPack' as const,
      emoticon: it.emoji,
      documents: it.assets.map((a) => Long.fromString(a.doc.id)),
    }))
    return {
      _: 'messages.stickerSet',
      set: this._makeSet(kind, documents.length),
      packs,
      keywords: [],
      documents,
    }
  }

  availableEffects(): tl.messages.RawAvailableEffects {
    const documents = this._collectDocs(this._index.effects)
    return {
      _: 'messages.availableEffects',
      hash: this._index.feeds.effects ?? 0,
      effects: this._index.effects.map((e) => {
        const hasStatic = !!e.assets.static_icon
        const hasAnim = !!e.assets.effect_animation
        return {
          _: 'availableEffect',
          flags: (hasStatic ? 1 : 0) | (hasAnim ? 2 : 0) | (e.premium_required ? 4 : 0),
          id: Long.fromString(e.id),
          emoticon: e.emoticon,
          staticIconId: e.assets.static_icon ? Long.fromString(e.assets.static_icon.doc.id) : undefined,
          effectStickerId: e.assets.effect_sticker ? Long.fromString(e.assets.effect_sticker.doc.id) : undefined,
          effectAnimationId: e.assets.effect_animation ? Long.fromString(e.assets.effect_animation.doc.id) : undefined,
        }
      }),
      documents,
    }
  }

  /** 按 doc id 取本地字节；返回 undefined 表示这不是官方资源（交给 bridge 其它逻辑处理）。 */
  getFile(docId: string | number | Long): { bytes: Uint8Array; mimeType: string } | undefined {
    const key = docId instanceof Long ? docId.toString() : String(docId)
    const file = this._idToFile.get(key)
    if (!file) return undefined
    const meta = this._idToMeta.get(key)
    const buf = readFileSync(new URL(file, this._assetsBase))
    return {
      bytes: new Uint8Array(buf),
      mimeType: meta?.mimeType ?? 'application/octet-stream',
    }
  }

  private _makeSet(kind: StickerKind, count: number): tl.RawStickerSet {
    let h = 0
    for (let i = 0; i < kind.length; i++) h = (Math.imul(h, 31) + kind.charCodeAt(i)) | 0
    const id = Long.fromNumber(h)
    return {
      _: 'stickerSet',
      id,
      accessHash: id,
      title: `Telegram ${kind}`,
      shortName: `tg_${kind}`,
      count,
      hash: this._index.feeds[kind] ?? 0,
      thumbs: [],
    }
  }
}

/** 惰性创建；资源缺失（未 fetch）时返回 undefined，bridge 退回到原有占位逻辑。 */
export function createTelegramResources(
  assetsBase?: URL,
): TelegramResources | undefined {
  try {
    return new TelegramResources(assetsBase)
  } catch {
    return undefined
  }
}
