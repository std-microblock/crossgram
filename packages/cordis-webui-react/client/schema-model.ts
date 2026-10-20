export interface SchemaMeta {
  default?: any
  required?: boolean
  disabled?: boolean
  hidden?: boolean
  collapse?: boolean
  description?: string | Record<string, string>
  role?: string
  min?: number
  max?: number
  step?: number
  pattern?: { source: string; flags?: string }
  comment?: string
  link?: string
  extra?: unknown
}
export interface SchemaNode {
  type: string
  meta: SchemaMeta
  value?: any
  dict?: Record<string, SchemaNode>
  list?: SchemaNode[]
  inner?: SchemaNode
  sKey?: SchemaNode
  bits?: Record<string, number>
  className?: string
}
export interface Issue {
  path: (string | number)[]
  message: string
}
const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor'])
export function safeKey(key: string) {
  return !dangerousKeys.has(key)
}
export function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}
/** Schemastery serializes schemas as uid/ref graphs. Never evaluate serialized callbacks. */
export function decodeSchema(input: any): SchemaNode {
  if (typeof input === 'function' && input.toJSON)
    input = JSON.parse(JSON.stringify(input))
  const refs = input?.refs ?? {}
  const seen = new Map<any, SchemaNode>()
  let count = 0
  function decode(value: any, depth = 0): SchemaNode {
    if (typeof value === 'number' || typeof value === 'string')
      value = refs[value]
    if (value?.uid !== undefined && value?.refs) value = value.refs[value.uid]
    if (!value || typeof value !== 'object' || typeof value.type !== 'string')
      throw new Error('Invalid configuration schema')
    if (seen.has(value)) return seen.get(value)!
    if (depth > 64 || ++count > 20_000)
      throw new Error('Configuration schema is too complex')
    const node: SchemaNode = { type: value.type, meta: { ...value.meta } }
    seen.set(value, node)
    if (Object.hasOwn(value, 'value')) node.value = clone(value.value)
    if (Object.hasOwn(value, 'constructor'))
      node.className = String(value.constructor)
    if (value.dict)
      node.dict = Object.fromEntries(
        Object.entries(value.dict)
          .filter(([key]) => safeKey(key))
          .map(([key, child]) => [key, decode(child, depth + 1)]),
      )
    if (value.list)
      node.list = value.list.map((child: any) => decode(child, depth + 1))
    if (value.inner !== undefined) node.inner = decode(value.inner, depth + 1)
    if (value.sKey !== undefined) node.sKey = decode(value.sKey, depth + 1)
    if (value.bits) node.bits = { ...value.bits }
    return node
  }
  return decode(
    input?.refs ? refs[input.uid] : (input ?? { type: 'any', meta: {} }),
  )
}
export function description(
  schema: SchemaNode,
  locale = globalThis.navigator?.language ?? 'en-US',
): string {
  const value = schema.meta.description
  if (typeof value === 'string') return value
  return (
    value?.[locale] ??
    value?.[locale.startsWith('zh') ? 'zh-CN' : 'en-US'] ??
    Object.values(value ?? {})[0] ??
    ''
  )
}
export function labelFor(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/^./, (value) => value.toUpperCase())
}
export function initialValue(schema: SchemaNode, depth = 0): any {
  if (depth > 20) return undefined
  if (schema.type === 'const') return clone(schema.value)
  if (schema.type === 'object') {
    const value = clone(schema.meta.default ?? {})
    for (const [key, child] of Object.entries(schema.dict ?? {}))
      if (child.meta.required || child.type === 'const')
        value[key] ??= initialValue(child, depth + 1)
    return value
  }
  if (schema.meta.default !== undefined) return clone(schema.meta.default)
  if (schema.type === 'intersect')
    return Object.assign(
      {},
      ...(schema.list ?? []).map((child) => initialValue(child, depth + 1)),
    )
  if (schema.type === 'union')
    return schema.list?.[0]
      ? initialValue(schema.list[0], depth + 1)
      : undefined
  if (schema.type === 'transform')
    return schema.inner && initialValue(schema.inner, depth + 1)
  if (schema.type === 'tuple')
    return schema.list?.map((child) => initialValue(child, depth + 1)) ?? []
  if (schema.type === 'array') return []
  if (schema.type === 'dict') return {}
  if (schema.type === 'number' || schema.type === 'bitset')
    return schema.meta.min ?? 0
  if (schema.type === 'boolean') return false
  if (schema.type === 'string') return ''
  return null
}
export function getAt(value: any, path: (string | number)[]): any {
  for (const key of path) value = value?.[key]
  return value
}
export function setAt(value: any, path: (string | number)[], next: any): any {
  if (!path.length) return next
  const [key, ...rest] = path
  if (typeof key === 'string' && !safeKey(key))
    throw new Error('Unsafe configuration key')
  const result = Array.isArray(value) ? [...value] : { ...(value ?? {}) }
  if (next === undefined && !rest.length) delete result[key as any]
  else result[key as any] = setAt(value?.[key], rest, next)
  return result
}
function object(value: any): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export function unionIndex(schema: SchemaNode, value: any): number {
  const list = schema.list ?? []
  // Discriminant constants must match even when they are not required.
  const exact = list.findIndex((child) =>
    child.type === 'const'
      ? Object.is(child.value, value)
      : child.type === 'object' &&
        object(value) &&
        Object.entries(child.dict ?? {}).some(
          ([key, field]) =>
            field.type === 'const' && Object.is(value[key], field.value),
        ) &&
        !validateSchema(child, value).length,
  )
  if (exact >= 0) return exact
  const compatible = list.findIndex(
    (child) => !validateSchema(child, value).length,
  )
  return Math.max(0, compatible)
}
export function switchUnionValue(
  schema: SchemaNode,
  value: any,
  index: number,
): any {
  const next = schema.list?.[index]
  if (!next) return undefined
  if (next.type !== 'object' || !object(value)) return initialValue(next)
  const previous = schema.list?.[unionIndex(schema, value)]
  const result = clone(value)
  for (const key of Object.keys(previous?.dict ?? {}))
    if (!Object.hasOwn(next.dict ?? {}, key)) delete result[key]
  for (const [key, child] of Object.entries(next.dict ?? {})) {
    if (child.type === 'const') result[key] = clone(child.value)
    else if (
      result[key] === undefined &&
      (child.meta.required || child.meta.default !== undefined)
    )
      result[key] = initialValue(child)
  }
  return result
}
/** Fast local validation. Runtime transforms/custom types remain authoritative on the server. */
export function validateSchema(
  schema: SchemaNode,
  value: any,
  path: (string | number)[] = [],
  depth = 0,
): Issue[] {
  const fail = (message: string): Issue[] => [{ path, message }]
  if (depth > 64) return fail('Configuration is nested too deeply')
  if (isExpression(value))
    return value.__jsExpr.trim() ? [] : fail('Enter a server-side expression')
  if (value === undefined || value === null) {
    if (schema.meta.default !== undefined) return []
    if (schema.type === 'const' && Object.is(value, schema.value)) return []
    if (schema.meta.required) return fail('This field is required')
    if (value === undefined) return []
  }
  const meta = schema.meta
  const walk = (child: SchemaNode, input: any, key?: string | number) =>
    validateSchema(
      child,
      input,
      key === undefined ? path : [...path, key],
      depth + 1,
    )
  switch (schema.type) {
    case 'const':
      return Object.is(schema.value, value)
        ? []
        : fail('Expected ' + JSON.stringify(schema.value))
    case 'never':
      return fail('This value is not allowed')
    case 'string': {
      if (typeof value !== 'string') return fail('Enter text')
      if (meta.min !== undefined && value.length < meta.min)
        return fail('Use at least ' + meta.min + ' characters')
      if (meta.max !== undefined && value.length > meta.max)
        return fail('Use at most ' + meta.max + ' characters')
      if (meta.pattern) {
        try {
          if (!new RegExp(meta.pattern.source, meta.pattern.flags).test(value))
            return fail('Value does not match the required pattern')
        } catch {
          return fail('The plugin provided an invalid pattern')
        }
      }
      return []
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value))
        return fail('Enter a finite number')
      if (meta.min !== undefined && value < meta.min)
        return fail('Minimum is ' + meta.min)
      if (meta.max !== undefined && value > meta.max)
        return fail('Maximum is ' + meta.max)
      if (
        meta.step &&
        Math.abs(value / meta.step - Math.round(value / meta.step)) > 1e-8
      )
        return fail('Use increments of ' + meta.step)
      return []
    case 'boolean':
      return typeof value === 'boolean' ? [] : fail('Choose on or off')
    case 'object':
      return object(value)
        ? Object.entries(schema.dict ?? {}).flatMap(([key, child]) =>
            walk(child, value[key], key),
          )
        : fail('Expected an object')
    case 'dict':
      return object(value)
        ? Object.entries(value).flatMap(([key, child]) => [
            ...(!safeKey(key)
              ? fail('Unsafe key')
              : schema.sKey
                ? walk(schema.sKey, key, key)
                : []),
            ...(schema.inner ? walk(schema.inner, child, key) : []),
          ])
        : fail('Expected a dictionary')
    case 'array':
    case 'tuple': {
      if (!Array.isArray(value)) return fail('Expected a list')
      if (meta.min !== undefined && value.length < meta.min)
        return fail('Add at least ' + meta.min + ' items')
      if (meta.max !== undefined && value.length > meta.max)
        return fail('Use at most ' + meta.max + ' items')
      if (schema.type === 'tuple' && value.length > (schema.list?.length ?? 0))
        return fail('Too many tuple items')
      return schema.type === 'tuple'
        ? (schema.list ?? []).flatMap((child, index) =>
            walk(child, value[index], index),
          )
        : value.flatMap((child, index) =>
            schema.inner ? walk(schema.inner, child, index) : [],
          )
    }
    case 'union': {
      const issues = (schema.list ?? []).map((child) => walk(child, value))
      if (issues.some((list) => !list.length)) return []
      return fail('Value does not match any available option')
    }
    case 'intersect':
      return (schema.list ?? []).flatMap((child) => walk(child, value))
    case 'transform':
      return schema.inner ? walk(schema.inner, value) : []
    case 'bitset':
      return typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0
        ? []
        : Array.isArray(value) &&
            value.every((key) => Object.hasOwn(schema.bits ?? {}, key))
          ? []
          : fail('Choose valid flags')
    default:
      return []
  }
}

export function isExpression(value: unknown): value is { __jsExpr: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, '__jsExpr') &&
    typeof (value as any).__jsExpr === 'string'
  )
}
/** Preserve expression wrappers in saved YAML; evaluate only on the trusted server for validation. */
export function configExpression(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error('Configuration is nested too deeply')
  if (isExpression(value)) return '(' + value.__jsExpr + ')'
  if (Array.isArray(value))
    return (
      '[' +
      value.map((item) => configExpression(item, depth + 1)).join(',') +
      ']'
    )
  if (value && typeof value === 'object')
    return (
      '({' +
      Object.entries(value)
        .map(
          ([key, item]) =>
            JSON.stringify(key) + ':' + configExpression(item, depth + 1),
        )
        .join(',') +
      '})'
    )
  return JSON.stringify(value) ?? 'undefined'
}
