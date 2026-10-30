import { describe, expect, it } from 'vitest'
import { LARK_EMOJI_MAP, emoticonToLarkKey, larkKeyToEmoticon } from './emoji.js'

describe('emoji map', () => {
  it('is bijective in both directions', () => {
    for (const [key, emoticon] of LARK_EMOJI_MAP) {
      expect(larkKeyToEmoticon(key)).toBe(emoticon)
      expect(emoticonToLarkKey(emoticon)).toBe(key)
    }
    expect(larkKeyToEmoticon('UNKNOWNKEY')).toBeUndefined()
    expect(emoticonToLarkKey('🦖')).toBeUndefined()
  })
})
