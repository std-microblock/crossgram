import type { IMMessage, IMProjectableMessage, IMTextEntity } from './platform.js'

type TextPart = Extract<IMProjectableMessage['content']['parts'][number], { type: 'text' }>

/**
 * Older relay builds marked every text part of a recalled message with one
 * full-span strike entity. Suppress only that synthetic shape so partial,
 * upstream-authored strikethrough formatting remains intact.
 */
export function isLegacyRecallStrikethrough(
  source: IMProjectableMessage,
  part: TextPart,
  entity: IMTextEntity,
): boolean {
  return source.recalled === true
    && entity.type === 'strikethrough'
    && entity.offset === 0
    && entity.length === part.text.length
}

/** Mark a QQ tombstone as recalled without adding, and while cleaning, the legacy strike marker. */
export function markMessageRecalled(source: IMMessage): IMMessage {
  let changed = source.recalled !== true
  const recalledSource = source.recalled === true ? source : { ...source, recalled: true }
  const parts = source.content.parts.map((part) => {
    if (part.type !== 'text' || !part.entities?.length) return part
    const entities = part.entities.filter((entity) =>
      !isLegacyRecallStrikethrough(recalledSource, part, entity))
    if (entities.length === part.entities.length) return part
    changed = true
    if (entities.length) return { ...part, entities }
    const { entities: _entities, ...plain } = part
    return plain
  })
  return changed ? { ...source, recalled: true, content: { ...source.content, parts } } : source
}
