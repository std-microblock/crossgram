import { describe, expect, it, vi } from 'vitest'
import {
  GROUP_FILES_MINI_APP_HTML,
  parseGroupFilesRange,
  registerGroupFilesMiniApp,
  signGroupFilesMiniAppToken,
  verifyGroupFilesMiniAppToken,
} from './group-files-miniapp.js'
import type { Context } from 'cordis'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'

describe('group files Mini App security', () => {
  it('round-trips signed browse tokens and rejects tampering', () => {
    vi.setSystemTime(new Date('2026-08-19T00:00:00Z'))
    const secret = Buffer.from('test-secret')
    const token = signGroupFilesMiniAppToken({
      kind: 'browse', platformId: 'qqnt', platformSessionId: 'session',
      conversationId: '2:group', title: 'Test Group', exp: 1_787_097_700,
    }, secret)

    expect(verifyGroupFilesMiniAppToken(token, secret)).toMatchObject({
      kind: 'browse', conversationId: '2:group', title: 'Test Group',
    })
    expect(verifyGroupFilesMiniAppToken(`${token.slice(0, -1)}x`, secret)).toBeUndefined()
    vi.useRealTimers()
  })

  it('rejects expired tokens and malformed byte ranges', () => {
    vi.setSystemTime(new Date('2026-08-19T00:00:00Z'))
    const secret = Buffer.from('test-secret')
    const expired = signGroupFilesMiniAppToken({
      kind: 'browse', platformId: 'qqnt', platformSessionId: 'session',
      conversationId: '2:group', title: 'Test Group', exp: 1,
    }, secret)
    expect(verifyGroupFilesMiniAppToken(expired, secret)).toBeUndefined()
    expect(parseGroupFilesRange('bytes=10-19', 100)).toEqual({ offset: 10, limit: 10 })
    expect(parseGroupFilesRange('bytes=100-', 100)).toBe(false)
    expect(parseGroupFilesRange('items=0-1', 100)).toBe(false)
    vi.useRealTimers()
  })

  it('ships folder navigation, search, pagination and downloads in the Mini App page', () => {
    expect(GROUP_FILES_MINI_APP_HTML).toContain('搜索当前文件夹')
    expect(GROUP_FILES_MINI_APP_HTML).toContain('data-folder')
    expect(GROUP_FILES_MINI_APP_HTML).toContain('./api/download')
    expect(GROUP_FILES_MINI_APP_HTML).toContain('加载更多')
    expect(GROUP_FILES_MINI_APP_HTML).toContain('Telegram?.WebApp')
  })
})

describe('group files Mini App E2E', () => {
  it('opens from the Telegram attachment menu, lists folders and streams a ranged download', async () => {
    vi.setSystemTime(new Date('2026-08-19T00:00:00Z'))
    const rpc = new Map<string, (context: unknown, request: any) => Promise<any>>()
    const routes = new Map<string, (request: any, response: any) => Promise<void>>()
    const bytes = new TextEncoder().encode('group-file')
    const platform = {
      listGroupFiles: vi.fn(async () => ({ items: [{
        type: 'folder' as const, id: 'folder', parentId: '', name: '资料',
        createTime: 1, modifyTime: 2, creatorId: '1', creatorName: 'Alice', fileCount: 1,
      }, {
        type: 'file' as const, id: 'file', parentId: '', name: 'manual.txt', size: bytes.length,
        uploadTime: 3, modifyTime: 4, downloadCount: 5, uploaderId: '2', uploaderName: 'Bob',
        media: {
          id: 'media', kind: 'file' as const, name: 'manual.txt', mimeType: 'text/plain', size: bytes.length,
          locator: { fileUuid: 'file' },
        },
      }] })),
      async *downloadMedia(_session: unknown, _media: unknown, options: { offset?: number, limit?: number }) {
        const offset = options.offset ?? 0
        yield bytes.subarray(offset, offset + (options.limit ?? bytes.length))
      },
    }
    const session = { platformId: 'qqnt', platformSessionId: 'session', userId: 'self' }
    const ctx = {
      mtproto: { register(method: string, handler: typeof rpc extends Map<string, infer H> ? H : never) { rpc.set(method, handler) } },
      server: {
        baseUrl: 'https://relay.example/',
        get(path: string, handler: typeof routes extends Map<string, infer H> ? H : never) { routes.set(path, handler) },
      },
    } as unknown as Context
    const state = {
      platform, session,
      dialogs: { resolveInputConversation: vi.fn(async () => ({ id: '2:group', kind: 'group', title: 'Test Group' })) },
    }
    const platforms = { sessions: [{ registrationId: 'qqnt', platform, session }] }
    registerGroupFilesMiniApp(ctx, platforms as never, async () => state as never, {
      publicUrl: 'https://relay.example/group-files', secret: 'secret', tokenTtlSeconds: 600,
    })

    const attach = await rpc.get('messages.getAttachMenuBots')!({}, {})
    const serialized = TlBinaryWriter.serializeObject(__tlWriterMap, attach)
    expect(new TlBinaryReader(__tlReaderMap, serialized).object()).toMatchObject({ _: 'attachMenuBots' })
    const opened = await rpc.get('messages.requestWebView')!({}, {
      bot: { _: 'inputUser', userId: attach.bots[0].botId },
      peer: { _: 'inputPeerChannel', channelId: 1 },
    })
    const browseToken = new URL(opened.url).searchParams.get('token')
    expect(browseToken).toBeTruthy()

    let listed: any
    await routes.get('/group-files/api/files')!({
      url: `https://relay.example/group-files/api/files?token=${encodeURIComponent(browseToken)}`,
    }, response((value) => { listed = value }))
    expect(listed).toMatchObject({
      title: 'Test Group',
      items: [{ type: 'folder', name: '资料' }, { type: 'file', name: 'manual.txt' }],
    })
    expect(platform.listGroupFiles).toHaveBeenCalledWith(session, { id: '2:group' }, {
      folderId: undefined, cursor: undefined, limit: 100,
    })

    const downloadResponse = response(() => {})
    await routes.get('/group-files/api/download')!({
      url: `https://relay.example/group-files/api/download?token=${encodeURIComponent(listed.items[1].downloadToken)}`,
      headers: new Headers({ range: 'bytes=1-4' }),
    }, downloadResponse)
    expect(downloadResponse.status).toBe(206)
    expect(downloadResponse.headers.get('content-range')).toBe(`bytes 1-4/${bytes.length}`)
    expect(new TextDecoder().decode(await collectStream(downloadResponse.body))).toBe('roup')
    vi.useRealTimers()
  })
})

function response(onJson: (value: unknown) => void) {
  return {
    status: 200,
    headers: new Headers(),
    body: undefined as ReadableStream<Uint8Array> | string | undefined,
    json: onJson,
  }
}

async function collectStream(stream: ReadableStream<Uint8Array> | string | undefined): Promise<Uint8Array> {
  if (!stream) return new Uint8Array()
  if (typeof stream === 'string') return new TextEncoder().encode(stream)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
