import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import { chromium } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import SolidWebUI from './index.js'
describe('Solid package manager browser workflow', () => {
  it('pages and searches the catalog, inspects versions/peers, confirms install/remove and reports package-manager failure', async () => {
    const ctx = new Context(),
      fibers = [
        ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
        ctx.plugin(SolidWebUI),
      ]
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      await Promise.all(fibers)
      await vi.waitFor(() =>
        expect(fibers.every((fiber) => fiber.state === 2)).toBe(true),
      )
      const ui = ctx.get('webui') as unknown as SolidWebUI,
        calls: any[] = []
      const data: any = {
        market: {
          loading: false,
          data: Object.fromEntries(
            Array.from({ length: 65 }, (_, id) => [
              'package-' + id,
              {
                package: {
                  name: 'package-' + id,
                  version: '2.0.0',
                  description: 'Useful package number ' + id,
                },
                shortname: 'Package ' + id,
                verified: true,
                license: 'MIT',
              },
            ]),
          ),
          total: 65,
        },
        dependencies: {},
        async refresh() {},
        async describe(name: string) {
          return {
            name,
            latest: '2.0.0',
            description: 'Test package',
            versions: ['2.0.0', '1.0.0'],
          }
        },
        async registry(names: string[]) {
          return Object.fromEntries(
            names.map((name) => [
              name,
              {
                '2.0.0': { peerDependencies: { cordis: '^4' } },
                '1.0.0': { deprecated: 'Use version 2' },
              },
            ]),
          )
        },
        async install(deps: Record<string, string | null>, forced: boolean) {
          calls.push([deps, forced])
          if (Object.values(deps)[0] === '1.0.0') return 1
          entry.mutate((value: any) => {
            for (const [name, version] of Object.entries(deps))
              if (version === null) delete value.dependencies[name]
              else
                value.dependencies[name] = {
                  request: version,
                  resolved: version,
                }
          })
          return 0
        },
      }
      const entry = ui.addEntry<any>(
        {
          baseUrl: import.meta.url,
          client: 'market',
          routes: ['/market', '/dependencies'],
        },
        data,
      )
      await entry.ready
      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      })
      const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        }),
        errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(ctx.server.baseUrl + '/market')
      await page
        .getByRole('heading', { name: 'Package 0', exact: true })
        .waitFor()
      expect(await page.locator('.market-card').count()).toBe(24)
      await page.getByRole('button', { name: 'Next page' }).click()
      await page
        .getByRole('heading', { name: 'Package 24', exact: true })
        .waitFor()
      await page.getByLabel('Search plugins').fill('package-7')
      await page
        .getByRole('button', { name: 'View package', exact: true })
        .click()
      await page.getByRole('dialog').getByLabel('Version').selectOption('1.0.0')
      await page.getByText('Deprecated: Use version 2').waitFor()
      await page
        .getByRole('button', { name: 'Install package', exact: true })
        .click()
      await page
        .getByRole('dialog', { name: 'Install this package version?' })
        .getByRole('button', { name: 'Install package', exact: true })
        .click()
      await page
        .getByRole('alert')
        .filter({ hasText: 'exited with code 1' })
        .waitFor()
      await page
        .getByRole('dialog', { name: 'Install this package version?' })
        .getByRole('button', { name: 'Cancel', exact: true })
        .click()
      await page
        .getByRole('dialog', { name: 'package-7', exact: true })
        .getByLabel('Version')
        .selectOption('2.0.0')
      await page
        .getByRole('button', { name: 'Install package', exact: true })
        .click()
      await page
        .getByRole('dialog', { name: 'Install this package version?' })
        .getByRole('button', { name: 'Install package', exact: true })
        .click()
      await page
        .getByText('Package installation completed', { exact: true })
        .waitFor()
      expect(calls.at(-1)).toEqual([{ 'package-7': '2.0.0' }, false])
      await page
        .getByRole('button', { name: 'Remove dependency', exact: true })
        .click()
      await page
        .getByRole('dialog', { name: 'Remove this dependency?' })
        .getByRole('button', { name: 'Remove dependency', exact: true })
        .click()
      await page.getByText('Dependency removed', { exact: true }).waitFor()
      expect(calls.at(-1)).toEqual([{ 'package-7': null }, false])
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Close dialog' })
        .click()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
      expect(errors).toEqual([])
      entry.dispose()
    } finally {
      await browser?.close()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  }, 60_000)
})
