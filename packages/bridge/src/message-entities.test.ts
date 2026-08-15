import { describe, expect, it } from 'vitest'
import type { tl } from '@mtcute/core'
import { withAutoLinkEntities } from './message-entities.js'

describe('withAutoLinkEntities', () => {
  it('recognizes URL schemes, www hosts, bare domains, ports, and Unicode domains', () => {
    const text = [
      'https://example.com/a?q=1#top',
      'ftp://files.example.org:21/pub',
      'tg://resolve?domain=telegram',
      'www.example.net/docs',
      '例子.中国/路径',
    ].join(' | ')

    expect(linkTexts(text)).toEqual([
      'https://example.com/a?q=1#top',
      'ftp://files.example.org:21/pub',
      'tg://resolve?domain=telegram',
      'www.example.net/docs',
      '例子.中国/路径',
    ])
  })

  it('uses UTF-16 offsets and removes sentence punctuation without damaging balanced URL brackets', () => {
    const text = '😀参见（https://example.com/a_(b)），再看 example.org/docs。'
    expect(withAutoLinkEntities(text)).toEqual([
      {
        _: 'messageEntityUrl',
        offset: text.indexOf('https://'),
        length: 'https://example.com/a_(b)'.length,
      },
      {
        _: 'messageEntityUrl',
        offset: text.indexOf('example.org'),
        length: 'example.org/docs'.length,
      },
    ])
    expect(text.indexOf('https://')).toBe(5)
  })

  it('keeps encoded QQ group query tokens while excluding Chinese punctuation', () => {
    const qqGroupUrl = 'https://qm.qq.com/cgi-bin/qm/qr?k=Abc%2BDef%2Fghi%3D%3D&authKey=tok%252Fvalue%253D&noverify=0'
    const text = `加入群聊：${qqGroupUrl}，欢迎。`

    expect(linkTexts(text)).toEqual([qqGroupUrl])
    expect(withAutoLinkEntities(text)).toEqual([{
      _: 'messageEntityUrl', offset: text.indexOf(qqGroupUrl), length: qqGroupUrl.length,
    }])
  })

  it('does not produce invalid, email-fragment, or overlapping URL entities', () => {
    const text = 'mail user@example.com invalid http:// and https://covered.example/path'
    const coveredOffset = text.indexOf('https://')
    const existing: tl.TypeMessageEntity[] = [{
      _: 'messageEntityTextUrl', offset: coveredOffset, length: 'https://covered.example/path'.length,
      url: 'tg://resolve?domain=covered',
    }]

    expect(withAutoLinkEntities(text, existing)).toEqual(existing)
  })

  it('keeps existing entities and orders detected links by their Telegram offsets', () => {
    const text = 'first.dev @Alice then https://second.dev'
    const mention: tl.TypeMessageEntity = {
      _: 'messageEntityMentionName', offset: text.indexOf('@Alice'), length: 6, userId: 42,
    }

    expect(withAutoLinkEntities(text, [mention])).toEqual([
      { _: 'messageEntityUrl', offset: 0, length: 'first.dev'.length },
      mention,
      {
        _: 'messageEntityUrl',
        offset: text.indexOf('https://'),
        length: 'https://second.dev'.length,
      },
    ])
  })

  it('ends a URL before an adjacent platform mention instead of dropping the whole link', () => {
    const text = 'http://aaa.com@某个群友'
    const mention: tl.TypeMessageEntity = {
      _: 'messageEntityMentionName', offset: text.indexOf('@'), length: '@某个群友'.length, userId: 42,
    }

    expect(withAutoLinkEntities(text, [mention])).toEqual([
      { _: 'messageEntityUrl', offset: 0, length: 'http://aaa.com'.length },
      mention,
    ])
  })

  it('does not mistake common bare filenames for domains', () => {
    const text = [
      '这不是一个链接啊.zip',
      'archive.tar.gz',
      '报告.pdf',
      'https://downloads.example/file.zip',
      'www.example.zip',
      'example.zip/download',
    ].join(' | ')

    expect(linkTexts(text)).toEqual([
      'https://downloads.example/file.zip',
      'www.example.zip',
      'example.zip/download',
    ])
  })

  it('does not turn dot-separated tokens embedded in prose into links', () => {
    const texts = [
      '我想到隔壁有人用.net写东西后aot并且导出C符号入口点给cpp乃至Java用',
      '这段用asp.net写完再aot',
      '构建node.js项目再发布',
      '中文example.com中文',
    ]

    for (const text of texts) expect(linkTexts(text)).toEqual([])
  })

  it('recognizes domains when separated from surrounding prose', () => {
    const text = '中文 example.com 中文 | 例子.中国/路径 | 例子.com/路径'

    expect(linkTexts(text)).toEqual([
      'example.com',
      '例子.中国/路径',
      '例子.com/路径',
    ])
  })
})

function linkTexts(text: string): string[] {
  return (withAutoLinkEntities(text) ?? []).map((entity) =>
    text.slice(entity.offset, entity.offset + entity.length))
}
