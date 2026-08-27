import { Context } from 'cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DebugScripts,
  normalizeScriptName,
  resolveConfiguredPath,
  serializeResult,
} from './index.js'

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true })
})

describe('debug script validation', () => {
  it('accepts nested TypeScript paths but rejects traversal, hidden files, and other extensions', () => {
    expect(normalizeScriptName('messages/query.ts')).toBe('messages/query.ts')
    expect(normalizeScriptName('messages\\query.ts')).toBe('messages/query.ts')
    for (const value of [
      '../query.ts',
      '.hidden.ts',
      'folder/.hidden.ts',
      '/root/query.ts',
      'query.d.ts',
      'query.js',
    ]) {
      expect(() => normalizeScriptName(value)).toThrow(
        /Invalid debug script path/,
      )
    }
  })

  it('resolves relative paths from the Cordis base URL', () => {
    const base = pathToFileURL(resolve('runtime', 'app.yml')).href
    expect(resolveConfiguredPath(base, '../state/scripts')).toBe(
      resolve('state/scripts'),
    )
  })

  it('normalizes non-JSON values and enforces result size limits', () => {
    const cyclic: Record<string, unknown> = {
      bigint: 42n,
      bytes: Uint8Array.from([1, 2]),
    }
    cyclic.self = cyclic
    expect(serializeResult(cyclic, 1024)).toEqual({
      bigint: '42n',
      bytes: { type: 'bytes', length: 2, base64: 'AQI=' },
      self: '[Circular]',
    })
    expect(() => serializeResult('x'.repeat(100), 20)).toThrow(
      /exceeds 20 bytes/,
    )
  })
})

describe('DebugScripts service', () => {
  it('exposes cloned status instead of mutable internal records', () => {
    const root = mkdtempSync(join(tmpdir(), 'debug-scripts-unit-'))
    temporary.push(root)
    const ctx = new Context()
    const service = new DebugScripts(ctx, {
      root: join(root, 'scripts'),
      results: join(root, 'results'),
    })
    expect(service.list()).toEqual([])
    expect(service.get('unknown.ts')).toBeUndefined()
  })
})
