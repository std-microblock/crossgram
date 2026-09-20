import { describe, expect, it } from 'vitest'
import z from 'schemastery'
import {
  decodeSchema,
  initialValue,
  setAt,
  unionIndex,
  switchUnionValue,
  validateSchema,
  description,
} from './schema-model.js'
const wire = (schema: any) => JSON.parse(JSON.stringify(schema))
describe('Schemastery wire model', () => {
  it('decodes real uid/ref graphs including shared and recursive schemas without evaluating callbacks', () => {
    const shared = z.string().required()
    const model = decodeSchema(
      wire(z.object({ a: shared, b: shared, date: z.date() })),
    )
    expect(model.dict!.a).toBe(model.dict!.b)
    expect(model.dict!.date.type).toBe('union')
    const hostile = decodeSchema({
      uid: 1,
      refs: {
        1: {
          type: 'transform',
          inner: 2,
          callback: 'throw new Error("must not execute")',
        },
        2: { type: 'string', meta: {} },
      },
    })
    expect(validateSchema(hostile, 'safe')).toEqual([])
    const recursive = decodeSchema({
      uid: 1,
      refs: { 1: { type: 'object', dict: { next: 1 } } },
    })
    expect(recursive.dict!.next).toBe(recursive)
  })
  it('honors defaults, bounds, required values, patterns, tuple and collection constraints', () => {
    const schema = decodeSchema(
      wire(
        z.object({
          port: z.natural().min(1).max(65535).required(),
          token: z.string().pattern(/^key-/).required(),
          tags: z.array(String).min(1).max(2),
          pair: z.tuple([String, Number]),
          enabled: z.boolean().default(true),
        }),
      ),
    )
    expect(
      validateSchema(schema, {
        port: 123,
        token: 'key-good',
        tags: ['one'],
        pair: ['x', 2],
      }),
    ).toEqual([])
    const issues = validateSchema(schema, {
      port: 1.5,
      token: 'bad',
      tags: [],
      pair: ['only'],
    })
    expect(issues.map((issue) => issue.path.join('.'))).toEqual([
      'port',
      'token',
      'tags',
      'pair.1',
    ])
    expect(
      validateSchema(schema, { port: Infinity, token: null }).length,
    ).toBeGreaterThan(0)
    expect(initialValue(decodeSchema(wire(z.natural().default(8))))).toBe(8)
  })
  it('selects discriminated union branches, constant falsy values, and intersection fields', () => {
    const schema = decodeSchema(
      wire(
        z.union([
          z.object({ type: z.const('a'), x: z.string() }),
          z.object({ type: z.const('b'), y: z.number() }),
        ]),
      ),
    )
    expect(unionIndex(schema, { type: 'b', y: 2 })).toBe(1)
    expect(initialValue(schema.list![1])).toEqual({ type: 'b' })
    expect(
      switchUnionValue(schema, { type: 'a', x: 'old', common: 'preserve' }, 1),
    ).toEqual({ type: 'b', common: 'preserve' })
    const constants = decodeSchema(
      wire(z.union([z.const(false), z.const(0), z.const(null)])),
    )
    expect(unionIndex(constants, 0)).toBe(1)
    expect(unionIndex(constants, null)).toBe(2)
    const intersection = decodeSchema(
      wire(
        z.intersect([
          z.object({ x: z.string().required() }),
          z.object({ y: z.number().required() }),
        ]),
      ),
    )
    expect(validateSchema(intersection, {}).map((issue) => issue.path)).toEqual(
      [['x'], ['y']],
    )
  })
  it('preserves unknown and hidden values during immutable nested edits and blocks prototype paths', () => {
    const original = {
      secret: 'hidden',
      nested: { other: 1, value: 2 },
      list: [1, 2],
    }
    const changed = setAt(original, ['nested', 'value'], 3)
    expect(changed).toEqual({ ...original, nested: { other: 1, value: 3 } })
    expect(original.nested.value).toBe(2)
    expect(setAt(changed, ['nested', 'value'], undefined).nested).toEqual({
      other: 1,
    })
    expect(() => setAt({}, ['__proto__', 'polluted'], true)).toThrow('Unsafe')
    expect(({} as any).polluted).toBeUndefined()
  })
  it('uses plain localized descriptions and rejects broken reference graphs', () => {
    expect(
      description(
        {
          type: 'string',
          meta: { description: { 'en-US': '<b>Text</b>', 'zh-CN': '文字' } },
        },
        'en-US',
      ),
    ).toBe('<b>Text</b>')
    expect(() => decodeSchema({ uid: 1, refs: {} })).toThrow('Invalid')
  })
})
