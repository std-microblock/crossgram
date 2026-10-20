import { describe, expect, it } from 'vitest'
import {
  escapeRegExpLiteral, filterSearchKinds, mediaSearchKind, messageSearchKinds, messageSearchText,
  normalizeSearchTerms, partMatchesSearchKinds, SEARCH_KIND,
} from './message-search.js'
import type { IMMessage } from './platform.js'

function message(parts: IMMessage['content']['parts'], extra: Partial<IMMessage> = {}): IMMessage {
  return { id: 'm', conversationId: 'c', senderId: 'u', timestamp: 1, content: { parts }, ...extra }
}

describe('message search fields', () => {
  it('normalizes full-width text and case, and splits terms on any whitespace', () => {
    expect(normalizeSearchTerms('  ＨＥＬＬＯ\tWorld  hello ')).toEqual(['hello', 'world'])
    expect(normalizeSearchTerms('')).toEqual([])
    expect(messageSearchText(message([{ type: 'text', text: 'ＡＢＣ Def' }]))).toBe('abc def')
  })

  it('indexes captions, file names, card text, and hidden link targets but not service tips', () => {
    const text = messageSearchText(message([
      { type: 'text', text: 'Look', entities: [{ type: 'text-link', offset: 0, length: 4, url: 'https://X.example/Y' }] },
      { type: 'media', media: { id: 'f', kind: 'file', name: 'Report.PDF' } },
      { type: 'card', card: { kind: 'link', title: 'Title', description: 'Desc', url: 'https://card.example' } },
    ]))
    expect(text).toContain('look')
    expect(text).toContain('report.pdf')
    expect(text).toContain('title')
    expect(text).toContain('desc')
    expect(text).toContain('https://card.example')
    expect(text).toContain('https://x.example/y')
    expect(messageSearchText(message([], { content: { parts: [], serviceAction: { type: 'custom', text: 'tip' } } })))
      .toBe('')
  })

  it('classifies media the way Telegram shared-media filters expect', () => {
    expect(mediaSearchKind({ kind: 'image', mimeType: 'image/png' })).toBe(SEARCH_KIND.PHOTO)
    expect(mediaSearchKind({ kind: 'image', mimeType: 'image/gif' })).toBe(SEARCH_KIND.GIF)
    expect(mediaSearchKind({ kind: 'file', mimeType: 'image/apng' })).toBe(SEARCH_KIND.GIF)
    expect(mediaSearchKind({ kind: 'file', mimeType: 'video/mp4' })).toBe(SEARCH_KIND.VIDEO)
    expect(mediaSearchKind({ kind: 'file', mimeType: 'audio/ogg', voice: true })).toBe(SEARCH_KIND.VOICE)
    expect(mediaSearchKind({ kind: 'file', mimeType: 'audio/mpeg' })).toBe(SEARCH_KIND.MUSIC)
    expect(mediaSearchKind({ kind: 'file', mimeType: 'application/zip' })).toBe(SEARCH_KIND.DOCUMENT)
    expect(mediaSearchKind(undefined)).toBe(0)
  })

  it('derives message-level kinds for links, mentions, services, and calls', () => {
    expect(messageSearchKinds(message([{ type: 'text', text: 'go to example.com now' }]))).toBe(SEARCH_KIND.URL)
    const mention = message([{
      type: 'text', text: '@me', entities: [{ type: 'mention', offset: 0, length: 3, userId: 'self' }],
    }])
    expect(messageSearchKinds(mention, { selfUserId: 'self', conversationKind: 'group' })).toBe(SEARCH_KIND.MENTION)
    expect(messageSearchKinds(mention, { selfUserId: 'self', conversationKind: 'direct' })).toBe(0)
    expect(messageSearchKinds({ ...mention, outgoing: true }, { selfUserId: 'self', conversationKind: 'group' })).toBe(0)
    expect(messageSearchKinds(message([{ type: 'text', text: 'reply' }]), {
      selfUserId: 'self', conversationKind: 'group', repliesToSelf: true,
    })).toBe(SEARCH_KIND.MENTION)
    expect(messageSearchKinds(message([], { content: { parts: [], serviceAction: { type: 'phone-call' } } })))
      .toBe(SEARCH_KIND.SERVICE | SEARCH_KIND.PHONE_CALL)
    expect(messageSearchKinds(message([], { content: { parts: [], serviceAction: { type: 'custom', text: 'x' } } })))
      .toBe(SEARCH_KIND.SERVICE)
  })

  it('matches album parts individually and message-level kinds only on the first part', () => {
    const photo = { kind: 'image' as const, mimeType: 'image/png' }
    const doc = { kind: 'file' as const, mimeType: 'application/pdf' }
    expect(partMatchesSearchKinds(0, { ordinal: 1, media: photo }, SEARCH_KIND.PHOTO)).toBe(true)
    expect(partMatchesSearchKinds(0, { ordinal: 2, media: doc }, SEARCH_KIND.PHOTO)).toBe(false)
    expect(partMatchesSearchKinds(SEARCH_KIND.URL, { ordinal: 0, media: doc }, SEARCH_KIND.URL)).toBe(true)
    expect(partMatchesSearchKinds(SEARCH_KIND.URL, { ordinal: 1, media: doc }, SEARCH_KIND.URL)).toBe(false)
    expect(partMatchesSearchKinds(0, { ordinal: 3 }, 0)).toBe(true)
  })

  it('maps Telegram filters and rejects ones the relay cannot serve', () => {
    expect(filterSearchKinds({ _: 'inputMessagesFilterEmpty' })).toBe(0)
    expect(filterSearchKinds({ _: 'inputMessagesFilterPhotoVideo' })).toBe(SEARCH_KIND.PHOTO | SEARCH_KIND.VIDEO)
    expect(filterSearchKinds({ _: 'inputMessagesFilterRoundVoice' })).toBe(SEARCH_KIND.VOICE)
    expect(filterSearchKinds({ _: 'inputMessagesFilterMyMentions' })).toBe(SEARCH_KIND.MENTION)
    expect(filterSearchKinds({ _: 'inputMessagesFilterPhoneCalls', missed: true })).toBe(SEARCH_KIND.PHONE_CALL)
    expect(filterSearchKinds({ _: 'inputMessagesFilterPinned' })).toBeNull()
    expect(filterSearchKinds({ _: 'inputMessagesFilterGeo' })).toBeNull()
  })

  it('escapes every regular-expression metacharacter into a literal', () => {
    const value = 'a.b*c+d?e(f)g[h]i{j}k|l^m$n\\o/p-q'
    const pattern = new RegExp(escapeRegExpLiteral(value))
    expect(pattern.test(`xx${value}yy`)).toBe(true)
    expect(pattern.test('aXb*c+d?e(f)g[h]i{j}k|l^m$n\\o/p-q')).toBe(false)
  })
})
