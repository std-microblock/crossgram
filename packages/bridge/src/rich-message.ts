import Long from 'long'
import type { tl } from '@mtcute/core'
import type { IMMediaInput, IMMessageInputPart } from './platform.js'

/**
 * 将 Telegram 富文本消息（`inputRichMessage`、`inputRichMessageMarkdown`、`inputRichMessageHTML`）
 * 转换为按文章顺序排列的文本与媒体分段。
 */

export interface RichMediaReference {
  kind: 'photo' | 'document'
  id: Long
  input?: tl.TypeInputPhoto | tl.TypeInputDocument
  caption?: RichTextContent
}

export interface ResolvedRichMedia {
  media: IMMediaInput
  /** 保存草稿等需要落库文章结构时保留的原始对象。 */
  rawPhoto?: tl.RawPhoto
  rawDocument?: tl.RawDocument
}

export type RichMediaResolver = (
  reference: RichMediaReference,
) => Promise<ResolvedRichMedia | undefined>

export interface RichMessageConversion {
  parts: RichMessagePart[]
  /** 落库保留的块列表；媒体块仅在解析出原始对象时保留，确保与 `photos`/`documents` 一致。 */
  blocks: tl.TypePageBlock[]
  photos: tl.RawPhoto[]
  documents: tl.RawDocument[]
  text: string
}

export type RichMessagePart =
  | { type: 'text', text: string, entities: tl.TypeMessageEntity[] }
  | { type: 'media', media: IMMediaInput }

export interface RichTextContent {
  text: string
  entities: tl.TypeMessageEntity[]
}

interface DeclaredMedia {
  kind: 'photo' | 'document'
  input?: tl.TypeInputPhoto | tl.TypeInputDocument
  /** Markdown/HTML 请求中正文引用的文件 key。 */
  key?: string
}

/** 将富文本请求解析为可转发的消息内容；无有效内容时返回 `undefined`。 */
export async function convertRichMessage(
  input: tl.TypeInputRichMessage,
  resolve: RichMediaResolver,
): Promise<RichMessageConversion | undefined> {
  const declared = declaredRichMedia(input)
  const blocks = normalizeRichBlocks(input, declared)
  const parts: RichMessagePart[] = []
  const photos: tl.RawPhoto[] = []
  const documents: tl.RawDocument[] = []
  const keptBlocks: tl.TypePageBlock[] = []
  let pending: RichTextContent[] = []

  const flush = () => {
    if (!pending.length) return
    const merged = joinRichText(pending)
    pending = []
    if (!merged.text.trim()) return
    parts.push({ type: 'text', text: merged.text, entities: merged.entities })
  }

  for (const block of blocks) {
    const reference = mediaReference(block, declared)
    if (!reference) {
      const content = blockText(block)
      if (content?.text.trim()) pending.push(content)
      keptBlocks.push(block)
      continue
    }
    const resolved = await resolve(reference)
    if (!resolved) {
      // 草稿引用的上传文件可能已被清理；丢弃无法解析的媒体但保留图注文本。
      if (reference.caption?.text.trim()) pending.push(reference.caption)
      continue
    }
    flush()
    parts.push({ type: 'media', media: resolved.media })
    if (resolved.rawPhoto) {
      photos.push(resolved.rawPhoto)
      keptBlocks.push(copyMediaBlock(block, resolved.rawPhoto.id))
    } else if (resolved.rawDocument) {
      documents.push(resolved.rawDocument)
      keptBlocks.push(copyMediaBlock(block, resolved.rawDocument.id))
    } else {
      keptBlocks.push(block)
    }
    if (reference.caption?.text.trim()) pending.push(reference.caption)
  }
  flush()

  if (!parts.length) return
  return {
    parts,
    blocks: keptBlocks,
    photos,
    documents,
    text: parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n\n'),
  }
}

function declaredRichMedia(input: tl.TypeInputRichMessage): Map<string, DeclaredMedia> {
  const declared = new Map<string, DeclaredMedia>()
  if (input._ === 'inputRichMessage') {
    for (const photo of input.photos ?? []) {
      if (photo._ !== 'inputPhoto') continue
      declared.set(photo.id.toString(), { kind: 'photo', input: photo })
    }
    for (const document of input.documents ?? []) {
      if (document._ !== 'inputDocument') continue
      declared.set(document.id.toString(), { kind: 'document', input: document })
    }
    return declared
  }
  // Markdown/HTML 正文按字符串 key 引用文件，而 PageBlock 只能引用数字 ID；这里先分配负数占位 ID，解析出实际媒体后再替换。
  for (const [index, file] of (input.files ?? []).entries()) {
    declared.set(String(-(index + 1)), file._ === 'inputRichFilePhoto'
      ? { kind: 'photo', input: file.photo, key: file.id }
      : { kind: 'document', input: file.document, key: file.id })
  }
  return declared
}

function normalizeRichBlocks(
  input: tl.TypeInputRichMessage,
  declared: Map<string, DeclaredMedia>,
): tl.TypePageBlock[] {
  if (input._ === 'inputRichMessage') return input.blocks
  const placed = new Set<string>()
  const image = (target: string): tl.TypePageBlock | undefined => {
    const id = declaredImageId(declared, target)
    if (!id) return undefined
    placed.add(id)
    const media = declared.get(id)!
    return media.kind === 'photo'
      ? { _: 'pageBlockPhoto', photoId: Long.fromString(id), caption: emptyCaption() }
      : { _: 'pageBlockDocument', documentId: Long.fromString(id), caption: emptyCaption() }
  }
  const blocks = input._ === 'inputRichMessageMarkdown'
    ? markdownBlocks(input.markdown, image)
    : htmlBlocks(input.html, image)
  // 正文中未内联引用的附件统一追加在末尾，防止丢失。
  for (const [id, media] of declared) {
    if (placed.has(id)) continue
    blocks.push(media.kind === 'photo'
      ? { _: 'pageBlockPhoto', photoId: Long.fromString(id), caption: emptyCaption() }
      : { _: 'pageBlockDocument', documentId: Long.fromString(id), caption: emptyCaption() })
  }
  return blocks
}

function declaredImageId(declared: Map<string, DeclaredMedia>, target: string): string | undefined {
  const tail = /(?:^|[/?#&]|id=)([^/?#&]+)$/u.exec(target)?.[1]
  for (const [id, media] of declared) {
    const key = media.key ?? id
    if (key === target || (tail !== undefined && key === tail)) return id
  }
  return undefined
}

function emptyCaption(): tl.RawPageCaption {
  return { _: 'pageCaption', text: { _: 'textEmpty' }, credit: { _: 'textEmpty' } }
}

function mediaReference(
  block: tl.TypePageBlock,
  declared: Map<string, DeclaredMedia>,
): RichMediaReference | undefined {
  if (block._ === 'pageBlockPhoto') {
    const entry = declared.get(block.photoId.toString())
    return {
      kind: 'photo', id: block.photoId,
      ...(entry?.input ? { input: entry.input } : {}),
      caption: richTextContent(block.caption?.text),
    }
  }
  if (block._ === 'pageBlockVideo' || block._ === 'pageBlockAudio' || block._ === 'pageBlockDocument') {
    const id = block._ === 'pageBlockVideo' ? block.videoId
      : block._ === 'pageBlockAudio' ? block.audioId : block.documentId
    const entry = declared.get(id.toString())
    return {
      kind: 'document', id,
      ...(entry?.input ? { input: entry.input } : {}),
      caption: richTextContent(block.caption?.text),
    }
  }
  return undefined
}

function copyMediaBlock(block: tl.TypePageBlock, id: Long): tl.TypePageBlock {
  if (block._ === 'pageBlockPhoto') return { ...block, photoId: id }
  if (block._ === 'pageBlockVideo') return { ...block, videoId: id }
  if (block._ === 'pageBlockAudio') return { ...block, audioId: id }
  if (block._ === 'pageBlockDocument') return { ...block, documentId: id }
  return { _: 'pageBlockDocument', documentId: id, caption: emptyCaption() }
}

function joinRichText(paragraphs: readonly RichTextContent[]): RichTextContent {
  const text: string[] = []
  const entities: tl.TypeMessageEntity[] = []
  for (const paragraph of paragraphs) {
    if (text.length) {
      text.push('\n\n')
      shiftEntities(entities, 2)
    }
    const offset = text.join('').length
    text.push(paragraph.text)
    for (const entity of paragraph.entities) {
      entities.push({ ...entity, offset: entity.offset + offset } as tl.TypeMessageEntity)
    }
  }
  return { text: text.join(''), entities }
}

function shiftEntities(entities: tl.TypeMessageEntity[], delta: number): void {
  for (const entity of entities) entity.offset += delta
}

function blockText(block: tl.TypePageBlock): RichTextContent | undefined {
  switch (block._) {
    case 'pageBlockTitle':
    case 'pageBlockHeader':
    case 'pageBlockSubheader':
    case 'pageBlockKicker':
    case 'pageBlockHeading1':
    case 'pageBlockHeading2':
    case 'pageBlockHeading3':
    case 'pageBlockHeading4':
    case 'pageBlockHeading5':
    case 'pageBlockHeading6': {
      const content = richTextContent(block.text)
      return content ? boldRichText(content) : undefined
    }
    case 'pageBlockSubtitle':
      return richTextContent(block.text)
    case 'pageBlockParagraph':
      return richTextContent(block.text)
    case 'pageBlockThinking':
      return richTextContent(block.text)
    case 'pageBlockFooter':
      return richTextContent(block.text)
    case 'pageBlockAuthorDate': {
      const author = richTextContent(block.author)
      return author
    }
    case 'pageBlockPreformatted':
      return richTextContent(block.text)
    case 'pageBlockTable':
      // Platforms have no table either, so the rows are sent as the text a
      // person reads: one line per row, cells separated by a pipe.
      return { text: block.rows.map((row) => row.cells
        .map((cell) => cell.text ? richTextContent(cell.text)?.text ?? '' : '')
        .join(' | ')).join('\n'), entities: [] }
    case 'pageBlockMath':
      return { text: block.source, entities: [] }
    case 'pageBlockBlockquote':
    case 'pageBlockPullquote':
      return joinRichText([richTextContent(block.text), richTextContent(block.caption)].filter(
        (item): item is RichTextContent => Boolean(item?.text.trim()),
      ))
    case 'pageBlockBlockquoteBlocks':
    case 'pageBlockDetails': {
      const head = block._ === 'pageBlockDetails' ? richTextContent(block.title) : undefined
      return joinRichText([
        ...(head ? [head] : []),
        ...block.blocks.map((item) => blockText(item)).filter((item): item is RichTextContent => Boolean(item)),
      ])
    }
    case 'pageBlockList':
      return { text: block.items.map((item) => listItemText(item)).join('\n'), entities: [] }
    case 'pageBlockOrderedList':
      return {
        text: block.items.map((item, index) => `${
          item._ === 'pageListOrderedItemText' && item.num ? `${item.num}.` : `${index + 1}.`
        } ${listItemText(item)}`).join('\n'),
        entities: [],
      }
    case 'pageBlockTable':
      return {
        text: block.rows.map((row) => row.cells
          .map((cell) => cell.text ? richTextContent(cell.text)?.text ?? '' : '')
          .join(' | ')).join('\n'),
        entities: [],
      }
    case 'pageBlockRelatedArticles':
      return {
        text: block.articles.map((article) => article.url).filter(Boolean).join('\n'),
        entities: [],
      }
    case 'pageBlockCover':
      return blockText(block.cover)
    case 'pageBlockCollage':
    case 'pageBlockSlideshow':
      return joinRichText([
        ...block.items.map((item) => blockText(item)).filter((item): item is RichTextContent => Boolean(item)),
        ...(richTextContent(block.caption?.text)?.text.trim() ? [richTextContent(block.caption.text)!] : []),
      ])
    case 'pageBlockEmbedPost':
      return joinRichText([
        { text: block.author, entities: [] },
        ...block.blocks.map((item) => blockText(item)).filter((item): item is RichTextContent => Boolean(item)),
      ])
    case 'pageBlockEmbed': {
      const caption = richTextContent(block.caption?.text)
      if (caption?.text.trim()) return caption
      return block.url ? { text: block.url, entities: [] } : undefined
    }
    default:
      return undefined
  }
}

function listItemText(item: tl.TypePageListItem | tl.TypePageListOrderedItem): string {
  if (item._ === 'pageListItemText' || item._ === 'pageListOrderedItemText') {
    return richTextContent(item.text)?.text ?? ''
  }
  return item.blocks.map((block) => blockText(block)?.text ?? '').filter(Boolean).join(' ')
}

function boldRichText(content: RichTextContent): RichTextContent {
  if (!content.text.length) return content
  const longest = content.entities.find((entity) => entity.offset === 0 && entity.length === content.text.length)
  if (longest) return content
  return {
    text: content.text,
    entities: [...content.entities, { _: 'messageEntityBold', offset: 0, length: content.text.length }],
  }
}

export function richTextContent(input: tl.TypeRichText | undefined): RichTextContent | undefined {
  if (!input) return undefined
  const state: { text: string, entities: tl.TypeMessageEntity[], pre?: string } = { text: '', entities: [] }
  walkRichText(input, state, {})
  return { text: state.text, entities: state.entities }
}

interface RichTextFormat {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  code?: boolean
  pre?: string
  url?: string
}

function walkRichText(
  input: tl.TypeRichText,
  state: { text: string, entities: tl.TypeMessageEntity[] },
  format: RichTextFormat,
): void {
  const node = input as unknown as Record<string, unknown> & { _: string }
  const offset = state.text.length
  const decorate = () => {
    const length = state.text.length - offset
    if (!length) return
    const push = (entity: tl.TypeMessageEntity) => state.entities.push(entity)
    if (format.pre !== undefined) {
      push({ _: 'messageEntityPre', offset, length, language: format.pre })
      return
    }
    if (format.url) push({ _: 'messageEntityTextUrl', offset, length, url: format.url })
    if (format.code) push({ _: 'messageEntityCode', offset, length })
    if (format.bold) push({ _: 'messageEntityBold', offset, length })
    if (format.italic) push({ _: 'messageEntityItalic', offset, length })
    if (format.underline) push({ _: 'messageEntityUnderline', offset, length })
    if (format.strike) push({ _: 'messageEntityStrike', offset, length })
  }

  switch (node._) {
    case 'textEmpty':
      return
    case 'textPlain':
      state.text += String(node.text ?? '')
      break
    case 'textBold':
      walkChild(node, state, { ...format, bold: true })
      break
    case 'textItalic':
      walkChild(node, state, { ...format, italic: true })
      break
    case 'textUnderline':
      walkChild(node, state, { ...format, underline: true })
      break
    case 'textStrike':
      walkChild(node, state, { ...format, strike: true })
      break
    case 'textFixed':
      walkChild(node, state, { ...format, code: true })
      break
    case 'textUrl':
      walkChild(node, state, { ...format, url: String(node.url ?? '') })
      break
    case 'textMentionName': {
      const start = state.text.length
      walkChild(node, state, format)
      const text = state.text.slice(start)
      const userId = Number(node.userId)
      if (text.length && Number.isFinite(userId)) {
        state.entities.push({ _: 'messageEntityMentionName', offset: start, length: text.length, userId })
      }
      break
    }
    case 'textCustomEmoji': {
      const alt = String(node.alt ?? '')
      state.text += alt
      const documentId = node.documentId as Long | undefined
      if (documentId && alt.length) {
        state.entities.push({
          _: 'messageEntityCustomEmoji', offset, length: alt.length, documentId,
        })
      }
      break
    }
    case 'textConcat': {
      for (const child of (node.texts as tl.TypeRichText[] | undefined) ?? []) {
        walkRichText(child, state, format)
      }
      break
    }
    case 'textMath': {
      const source = String(node.source ?? '')
      state.text += source ? `$${source}$` : ''
      break
    }
    default: {
      // 其余构造器（邮箱、电话、话题标签、锚点、剧透、上下标等）仅提取纯文本，丢弃外层样式。
      if (typeof node.text === 'string') {
        state.text += node.text
        break
      }
      if (node.text && typeof node.text === 'object') {
        walkRichText(node.text as tl.TypeRichText, state, format)
        break
      }
      if (node.source !== undefined) state.text += String(node.source)
      break
    }
  }
  decorate()
}

function walkChild(
  node: Record<string, unknown>,
  state: { text: string, entities: tl.TypeMessageEntity[] },
  format: RichTextFormat,
): void {
  const child = node.text
  if (!child || typeof child !== 'object') return
  walkRichText(child as tl.TypeRichText, state, format)
}

function richTextToTl(content: RichTextContent): tl.TypeRichText {
  if (!content.entities.length) return { _: 'textPlain', text: content.text }
  const boundaries = [
    0, content.text.length,
    ...content.entities.flatMap((entity) => [entity.offset, entity.offset + entity.length]),
  ]
  const unique = [...new Set(boundaries)].filter((value) => value >= 0 && value <= content.text.length)
    .sort((left, right) => left - right)
  const segments: tl.TypeRichText[] = []
  for (let index = 0; index + 1 < unique.length; index++) {
    const start = unique[index]!
    const end = unique[index + 1]!
    if (start === end) continue
    let segment: tl.TypeRichText = { _: 'textPlain', text: content.text.slice(start, end) }
    for (const entity of content.entities.filter((item) => item.offset <= start && item.offset + item.length >= end)) {
      segment = wrapRichText(segment, entity)
    }
    segments.push(segment)
  }
  return segments.length === 1 ? segments[0]! : { _: 'textConcat', texts: segments }
}

function wrapRichText(text: tl.TypeRichText, entity: tl.TypeMessageEntity): tl.TypeRichText {
  switch (entity._) {
    case 'messageEntityBold': return { _: 'textBold', text }
    case 'messageEntityItalic': return { _: 'textItalic', text }
    case 'messageEntityUnderline': return { _: 'textUnderline', text }
    case 'messageEntityStrike': return { _: 'textStrike', text }
    case 'messageEntityCode': return { _: 'textFixed', text }
    case 'messageEntityPre': return { _: 'textFixed', text }
    case 'messageEntityTextUrl': return { _: 'textUrl', text, url: entity.url, webpageId: Long.ZERO }
    case 'messageEntityUrl': return { _: 'textUrl', text, url: text._ === 'textPlain' ? text.text : '', webpageId: Long.ZERO }
    case 'messageEntityMentionName': return { _: 'textMentionName', text, userId: entity.userId }
    case 'messageEntityCustomEmoji': return {
      _: 'textCustomEmoji',
      documentId: entity.documentId,
      alt: text._ === 'textPlain' ? text.text : '',
    }
    default: return text
  }
}

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu
const MARKDOWN_IMAGE_DIMENSIONS = /(?:^|\s)#(\d+)px\s+#(\d+)px\s*$/u
const MAX_MARKDOWN_IMAGE_SIDE = 16_384

export interface MarkdownImageDimensions {
  width: number
  height: number
}

export interface MarkdownRichMessageOptions {
  resolveImage?: (
    target: string,
    alt: string,
    dimensions?: MarkdownImageDimensions,
  ) => tl.RawPhoto | undefined
}

function parseMarkdownImageDimensions(alt: string): MarkdownImageDimensions | undefined {
  const match = MARKDOWN_IMAGE_DIMENSIONS.exec(alt)
  if (!match) return undefined
  const width = Number.parseInt(match[1]!, 10)
  const height = Number.parseInt(match[2]!, 10)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width <= 0 || height <= 0
    || width > MAX_MARKDOWN_IMAGE_SIDE || height > MAX_MARKDOWN_IMAGE_SIDE) {
    return undefined
  }
  return { width, height }
}

function markdownTableRow(line: string): string[] | undefined {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return undefined
  const cells = trimmed.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim())
  return cells.length > 1 ? cells : undefined
}

/** 解析从 `start` 行开始的 Markdown 表格（表头 + `--- | ---` 对齐分隔行 + 数据行） */
function markdownTable(
  lines: readonly string[],
  start: number,
): { block: tl.RawPageBlockTable, end: number } | undefined {
  const header = markdownTableRow(lines[start] ?? '')
  const delimiter = markdownTableRow(lines[start + 1] ?? '')
  if (!header || !delimiter || header.length !== delimiter.length) return undefined
  if (!delimiter.every((cell) => /^:?-+:?$/.test(cell))) return undefined
  const rows: string[][] = [header]
  let end = start + 2
  while (end < lines.length) {
    const row = markdownTableRow(lines[end] ?? '')
    if (!row) break
    rows.push(row)
    end += 1
  }
  return {
    block: {
      _: 'pageBlockTable',
      bordered: true,
      striped: true,
      title: { _: 'textEmpty' },
      rows: rows.map((row, rowIndex) => ({
        _: 'pageTableRow' as const,
        cells: Array.from({ length: delimiter.length }, (_cell, column) => {
          const alignment = delimiter[column]!
          return {
            _: 'pageTableCell' as const,
            header: rowIndex === 0 || undefined,
            alignCenter: alignment.startsWith(':') && alignment.endsWith(':') || undefined,
            alignRight: !alignment.startsWith(':') && alignment.endsWith(':') || undefined,
            text: markdownRichText(row[column] ?? ''),
          }
        }),
      })),
    },
    end,
  }
}

/** 将 Markdown 正文转换为 Telegram `richMessage`（解析失败时返回 `undefined` 以回退到普通带实体文本） */
export function markdownRichMessage(
  markdown: string,
  options?: MarkdownRichMessageOptions,
): tl.RawRichMessage | undefined {
  try {
    const photos: tl.RawPhoto[] = []
    const seenPhotos = new Set<string>()
    const resolveImage = options?.resolveImage
    const blocks = markdownBlocks(markdown, resolveImage
      ? (target, alt) => {
          const photo = resolveImage(target, alt, parseMarkdownImageDimensions(alt))
          if (!photo) return undefined
          const key = photo.id.toString()
          if (!seenPhotos.has(key)) {
            seenPhotos.add(key)
            photos.push(photo)
          }
          return { _: 'pageBlockPhoto', photoId: photo.id, caption: emptyCaption() }
        }
      : undefined)
    return blocks.length ? { _: 'richMessage', blocks, photos, documents: [] } : undefined
  } catch {
    return undefined
  }
}

/** 将 Markdown 正文解析为 PageBlock 列表；`image` 回调可将内联图片引用替换为对应的媒体块。 */
export function markdownBlocks(
  markdown: string,
  image?: (target: string, alt: string) => tl.TypePageBlock | undefined,
): tl.TypePageBlock[] {
  const blocks: tl.TypePageBlock[] = []
  let paragraph = ''
  let code: { language: string, lines: string[] } | undefined
  let quote: string[] = []

  const flushParagraph = () => {
    const text = paragraph.trim()
    paragraph = ''
    if (text) blocks.push({ _: 'pageBlockParagraph', text: markdownRichText(text) })
  }
  const flushQuote = () => {
    if (!quote.length) return
    const text = quote.join('\n').trim()
    quote = []
    if (text) blocks.push({ _: 'pageBlockBlockquote', text: markdownRichText(text), caption: { _: 'textEmpty' } })
  }
  const appendLine = (line: string) => {
    const pieces = line.split(MARKDOWN_IMAGE)
    for (let index = 0; index < pieces.length; index += 3) {
      paragraph += pieces[index] ?? ''
      const alt = pieces[index + 1]
      if (alt === undefined) break
      const target = pieces[index + 2]!
      const block = image?.(target, alt)
      if (!block) {
        paragraph += alt || target
        continue
      }
      flushParagraph()
      blocks.push(block)
    }
  }

  const lines = markdown.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (code) {
      if (line.trimStart().startsWith('```')) {
        blocks.push({
          _: 'pageBlockPreformatted', language: code.language,
          text: { _: 'textPlain', text: code.lines.join('\n') },
        })
        code = undefined
      } else {
        code.lines.push(line)
      }
      continue
    }
    const fence = /^\s*```(\S*)\s*$/u.exec(line)
    if (fence) {
      flushParagraph()
      flushQuote()
      code = { language: fence[1] ?? '', lines: [] }
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      flushQuote()
      continue
    }
    const table = markdownTable(lines, index)
    if (table) {
      flushParagraph()
      flushQuote()
      blocks.push(table.block)
      index = table.end - 1
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (heading) {
      flushParagraph()
      flushQuote()
      const level = heading[1]!.length
      blocks.push({
        _: `pageBlockHeading${level}` as 'pageBlockHeading1',
        text: markdownRichText(heading[2]!.trim()),
      })
      continue
    }
    const quoted = /^\s*>\s?(.*)$/u.exec(line)
    if (quoted) {
      flushParagraph()
      quote.push(quoted[1]!)
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*)$/u.exec(line)
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/u.exec(line)
    if (bullet || ordered) {
      flushParagraph()
      flushQuote()
      const item = markdownRichText((bullet?.[1] ?? ordered?.[2] ?? '').trim())
      const list = blocks.at(-1)
      if (list?._ === 'pageBlockList' && bullet) list.items.push({ _: 'pageListItemText', text: item })
      else if (list?._ === 'pageBlockOrderedList' && ordered) {
        list.items.push({ _: 'pageListOrderedItemText', text: item, num: ordered[1]! })
      } else if (bullet) blocks.push({ _: 'pageBlockList', items: [{ _: 'pageListItemText', text: item }] })
      else {
        blocks.push({
          _: 'pageBlockOrderedList', items: [{ _: 'pageListOrderedItemText', text: item, num: ordered![1]! }],
        })
      }
      continue
    }
    if (paragraph) paragraph += '\n'
    appendLine(line)
  }
  if (code) {
    blocks.push({
      _: 'pageBlockPreformatted', language: code.language,
      text: { _: 'textPlain', text: code.lines.join('\n') },
    })
  }
  flushParagraph()
  flushQuote()
  return blocks
}

function markdownRichText(text: string): tl.TypeRichText {
  const content = parseInlineMarkdown(text)
  return richTextToTl(content)
}

const INLINE_MARKDOWN: Array<{ pattern: RegExp, type: tl.TypeMessageEntity['_'] }> = [
  { pattern: /\*\*([^*]+)\*\*/gu, type: 'messageEntityBold' },
  { pattern: /~~([^~]+)~~/gu, type: 'messageEntityStrike' },
  { pattern: /__([^_]+)__/gu, type: 'messageEntityItalic' },
  { pattern: /`([^`]+)`/gu, type: 'messageEntityCode' },
]

export function parseInlineMarkdown(text: string): RichTextContent {
  let content: RichTextContent = { text, entities: [] }
  for (const rule of INLINE_MARKDOWN) {
    while (true) {
      rule.pattern.lastIndex = 0
      const match = rule.pattern.exec(content.text)
      if (!match) break
      content = wrapInlineRange(content, match.index, match[0].length, match[1]!, rule.type)
    }
  }
  const link = /\[([^\]]+)\]\(([^)\s]+)\)/u.exec(content.text)
  if (link) {
    content = wrapInlineRange(
      content, link.index, link[0].length, link[1]!, 'messageEntityTextUrl', link[2]!,
    )
  }
  return content
}

function wrapInlineRange(
  content: RichTextContent,
  offset: number,
  fullLength: number,
  inner: string,
  type: tl.TypeMessageEntity['_'],
  url?: string,
): RichTextContent {
  const text = `${content.text.slice(0, offset)}${inner}${content.text.slice(offset + fullLength)}`
  const delta = inner.length - fullLength
  const entities = content.entities.flatMap((entity) => {
    if (entity.offset + entity.length <= offset) return [entity]
    if (entity.offset >= offset + fullLength) {
      return [{ ...entity, offset: entity.offset + delta } as tl.TypeMessageEntity]
    }
    // 跨越标记边界的实体无法安全重算偏移，直接丢弃。
    return []
  })
  const added = url
    ? { _: type, offset, length: inner.length, url } as tl.TypeMessageEntity
    : { _: type, offset, length: inner.length } as tl.TypeMessageEntity
  return { text, entities: [...entities, added] }
}

/** 将 HTML 正文解析为 PageBlock 列表（仅保留段落、标题、列表、代码块等块级结构）。 */
export function htmlBlocks(
  html: string,
  image?: (target: string) => tl.TypePageBlock | undefined,
): tl.TypePageBlock[] {
  const blocks: tl.TypePageBlock[] = []
  const tokens = html.split(/(<[^>]*>)/u)
  let paragraph = ''
  let code: string[] | undefined
  let heading: number | undefined

  const flush = () => {
    const text = paragraph.replace(/\s+/gu, ' ').trim()
    paragraph = ''
    if (!text) {
      heading = undefined
      return
    }
    blocks.push(heading
      ? { _: `pageBlockHeading${heading}` as 'pageBlockHeading1', text: { _: 'textPlain', text } }
      : { _: 'pageBlockParagraph', text: { _: 'textPlain', text } })
    heading = undefined
  }
  const flushCode = () => {
    blocks.push({
      _: 'pageBlockPreformatted', language: '',
      text: { _: 'textPlain', text: (code ?? []).join('').replace(/^\s+|\s+$/gu, '') },
    })
    code = undefined
  }

  for (const token of tokens) {
    if (!token.startsWith('<')) {
      const text = decodeHtmlEntities(token)
      if (code) code.push(text)
      else paragraph += text
      continue
    }
    const tag = /^<(\/?)\s*([a-zA-Z0-9]+)/u.exec(token)
    if (!tag) continue
    const closing = tag[1] === '/'
    const name = tag[2]!.toLowerCase()
    if (name === 'pre') {
      if (closing) flushCode()
      else {
        flush()
        code = []
      }
      continue
    }
    if (code) {
      if (name === 'br') code.push('\n')
      continue
    }
    if (name === 'img') {
      const target = /\bsrc\s*=\s*["']?([^"'\s>]+)/iu.exec(token)?.[1]
      const block = target ? image?.(target) : undefined
      if (block) {
        flush()
        blocks.push(block)
      }
      continue
    }
    const headingLevel = /^h([1-6])$/u.exec(name)
    if (headingLevel) {
      if (closing) flush()
      else {
        flush()
        heading = Number(headingLevel[1])
      }
      continue
    }
    if (name === 'br' || name === 'p' || name === 'div' || name === 'li' || name === 'blockquote') {
      flush()
      continue
    }
  }
  if (code) flushCode()
  flush()
  return blocks
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
}
