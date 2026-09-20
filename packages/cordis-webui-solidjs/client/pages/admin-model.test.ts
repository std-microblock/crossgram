import { describe, expect, it, vi } from 'vitest'
import {
  displayValue,
  pageSlice,
  parseCell,
  parseHeaders,
  primaryKey,
  readResponse,
  safeHttpURL,
  stripAnsi,
} from './admin-model.js'
import { neighborhood } from './insight.js'
import { parseNotice } from './notifications.js'
describe('bounded administration models', () => {
  it('pages without mutating input and strips terminal control sequences', () => {
    const items = Array.from({ length: 105 }, (_, id) => id)
    expect(pageSlice(items, 2)).toEqual([100, 101, 102, 103, 104])
    expect(items).toHaveLength(105)
    expect(stripAnsi('\x1b[31mDanger\x1b[0m')).toBe('Danger')
    expect(displayValue({ a: 1 })).toBe('{"a":1}')
  })
  it('parses field types and protects composite primary keys', () => {
    expect(parseCell('42', 'unsigned', false, false)).toBe(42)
    expect(parseCell('false', 'boolean', false, false)).toBe(false)
    expect(parseCell('{"nested":true}', 'json', false, false)).toEqual({
      nested: true,
    })
    expect(parseCell('', 'string', true, true)).toBeNull()
    for (const value of ['', 'NaN', 'Infinity', '9007199254740993', '1.2'])
      expect(() => parseCell(value, 'integer', false, false)).toThrow()
    expect(() => parseCell('no', 'boolean', false, false)).toThrow()
    expect(() => parseCell('', 'string', false, true)).toThrow()
    expect(
      primaryKey({ tenant: 1, id: 'a', value: 2 }, ['tenant', 'id']),
    ).toEqual({ tenant: 1, id: 'a' })
    expect(() => primaryKey({ id: null }, ['id'])).toThrow()
  })
  it('validates request URLs and headers without hiding malformed input', () => {
    expect(parseHeaders('Accept: application/json\nX-Test: one:two')).toEqual({
      Accept: 'application/json',
      'X-Test': 'one:two',
    })
    for (const text of [
      'broken',
      'Host: attack',
      'Cookie: session',
      'Bad Name: value',
    ])
      expect(() => parseHeaders(text)).toThrow()
    for (const url of [
      'javascript:alert(1)',
      'file:///secret',
      'https://name:password@example.test',
    ])
      expect(() => safeHttpURL(url)).toThrow()
    expect(safeHttpURL('https://example.test')).toBe('https://example.test/')
  })
  it('bounds streamed HTTP responses and cancels the reader at the byte limit', async () => {
    const cancel = vi.fn(),
      progress = vi.fn()
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello'))
          controller.enqueue(new TextEncoder().encode('world!'))
        },
        cancel,
      }),
    )
    expect(await readResponse(response, 8, progress)).toEqual({
      text: 'hellowor',
      truncated: true,
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(progress).toHaveBeenLastCalledWith('hellowor')
    expect(await readResponse(new Response('plain'))).toEqual({
      text: 'plain',
      truncated: false,
    })
  })
  it('renders only a deterministic bounded graph neighborhood, including cyclic dependencies', () => {
    const nodes = Array.from({ length: 1000 }, (_, uid) => ({
      uid,
      name: 'node-' + uid,
      state: 2,
    }))
    const edges = nodes
      .slice(1)
      .map((node) => ({ source: 0, target: node.uid, type: 'solid' }))
    edges.push({ source: 1, target: 0, type: 'dashed' })
    const graph = neighborhood(nodes, edges, 0)
    expect(graph.nodes.length).toBeLessThanOrEqual(41)
    expect(graph.omitted).toBeGreaterThan(900)
    expect(graph.height).toBeLessThanOrEqual(1560)
    expect(neighborhood([], [], 0).nodes).toEqual([])
  })
  it('parses notifier markup as safe text/elements while preserving opaque action IDs', () => {
    const nodes = parseNotice(
      '<p>Hello <strong>world</strong><button on-click="abc123">Retry</button><a href="javascript:alert(1)">bad</a><a href="https://example.test">safe</a><script>alert(1)</script><img src=x onerror=alert(1)><button onclick="alert(1)">unsafe</button></p>',
    )
    const text = JSON.stringify(nodes)
    expect(text).not.toContain('javascript:')
    expect(text).not.toContain('alert(1)')
    expect(text).not.toContain('"img"')
    expect(text).toContain('"action":"abc123"')
    expect(text).toContain('https://example.test/')
    expect(text).toContain('world')
  })
})
