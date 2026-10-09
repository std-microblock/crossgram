import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import { Loader } from '@cordisjs/plugin-loader'
import { afterEach, describe, expect, it } from 'vitest'
import { isLoaderManagedEntry, platformEntry, removePlatformEntry } from './account-removal.js'

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose()
})

/**
 * The real loader keys entries loaded from a config file with the path of the
 * tree that loaded them, which app.yml goes through in production
 * (`@cordisjs/plugin-cli-cordis` loads the file with `@cordisjs/plugin-include`).
 * Deleting an account therefore has to be checked against the real tree, not a
 * stand-in: removing the qualified key alone silently leaves the entry in place.
 */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'account-removal-loader-'))
  const config = join(directory, 'app.yml')
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: 'account-removal-loader-test', type: 'module', dependencies: {},
  }), 'utf8')
  const plugin = join(directory, 'plugin.mjs')
  await writeFile(plugin, 'export function apply() {}', 'utf8')
  const name = pathToFileURL(plugin).href
  await writeFile(config, [
    `- id: bridge01`, `  name: '${name}'`, '',
    `- id: qqnt`, `  name: '${name}'`, '',
    `- id: qqnt-2`, `  name: '${name}'`, '',
  ].join('\n'), 'utf8')
  const ctx = new Context()
  const loader = ctx.plugin(Loader)
  await loader
  disposals.push(async () => { await Promise.resolve((loader as any).dispose?.()) })
  await ctx.loader.create({
    name: '@cordisjs/plugin-include',
    config: { path: pathToFileURL(config).href, enableLogs: false },
  })
  await new Promise(resolve => setTimeout(resolve, 100))
  return { ctx, config }
}

describe('platform entry removal against the real loader', () => {
  it('finds and deletes an entry loaded from the configuration file', async () => {
    const { ctx, config } = await fixture()
    expect(platformEntry(ctx, 'qqnt-2')?.options.id).toBe('qqnt-2')
    expect(platformEntry(ctx, 'qqnt-2')?.id).not.toBe('qqnt-2')
    expect(isLoaderManagedEntry(ctx, 'qqnt')).toBe(true)

    removePlatformEntry(ctx, 'qqnt-2')
    const remaining = [...ctx.loader!.entries()].map(entry => entry.options.id)
    expect(remaining).not.toContain('qqnt-2')
    expect(remaining).toContain('qqnt')
    // The owning tree writes the file back, so the duplicate cannot return on restart.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await readFile(config, 'utf8')).not.toContain('qqnt-2')
    expect(isLoaderManagedEntry(ctx, 'qqnt-2')).toBe(false)
  })

  it('refuses an entry the configuration file never declared', async () => {
    const { ctx } = await fixture()
    expect(() => removePlatformEntry(ctx, 'qqnt-3')).toThrow('不是由配置文件管理的')
  })
})
