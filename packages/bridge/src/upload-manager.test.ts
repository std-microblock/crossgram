import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UploadManager } from './upload-manager.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createManager() {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-upload-'))
  directories.push(directory)
  return new UploadManager(directory)
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

describe('UploadManager', () => {
  it('accepts out-of-order parts and streams them in order without a combined buffer', async () => {
    const manager = await createManager()
    await manager.savePart('session', 'long:file/id', 2, new TextEncoder().encode('third'))
    await manager.savePart('session', 'long:file/id', 0, new TextEncoder().encode('first-'))
    await manager.savePart('session', 'long:file/id', 1, new TextEncoder().encode('second-'))
    const uploaded = await manager.open('session', 'long:file/id', 3)
    expect(uploaded.source.size).toBe(18)
    expect(new TextDecoder().decode(await collect(uploaded.source.stream()))).toBe('first-second-third')
  })

  it('rejects incomplete uploads and supports cancellation while streaming', async () => {
    const manager = await createManager()
    await manager.savePart('session', 'file', 0, new Uint8Array(128 * 1024))
    await expect(manager.open('session', 'file', 2)).rejects.toThrow('part is missing: 1')
    const uploaded = await manager.open('session', 'file', 1)
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(collect(uploaded.source.stream({ signal: controller.signal }))).rejects.toThrow('cancelled')
  })

  it('removes parts after successful delivery', async () => {
    const manager = await createManager()
    await manager.savePart('session', 'file', 0, new Uint8Array([1, 2, 3]))
    const uploaded = await manager.open('session', 'file', 1)
    await uploaded.cleanup()
    await expect(manager.open('session', 'file', 1)).rejects.toThrow('part is missing: 0')
  })

  it('reorders prepared parts, verifies all hashes, and never writes them to disk', async () => {
    const manager = await createManager()
    const bytes = Buffer.alloc(10 * 1024 * 1024 + 17, 0x5a)
    const parts = [
      bytes.subarray(0, 4 * 1024 * 1024),
      bytes.subarray(4 * 1024 * 1024, 8 * 1024 * 1024),
      bytes.subarray(8 * 1024 * 1024),
    ]
    const written: Buffer[] = []
    let completed = false
    const source = {
      size: bytes.length,
      async *stream(): AsyncIterable<Uint8Array> { throw new Error('native source must not be read') },
    }
    const hashes = {
      size: bytes.length,
      md5: createHash('md5').update(bytes).digest('hex'),
      sha1: createHash('sha1').update(bytes).digest('hex'),
      file10MMd5: createHash('md5').update(bytes.subarray(0, 10 * 1024 * 1024)).digest('hex'),
    }
    await expect(manager.prepare('session', 'prepared', hashes, {
      media: { kind: 'file', name: 'prepared.bin', size: bytes.length, source },
      sink: {
        async write(chunk) { written.push(Buffer.from(chunk)) },
        async complete() { completed = true },
        abort() {},
      },
    })).resolves.toBe('stream')

    await manager.savePart('session', 'prepared', 2, parts[2]!)
    expect(written).toEqual([])
    await manager.savePart('session', 'prepared', 0, parts[0]!)
    expect(Buffer.concat(written).equals(parts[0]!)).toBe(true)
    await manager.savePart('session', 'prepared', 1, parts[1]!)

    expect(Buffer.concat(written).equals(bytes)).toBe(true)
    expect(completed).toBe(true)
    expect(manager.getStaged('session', 'prepared')?.media.source).toBe(source)
    await expect(manager.open('session', 'prepared', 3)).rejects.toThrow('part is missing: 0')
    await manager.savePart('session', 'prepared', 2, parts[2]!)
    await expect(manager.open('session', 'prepared', 3)).rejects.toThrow('part is missing: 0')
  })

  it('aborts a prepared upload instead of staging it when an incremental hash differs', async () => {
    const manager = await createManager()
    const bytes = Buffer.from('hash-mismatch')
    let aborted: unknown
    let completed = false
    await manager.prepare('session', 'bad-hash', {
      size: bytes.length,
      md5: '00000000000000000000000000000000',
      sha1: createHash('sha1').update(bytes).digest('hex'),
      file10MMd5: createHash('md5').update(bytes).digest('hex'),
    }, {
      media: {
        kind: 'file', name: 'bad.bin', size: bytes.length,
        source: { size: bytes.length, async *stream() {} },
      },
      sink: {
        async write() {},
        async complete() { completed = true },
        abort(reason) { aborted = reason },
      },
    })

    await expect(manager.savePart('session', 'bad-hash', 0, bytes)).rejects.toThrow('md5 mismatch')
    expect(completed).toBe(false)
    expect(aborted).toBeInstanceOf(Error)
    expect(manager.getStaged('session', 'bad-hash')).toBeUndefined()
    await expect(manager.open('session', 'bad-hash', 1)).rejects.toThrow('part is missing: 0')
  })
})
