import { describe, expect, it, vi } from 'vitest'
import { MatrixClient, MatrixHttpError, parseMxc } from './client.js'

describe('MatrixClient', () => {
  it('authenticates requests, encodes Matrix IDs, and serializes query parameters', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/_matrix/client/v3/rooms/!room%3Aexample.org/messages')
      expect(url.searchParams.get('dir')).toBe('f')
      expect(url.searchParams.get('limit')).toBe('7')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token')
      return Response.json({ chunk: [], end: 'next' })
    })
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org/', accessToken: 'test-token', fetch,
    })

    await expect(client.getMessages('!room:example.org', { dir: 'f', limit: 7 }))
      .resolves.toEqual({ chunk: [], end: 'next' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('surfaces structured Matrix errors', async () => {
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org',
      accessToken: 'expired',
      fetch: async () => Response.json({
        errcode: 'M_UNKNOWN_TOKEN', error: 'Access token is invalid',
      }, { status: 401 }),
    })

    const error = await client.whoAmI().catch((value) => value)
    expect(error).toBeInstanceOf(MatrixHttpError)
    expect(error).toMatchObject({ status: 401, errcode: 'M_UNKNOWN_TOKEN', message: 'Access token is invalid' })
  })

  it('uploads binary data with progress and downloads an mxc URI', async () => {
    const requests: Array<{ url: URL, method: string, body?: Uint8Array }> = []
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org',
      accessToken: 'secret',
      fetch: async (input, init) => {
        const url = new URL(String(input))
        const requestBody = init?.body instanceof ReadableStream
          ? new Uint8Array(await new Response(init.body).arrayBuffer())
          : init?.body instanceof Uint8Array ? init.body : undefined
        requests.push({
          url,
          method: init?.method ?? 'GET',
          body: requestBody,
        })
        if (url.pathname.endsWith('/upload')) return Response.json({ content_uri: 'mxc://cdn.example/id' })
        return new Response(new Uint8Array([4, 5, 6]))
      },
    })
    const progress: number[] = []
    const mxc = await client.upload((async function* () {
      yield new Uint8Array([1, 2])
      yield new Uint8Array([3])
    })(), {
      filename: 'a b.bin', contentType: 'application/octet-stream', onChunk: (size) => progress.push(size),
    })
    const download = await client.download(mxc)

    expect(mxc).toBe('mxc://cdn.example/id')
    expect(progress).toEqual([2, 1])
    expect(requests[0]?.url.searchParams.get('filename')).toBe('a b.bin')
    expect(requests[0]?.body).toEqual(new Uint8Array([1, 2, 3]))
    expect(requests[1]?.url.pathname).toBe('/_matrix/media/v3/download/cdn.example/id')
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]))
  })

  it('uses unique transaction IDs for sends and redactions', async () => {
    const paths: string[] = []
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org', accessToken: 'secret',
      fetch: async (input) => {
        paths.push(new URL(String(input)).pathname)
        return Response.json({ event_id: `$event-${paths.length}` })
      },
    })

    await client.sendEvent('!r:hs', 'm.room.message', { body: 'one' })
    await client.sendEvent('!r:hs', 'm.room.message', { body: 'two' })
    await client.redactEvent('!r:hs', '$event/with/slash')

    expect(paths[0]).not.toBe(paths[1])
    expect(paths[2]).toMatch(/\/redact\/%24event%2Fwith%2Fslash\//)
  })

  it('validates Matrix content URIs', () => {
    expect(parseMxc('mxc://example.org/a/b')).toEqual({ serverName: 'example.org', mediaId: 'a/b' })
    expect(() => parseMxc('https://example.org/a')).toThrow(/invalid Matrix content URI/)
  })
})
