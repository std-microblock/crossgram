import { createServer, type Server } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { tl } from '@mtcute/core'
import {
  LinkPreviewService, assertPublicUrl, displayUrlOf, getLinkPreviewPhotoFile, makeLinkPreviewMedia,
  messageLinkPreviewUrl, parsePreviewMetadata,
} from './link-preview.js'
import type { IMMessage } from './platform.js'

/** A 1×1 transparent PNG, enough for the thumbnail probe to read its size. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

function message(parts: IMMessage['content']['parts'], id = 'm1'): IMMessage {
  return {
    id, conversationId: 'group', senderId: 'alice', timestamp: 1_700_000_000,
    content: { parts: parts as IMMessage['content']['parts'] },
  }
}

async function serve(handler: (url: string, response: import('node:http').ServerResponse) => void): Promise<string> {
  const server: Server = createServer((request, response) => {
    handler(request.url ?? '/', response)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test server address')
  disposals.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })
  return `http://127.0.0.1:${address.port}`
}

async function cacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'link-preview-'))
  disposals.push(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

describe('messageLinkPreviewUrl', () => {
  it('takes the first bare link of the text', () => {
    expect(messageLinkPreviewUrl(message([{ type: 'text', text: '看这个 https://example.com/a?x=1#top 很好' }])))
      .toBe('https://example.com/a?x=1')
    expect(messageLinkPreviewUrl(message([{ type: 'text', text: 'example.com/path' }]))).toBe('http://example.com/path')
  })

  it('ignores messages whose media already is the preview', () => {
    expect(messageLinkPreviewUrl(message([
      { type: 'text', text: 'https://example.com/a' },
      { type: 'card', card: { kind: 'link', title: 'a', url: 'https://example.com/a' } },
    ]))).toBeUndefined()
    expect(messageLinkPreviewUrl(message([
      { type: 'text', text: 'https://example.com/a' },
      { type: 'media', media: { id: 'm', kind: 'image' } } as never,
    ]))).toBeUndefined()
  })

  it('ignores schemes Telegram does not preview', () => {
    expect(messageLinkPreviewUrl(message([{ type: 'text', text: '通过 tg://resolve?domain=x 或者邮件 mailto:a@b.c' }])))
      .toBeUndefined()
  })
})

describe('parsePreviewMetadata', () => {
  it('reads OpenGraph tags in either attribute order and decodes entities', () => {
    const html = `<!doctype html><html><head>
      <meta content="Title &amp; more" property="og:title">
      <meta property='og:description' content='Line one
        line two'>
      <meta name="og:site_name" content="Example Site">
      <meta property="og:image" content="/cover.png">
      <link rel="canonical" href="https://example.com/canonical">
      <title>Fallback title</title>
    </head><body></body></html>`
    expect(parsePreviewMetadata(html, new URL('https://example.com/a?x=1'))).toMatchObject({
      title: 'Title & more',
      description: 'Line one line two',
      siteName: 'Example Site',
      imageUrl: 'https://example.com/cover.png',
      canonicalUrl: 'https://example.com/canonical',
      displayUrl: 'example.com/canonical',
    })
  })

  it('falls back to the document title and the host name', () => {
    const parsed = parsePreviewMetadata('<html><head><title>  Plain   page </title></head></html>', new URL('https://www.example.org/x/'))
    expect(parsed.title).toBe('Plain page')
    expect(parsed.siteName).toBe('example.org/x')
    expect(parsed.imageUrl).toBeUndefined()
  })

  it('ignores tags inside comments and scripts', () => {
    const html = `<html><head>
      <!-- <meta property="og:title" content="commented"> -->
      <script>const meta = '<meta property="og:title" content="scripted">'</script>
      <meta property="og:title" content="real">
    </head></html>`
    expect(parsePreviewMetadata(html, new URL('https://example.com/')).title).toBe('real')
  })
})

describe('assertPublicUrl', () => {
  it('refuses loopback, private, link-local and metadata addresses', async () => {
    const blocked = [
      'http://localhost/',
      'http://app.localhost/',
      'http://printer.local/',
      'http://127.0.0.1/',
      'http://10.1.2.3/',
      'http://172.20.0.1/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://0.0.0.0/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://[::ffff:127.0.0.1]/',
      'file:///etc/passwd',
      'ftp://example.com/',
    ]
    for (const url of blocked) {
      await expect(assertPublicUrl(new URL(url))).rejects.toThrow()
    }
  })

  it('accepts a public address', async () => {
    await expect(assertPublicUrl(new URL('https://93.184.216.34/page'))).resolves.toBeUndefined()
  })

  it('honours the explicit private-host escape hatch', async () => {
    await expect(assertPublicUrl(new URL('http://127.0.0.1:8080/'), true)).resolves.toBeUndefined()
  })
})

describe('displayUrlOf', () => {
  it('drops the scheme, www and query', () => {
    expect(displayUrlOf(new URL('https://www.example.com/a/b/?q=1'))).toBe('example.com/a/b')
    expect(displayUrlOf(new URL('https://example.com/'))).toBe('example.com')
  })
})

describe('LinkPreviewService', () => {
  it('downloads metadata and thumbnail, then serves the picture through upload.getFile', async () => {
    let imageHits = 0
    const base = await serve((url, response) => {
      if (url === '/cover.png') {
        imageHits += 1
        response.setHeader('content-type', 'image/png')
        response.end(PNG_1X1)
        return
      }
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(`<html><head>
        <meta property="og:title" content="Hello preview">
        <meta property="og:description" content="One paragraph about the page">
        <meta property="og:site_name" content="Example">
        <meta property="og:image" content="/cover.png">
      </head></html>`)
    })
    const dir = await cacheDir()
    const service = new LinkPreviewService({ cachePath: dir, allowPrivateHosts: true, timeoutMs: 5_000 })
    const source = message([{ type: 'text', text: `看看 ${base}/article?from=qq 这个` }])

    expect(await service.previewFor(source, 1)).toBeUndefined()
    expect(await waitFor(() => service.media(source, 1))).toMatchObject({
      _: 'messageMediaWebPage', manual: true,
      webpage: {
        url: `${base}/article?from=qq`,
        displayUrl: '127.0.0.1/article',
        siteName: 'Example',
        title: 'Hello preview',
        description: 'One paragraph about the page',
        photo: { _: 'photo', sizes: [{ _: 'photoSize', type: 'x', w: 1, h: 1 }] },
      },
    })
    expect(imageHits).toBe(1)

    const page = webPageOf(service.media(source, 1))
    const photo = page.photo as tl.RawPhoto
    const file = await getLinkPreviewPhotoFile({
      _: 'inputPhotoFileLocation',
      id: photo.id,
      accessHash: photo.accessHash,
      fileReference: photo.fileReference,
      thumbSize: 'x',
    }, 0, 1_024)
    expect(file?.mimeType).toBe('image/png')
    expect(Buffer.from(file!.bytes).equals(PNG_1X1)).toBe(true)

    // The thumbnail is on disk, and a fresh process reloads it from there.
    expect((await readdir(dir)).some((name) => name.endsWith('.png'))).toBe(true)
    const restarted = new LinkPreviewService({ cachePath: dir, allowPrivateHosts: true })
    expect(await restarted.previewFor(source, 1)).toMatchObject({
      _: 'messageMediaWebPage', webpage: { title: 'Hello preview' },
    })
  })

  it('keeps the message a plain link when the site is unreachable', async () => {
    const dir = await cacheDir()
    const service = new LinkPreviewService({ cachePath: dir, timeoutMs: 1_000 })
    const source = message([{ type: 'text', text: 'http://127.0.0.1/secret' }])
    expect(await service.previewFor(source, 1)).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(service.media(source, 1)).toBeUndefined()
    expect(await readdir(dir)).toEqual([])
  })

  it('keeps the card when the thumbnail cannot be downloaded', async () => {
    const base = await serve((url, response) => {
      if (url === '/broken.png') {
        response.statusCode = 500
        response.end()
        return
      }
      response.setHeader('content-type', 'text/html')
      response.end('<html><head><meta property="og:title" content="No picture">'
        + '<meta property="og:image" content="/broken.png"></head></html>')
    })
    const dir = await cacheDir()
    const service = new LinkPreviewService({ cachePath: dir, allowPrivateHosts: true })
    const source = message([{ type: 'text', text: `${base}/page` }])
    await service.previewFor(source, 1)
    const media = await waitFor(() => service.media(source, 1))
    expect(media).toMatchObject({ webpage: { title: 'No picture' } })
    expect(webPageOf(media).photo).toBeUndefined()
  })

  it('skips cards without any metadata', async () => {
    const base = await serve((_url, response) => {
      response.setHeader('content-type', 'text/html')
      response.end('<html><head></head><body>nothing</body></html>')
    })
    const dir = await cacheDir()
    const service = new LinkPreviewService({ cachePath: dir, allowPrivateHosts: true })
    const source = message([{ type: 'text', text: `${base}/empty` }])
    await service.previewFor(source, 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(service.media(source, 1)).toBeUndefined()
  })

  it('renders nothing for a disabled service', async () => {
    const service = new LinkPreviewService({ enabled: false })
    const source = message([{ type: 'text', text: 'https://example.com/a' }])
    expect(await service.previewFor(source, 1)).toBeUndefined()
    expect(service.media(source, 1)).toBeUndefined()
  })
})

describe('makeLinkPreviewMedia', () => {
  it('refuses to build a card from an empty entry', () => {
    expect(makeLinkPreviewMedia({
      url: 'https://example.com/', displayUrl: 'example.com', fetchedAt: 1,
    }, 1)).toBeUndefined()
  })
})

function webPageOf(media: unknown): tl.RawWebPage {
  return (media as tl.RawMessageMediaWebPage).webpage as tl.RawWebPage
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 3_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return probe()
}
