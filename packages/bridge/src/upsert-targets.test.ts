import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { defineModels } from './models.js'

/**
 * Postgres 驱动把 `upsert(table, rows, keys)` 的 keys 直接编译进
 * `INSERT ... ON CONFLICT (keys)`，键不匹配时整条语句报
 * "there is no unique or exclusion constraint matching the ON CONFLICT specification"；
 * 而 sqlite 驱动是在 JS 里按 keys 自己比较再决定 INSERT/UPDATE，不需要任何唯一约束。
 * 于是在只有 sqlite 的单测里，模型唯一键和 upsert 冲突目标不同步可以一路全绿上线。
 *
 * 这里直接读取源码，把每个显式 upsert 调用点的 keys 与模型声明的唯一键对齐。
 */
function declaredConflictTargets(): Map<string, string[][]> {
  const extend = vi.fn()
  defineModels({ model: { extend } } as never)
  const targets = new Map<string, string[][]>()
  for (const [table, , options] of extend.mock.calls as Array<[string, unknown, any]>) {
    const keys = new Set<string>()
    const primary = options?.primary ?? 'id'
    const list: string[][] = [[...(Array.isArray(primary) ? primary : [primary])]]
    for (const unique of options?.unique ?? []) list.push([...unique])
    for (const entry of list) if (entry.length) keys.add([...entry].sort().join(','))
    targets.set(table, [...keys].map((key) => key.split(',')))
  }
  return targets
}

/** 从某个位置开始做括号配对，返回整段调用的文本。 */
function callText(source: string, start: number): string {
  const open = source.indexOf('(', start)
  if (open < 0) return ''
  let depth = 0
  for (let index = open; index < source.length; index++) {
    const char = source[index]
    if (char === '(') depth++
    else if (char === ')') {
      depth--
      if (!depth) return source.slice(open, index + 1)
    }
  }
  return ''
}

/** 取调用文本里最后一个数组字面量里的字符串键。 */
function trailingKeyList(call: string): string[] | undefined {
  const matches = [...call.matchAll(/\[([^[\]]*)\]/g)]
  const last = matches.at(-1)
  if (!last) return undefined
  const keys = [...last[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!)
  return keys.length ? keys : undefined
}

describe('upsert conflict targets', () => {
  it('match a declared unique key for every explicit upsert in the bridge', () => {
    const targets = declaredConflictTargets()
    const sources = readdirSync(new URL('.', import.meta.url))
      .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
      .map((name) => [name, readFileSync(new URL(name, import.meta.url), 'utf8')] as const)
    let checked = 0

    for (const [file, source] of sources) {
      for (const match of source.matchAll(/\.upsert\('(mtproto_[a-z_]+)'/g)) {
        const table = match[1]!
        const keys = trailingKeyList(callText(source, match.index!))
        // 不带 keys 的调用由驱动回退到主键，无需核对。
        if (!keys) continue
        const declared = targets.get(table)
        expect(declared, `${file}: ${table} is not declared in defineModels`).toBeDefined()
        expect(
          declared!.map((entry) => [...entry].sort().join(',')),
          `${file}: ${table} upsert conflict target ${keys.join(',')} must match a declared unique key`,
        ).toContainEqual([...keys].sort().join(','))
        checked++
      }
    }
    // 至少覆盖分片映射、回应、黑名单与收藏贴纸这几处显式冲突目标。
    expect(checked).toBeGreaterThanOrEqual(4)
  })
})
