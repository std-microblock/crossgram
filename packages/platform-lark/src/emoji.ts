/**
 * 飞书 emoji_type ↔ Telegram emoticon 手工映射（飞书表情为自有体系，无官方 Unicode 对照）。
 * 仅收录语义确定的常用子集；未映射的 key 接收时显示为 [KEY] 文本，发送时忽略。
 */
export const LARK_EMOJI_MAP: ReadonlyArray<readonly [key: string, emoticon: string]> = [
  ['THUMBSUP', '👍'],
  ['OK', '👌'],
  ['THANKS', '🙏'],
  ['MUSCLE', '💪'],
  ['APPLAUSE', '👏'],
  ['FISTBUMP', '👊'],
  ['DONE', '✅'],
  ['SMILE', '😄'],
  ['BLUSH', '😊'],
  ['LAUGH', '😂'],
  ['LOL', '🤣'],
  ['FACEPALM', '🤦'],
  ['LOVE', '❤️'],
  ['WINK', '😉'],
  ['PROUD', '😎'],
  ['THINKING', '🤔'],
  ['SOB', '😭'],
  ['CRY', '😢'],
  ['ERROR', '❌'],
  ['WHAT', '❓'],
  ['FROWN', '🙁'],
  ['SHY', '😳'],
  ['HUG', '🤗'],
  ['WAVE', '👋'],
  ['PRAISE', '🙌'],
  ['MONEY', '💰'],
  ['JIAYI', '➕'],
  ['KISS', '😘'],
  ['DIZZY', '😵'],
  ['CRAZY', '🤪'],
]

const KEY_TO_EMOTICON = new Map(LARK_EMOJI_MAP)
const EMOTICON_TO_KEY = new Map(LARK_EMOJI_MAP.map(([key, emoticon]) => [emoticon, key] as const))

export function larkKeyToEmoticon(key: string): string | undefined {
  return KEY_TO_EMOTICON.get(key)
}

export function emoticonToLarkKey(emoticon: string): string | undefined {
  return EMOTICON_TO_KEY.get(emoticon)
}
