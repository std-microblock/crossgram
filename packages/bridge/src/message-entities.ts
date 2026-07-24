import type { tl } from '@mtcute/core'

const LINK_CANDIDATE = /(?:\b(?:https?|ftp|tg):\/\/[^\s<>"'，。！？；：、（）【】《》“”‘’]+|\bwww\.[^\s<>"'，。！？；：、（）【】《》“”‘’]+|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}]{2,63}(?::\d{1,5})?(?:[/?#][^\s<>"'，。！？；：、（）【】《》“”‘’]*)?)/giu
const TRAILING_PUNCTUATION = /[.,!?;:，。！？；：、…]/u

interface EntityRange {
  offset: number
  length: number
}

/**
 * Adds Telegram URL entities for links which are plain text at the platform
 * boundary. Offsets and lengths deliberately use JavaScript string indexes,
 * which are UTF-16 code units just like Telegram's MessageEntity fields.
 */
export function withAutoLinkEntities(
  text: string,
  entities?: readonly tl.TypeMessageEntity[],
): tl.TypeMessageEntity[] | undefined {
  const output = entities ? [...entities] : []
  const occupied: EntityRange[] = output.filter(validRange)

  LINK_CANDIDATE.lastIndex = 0
  for (const match of text.matchAll(LINK_CANDIDATE)) {
    const offset = match.index
    const candidate = trimLinkEnd(match[0])
    if (!candidate || !validLink(candidate)) continue
    if (isEmailDomainFragment(text, offset, candidate)) continue

    const range = { offset, length: candidate.length }
    if (occupied.some((entity) => overlaps(range, entity))) continue
    output.push({ _: 'messageEntityUrl', ...range })
    occupied.push(range)
  }

  output.sort((left, right) => left.offset - right.offset || right.length - left.length)
  return output.length ? output : undefined
}

function trimLinkEnd(candidate: string): string {
  let end = candidate.length
  while (end > 0) {
    const last = candidate[end - 1]
    if (TRAILING_PUNCTUATION.test(last)) {
      end--
      continue
    }
    const opening = last === ')' ? '(' : last === ']' ? '[' : last === '}' ? '{' : undefined
    if (opening && count(candidate, last, end) > count(candidate, opening, end)) {
      end--
      continue
    }
    break
  }
  return candidate.slice(0, end)
}

function count(value: string, character: string, end: number): number {
  let result = 0
  for (let index = 0; index < end; index++) {
    if (value[index] === character) result++
  }
  return result
}

function validLink(candidate: string): boolean {
  try {
    const value = /^(?:https?|ftp|tg):\/\//iu.test(candidate)
      ? new URL(candidate)
      : new URL(`http://${candidate}`)
    if (!value.hostname) return false
    if (value.port && Number(value.port) > 65_535) return false
    return true
  } catch {
    return false
  }
}

function isEmailDomainFragment(text: string, offset: number, candidate: string): boolean {
  if (/^(?:https?|ftp|tg):\/\/|^www\./iu.test(candidate)) return false
  return offset > 0 && text[offset - 1] === '@'
}

function validRange(range: EntityRange): boolean {
  return Number.isInteger(range.offset) && Number.isInteger(range.length)
    && range.offset >= 0 && range.length > 0
}

function overlaps(left: EntityRange, right: EntityRange): boolean {
  return left.offset < right.offset + right.length && right.offset < left.offset + left.length
}
