import type { tl } from '@mtcute/core'
import type { TelegramResourceProvider } from '@mtproto-relay/bridge'
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

function requireAsset(assets: Record<string, AssetRef>, name: string): AssetRef {
  const asset = assets[name]
  if (!asset) throw new Error(`Telegram resource index is missing required asset: ${name}`)
  return asset
}

export class TelegramResources implements TelegramResourceProvider {
  private readonly _index: IndexFile
  private readonly _assetsBase: URL
  private readonly _idToFile = new Map<string, string>()
  private readonly _idToMeta = new Map<string, DocMeta>()

  constructor(assetsBase: URL = new URL('../assets/', import.meta.url)) {
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

  private _toDoc(meta: DocMeta): tl.RawDocument
  private _toDoc(meta: DocMeta | undefined): tl.RawDocument | undefined
  private _toDoc(meta: DocMeta | undefined): tl.RawDocument | undefined {
    if (!meta) return
    return {
      _: 'document',
      id: Long.fromString(meta.id),
      accessHash: Long.fromString(meta.accessHash),
      fileReference: Buffer.from(meta.fileReference, 'hex'),
      date: meta.date,
      mimeType: meta.mimeType,
      size: meta.size,
      dcId: meta.dcId,
      attributes: meta.attributes.map(reviveTlValue) as tl.TypeDocumentAttribute[],
      thumbs: meta.thumbs.length
        ? meta.thumbs.map(reviveTlValue) as tl.TypePhotoSize[]
        : undefined,
      videoThumbs: meta.videoThumbs?.length
        ? meta.videoThumbs.map(reviveTlValue) as tl.TypeVideoSize[]
        : undefined,
    }
  }

  private _collectDocs(entries: { assets: AssetRef[] | Record<string, AssetRef> }[]): tl.RawDocument[] {
    const out: tl.RawDocument[] = []
    const seen = new Set<string>()
    for (const e of entries) {
      for (const a of assetsOf(e)) {
        if (seen.has(a.doc.id)) continue
        seen.add(a.doc.id)
        out.push(this._toDoc(a.doc))
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
        inactive: r.inactive || undefined,
        premium: r.premium || undefined,
        reaction: r.emoji,
        title: r.title,
        staticIcon: this._toDoc(requireAsset(r.assets, 'static_icon').doc),
        appearAnimation: this._toDoc(requireAsset(r.assets, 'appear_animation').doc),
        selectAnimation: this._toDoc(requireAsset(r.assets, 'select_animation').doc),
        activateAnimation: this._toDoc(requireAsset(r.assets, 'activate_animation').doc),
        effectAnimation: this._toDoc(requireAsset(r.assets, 'effect_animation').doc),
        aroundAnimation: this._toDoc(r.assets.around_animation?.doc),
        centerIcon: this._toDoc(r.assets.center_icon?.doc),
      })),
    }
  }

  getAvailableReactions(): tl.messages.RawAvailableReactions {
    return this.availableReactions()
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

  getStickerSet(kind: StickerKind): tl.messages.RawStickerSet {
    return this.stickerSet(kind)
  }

  availableEffects(): tl.messages.RawAvailableEffects {
    const documents = this._collectDocs(this._index.effects)
    return {
      _: 'messages.availableEffects',
      hash: this._index.feeds.effects ?? 0,
      effects: this._index.effects.map((e) => ({
        _: 'availableEffect',
        premiumRequired: e.premium_required || undefined,
        id: Long.fromString(e.id),
        emoticon: e.emoticon,
        staticIconId: e.assets.static_icon
          ? Long.fromString(e.assets.static_icon.doc.id)
          : undefined,
        effectStickerId: Long.fromString(requireAsset(e.assets, 'effect_sticker').doc.id),
        effectAnimationId: e.assets.effect_animation
          ? Long.fromString(e.assets.effect_animation.doc.id)
          : undefined,
      })),
      documents,
    }
  }

  getAvailableEffects(): tl.messages.RawAvailableEffects {
    return this.availableEffects()
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

function reviveTlValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveTlValue)
  if (!value || typeof value !== 'object') return value

  const input = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(input)) {
    if (key === 'bytes' && typeof nested === 'string') {
      output[key] = Buffer.from(nested, 'hex')
    } else if (
      (key === 'id' || key === 'accessHash' || key === 'documentId')
      && (typeof nested === 'string' || typeof nested === 'number')
    ) {
      output[key] = Long.fromString(String(nested))
    } else {
      output[key] = reviveTlValue(nested)
    }
  }
  return output
}

/** 直接创建资源 provider；通常应通过本包的 Cordis 插件完成注册。 */
export function createTelegramResources(assetsBase?: URL): TelegramResources {
  return new TelegramResources(assetsBase)
}
