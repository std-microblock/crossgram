import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import { chromium } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import type {
  ImageStorageDashboardData,
  ImageStorageFilter,
  ImageStorageQuery,
  ImageStorageGroup,
  StickerDashboardAccount,
} from '../../bridge/src/dashboard-types.js'
import { openPage, waitForConnection } from './browser-test-utils.js'
import SolidWebUI from './index.js'

describe('Image storage management in the Solid shell', () => {
  it('filters and paginates UTC summaries, confirms scoped deletion, and handles busy, error and empty states on a phone', async () => {
    const ctx = new Context(),
      fibers = [
        ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
        ctx.plugin(SolidWebUI, { uiPath: '/console' }),
      ]
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      await Promise.all(fibers)
      await vi.waitFor(() =>
        expect(fibers.every((fiber) => fiber.state === 2)).toBe(true),
      )
      const ui = ctx.get('webui') as unknown as SolidWebUI,
        queries: ImageStorageQuery[] = [],
        deletions: ImageStorageFilter[] = [],
        queryTokens: (string | undefined)[] = [],
        deleteTokens: (string | undefined)[] = [],
        adminToken = 'image-storage-admin-session',
        accounts: StickerDashboardAccount[] = [
          {
            platformId: 'qq',
            platformSessionId: 'first',
            platformKind: 'QQ',
            displayName: 'First account',
            userId: '123',
          },
          {
            platformId: 'qq',
            platformSessionId: 'second',
            platformKind: 'QQ',
            displayName: 'Second account',
            userId: '456',
          },
        ]
      let records = [
          ...Array.from({ length: 26 }, (_, id) => ({
            platformSessionId: 'first',
            conversationId: 'group-' + id,
            conversationTitle: 'Group ' + id,
            date: id === 0 ? '2026-10-01' : '2026-10-02',
            count: 1,
            bytes: 1024,
          })),
          {
            platformSessionId: 'second',
            conversationId: 'private-1',
            conversationTitle: 'Private conversation',
            date: '2026-10-02',
            count: 2,
            bytes: 2048,
          },
        ],
        failQuery = false,
        failDelete = false,
        releaseDelete: (() => void) | undefined
      const matches = (
        row: (typeof records)[number],
        filter: ImageStorageFilter,
      ) =>
        (!filter.platformSessionId ||
          row.platformSessionId === filter.platformSessionId) &&
        (!filter.conversationId ||
          row.conversationId === filter.conversationId) &&
        (!filter.startDate || row.date >= filter.startDate) &&
        (!filter.endDate || row.date <= filter.endDate)
      const authorize = (token?: string) => {
        if (!token)
          throw new Error(
            'Sign in through Your account to manage image storage.',
          )
      }
      const data: ImageStorageDashboardData & {
        stickerAccounts: StickerDashboardAccount[]
      } = {
        imageStorageEnabled: false,
        stickerAccounts: accounts,
        async getImageStorage(query, token) {
          queryTokens.push(token)
          authorize(token)
          queries.push(query)
          if (failQuery) throw new Error('Storage query unavailable')
          const rows = records.filter((row) => matches(row, query)),
            groups = new Map<string, ImageStorageGroup>()
          for (const row of rows) {
            const key =
                row.platformSessionId +
                '/' +
                (query.groupBy === 'date' ? row.date : row.conversationId),
              group = groups.get(key) ?? {
                platformSessionId: row.platformSessionId,
                ...(query.groupBy === 'date'
                  ? { date: row.date }
                  : {
                      conversationId: row.conversationId,
                      conversationTitle: row.conversationTitle,
                    }),
                count: 0,
                bytes: 0,
              }
            group.count += row.count
            group.bytes += row.bytes
            groups.set(key, group)
          }
          const page = query.page ?? 1,
            pageSize = query.pageSize ?? 25
          return {
            count: rows.reduce((sum, row) => sum + row.count, 0),
            bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
            pendingCount: 0,
            groups: [...groups.values()].slice(
              (page - 1) * pageSize,
              page * pageSize,
            ),
            totalGroups: groups.size,
            page,
            pageSize,
          }
        },
        async deleteImageStorage(filter, token) {
          deleteTokens.push(token)
          authorize(token)
          deletions.push(filter)
          if (failDelete) throw new Error('Storage deletion failed')
          await new Promise<void>((resolve) => {
            releaseDelete = resolve
          })
          const deleted = records.filter((row) => matches(row, filter))
          records = records.filter((row) => !matches(row, filter))
          return {
            count: deleted.reduce((sum, row) => sum + row.count, 0),
            bytes: deleted.reduce((sum, row) => sum + row.bytes, 0),
          }
        },
      }
      const entry = ui.addEntry(
        {
          baseUrl: new URL('../../bridge/src/index.ts', import.meta.url).href,
          manifest: '../dist/manifest.json',
          routes: ['/image-storage'],
        },
        data,
      )
      await entry.ready
      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      })
      const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
        }),
        page = await context.newPage(),
        errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(ctx.server.baseUrl + '/console/')
      await waitForConnection(page)
      await openPage(page, 'Image storage')
      await page
        .getByRole('alert')
        .getByText(
          'Error: Sign in through Your account to manage image storage.',
          { exact: true },
        )
        .waitFor()
      expect(queryTokens[0]).toBeFalsy()
      expect(queries).toEqual([])
      await page.evaluate(() =>
        localStorage.setItem('cordis:webui-sso:token', 'member-session'),
      )
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByText('28 images · 28 KiB').waitFor()
      expect(queryTokens.at(-1)).toBe('member-session')
      expect(
        await page.getByText('Disabled (default)', { exact: true }).isVisible(),
      ).toBe(true)
      expect(await page.locator('tbody tr').count()).toBe(25)
      expect(queries.at(-1)).toEqual({
        groupBy: 'conversation',
        page: 1,
        pageSize: 25,
      })
      const otherTab = await page.context().newPage()
      await otherTab.goto(ctx.server.baseUrl + '/console/')
      await otherTab.evaluate(() =>
        localStorage.removeItem('cordis:webui-sso:token'),
      )
      await page
        .getByRole('alert')
        .getByText(
          'Error: Sign in through Your account to manage image storage.',
          { exact: true },
        )
        .waitFor()
      expect(await page.locator('tbody tr').count()).toBe(0)
      expect(
        await page
          .getByRole('button', { name: 'Delete filtered copies', exact: true })
          .count(),
      ).toBe(0)
      await otherTab.evaluate(() =>
        localStorage.setItem('cordis:webui-sso:token', 'member-session'),
      )
      await page.getByText('28 images · 28 KiB').waitFor()
      await otherTab.close()
      await page.getByRole('button', { name: 'Next page', exact: true }).click()
      await page.getByText('Page 2 of 2 · 27 groups', { exact: true }).waitFor()
      expect(await page.locator('tbody tr').count()).toBe(2)
      expect(queries.at(-1)?.page).toBe(2)
      await page.getByLabel('Group by', { exact: true }).selectOption('date')
      await page.getByText('Page 1 of 1 · 3 groups', { exact: true }).waitFor()
      expect(queries.at(-1)).toMatchObject({ groupBy: 'date', page: 1 })
      await page.getByLabel('Account', { exact: true }).selectOption('second')
      await page.getByText('2 images · 2 KiB').waitFor()
      await page
        .getByLabel('Conversation ID (group or private)', { exact: true })
        .fill('private-1')
      await page
        .getByLabel('Conversation ID (group or private)', { exact: true })
        .press('Tab')
      await expect.poll(() => queries.at(-1)?.conversationId).toBe('private-1')
      await page
        .getByLabel('Start date (UTC)', { exact: true })
        .fill('2026-10-02')
      await expect.poll(() => queries.at(-1)?.startDate).toBe('2026-10-02')
      await page
        .getByLabel('End date (UTC, inclusive)', { exact: true })
        .fill('2026-10-02')
      await expect.poll(() => queries.at(-1)?.endDate).toBe('2026-10-02')
      const selected = {
        platformSessionId: 'second',
        conversationId: 'private-1',
        startDate: '2026-10-02',
        endDate: '2026-10-02',
      }
      expect(queries.at(-1)).toEqual({
        ...selected,
        groupBy: 'date',
        page: 1,
        pageSize: 25,
      })
      await page
        .getByRole('button', { name: 'Delete filtered copies', exact: true })
        .click()
      const dialog = page.getByRole('dialog', {
        name: 'Delete server image copies?',
      })
      expect(await dialog.textContent()).toContain(
        'Account: Second account (second)',
      )
      expect(await dialog.textContent()).toContain('Conversation: private-1')
      expect(await dialog.textContent()).toContain(
        '2026-10-02 to 2026-10-02 (UTC, inclusive)',
      )
      expect(await dialog.textContent()).toContain(
        '2 images · 2 KiB (2,048 bytes)',
      )
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(deletions).toEqual([])
      expect(deleteTokens).toEqual([])
      await page
        .getByRole('button', {
          name: 'Delete copies for Second account / 2026-10-02',
          exact: true,
        })
        .click()
      await page.evaluate(() =>
        localStorage.removeItem('cordis:webui-sso:token'),
      )
      await dialog
        .getByRole('button', { name: 'Delete copies', exact: true })
        .click()
      await dialog
        .getByRole('alert')
        .getByText('Sign in through Your account to manage image storage.', {
          exact: true,
        })
        .waitFor()
      expect(deletions).toEqual([])
      expect(deleteTokens[0]).toBeFalsy()
      await page.evaluate(
        (token) => localStorage.setItem('cordis:webui-sso:token', token),
        adminToken,
      )
      failDelete = true
      await dialog
        .getByRole('button', { name: 'Delete copies', exact: true })
        .click()
      await dialog
        .getByRole('alert')
        .getByText('Storage deletion failed', { exact: true })
        .waitFor()
      expect(deletions).toEqual([selected])
      failDelete = false
      await dialog
        .getByRole('button', { name: 'Delete copies', exact: true })
        .click()
      await expect.poll(() => !!releaseDelete).toBe(true)
      expect(
        await dialog
          .getByRole('button', { name: 'Cancel', exact: true })
          .isDisabled(),
      ).toBe(true)
      expect(
        await page.getByLabel('Account', { exact: true }).isDisabled(),
      ).toBe(true)
      releaseDelete!()
      await page
        .getByRole('heading', { name: 'No stored images in this range' })
        .waitFor()
      expect(await page.getByText('0 images · 0 B').isVisible()).toBe(true)
      expect(
        await page
          .getByRole('button', { name: 'Delete filtered copies', exact: true })
          .isDisabled(),
      ).toBe(true)
      expect(records).toHaveLength(26)
      expect(
        records.some(
          (row) =>
            row.conversationId === 'group-0' && row.date === '2026-10-01',
        ),
      ).toBe(true)

      // 改回其他账号后仍能看到未选范围的副本，并验证失败后可重新查询。
      await page.getByLabel('Account', { exact: true }).selectOption('first')
      await expect.poll(() => queries.at(-1)?.platformSessionId).toBe('first')
      await page
        .getByLabel('Conversation ID (group or private)', { exact: true })
        .fill('')
      await page
        .getByLabel('Conversation ID (group or private)', { exact: true })
        .press('Tab')
      await page.getByText('25 images · 25 KiB').waitFor()
      failQuery = true
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page
        .getByRole('alert')
        .getByText('Error: Storage query unavailable', { exact: true })
        .waitFor()
      expect(
        await page
          .getByRole('button', { name: 'Delete filtered copies', exact: true })
          .count(),
      ).toBe(0)
      failQuery = false
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByText('25 images · 25 KiB').waitFor()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
      await page
        .getByLabel('Group by', { exact: true })
        .selectOption('conversation')
      await page.getByText('Page 1 of 1 · 25 groups', { exact: true }).waitFor()
      await page
        .getByRole('button', {
          name: 'Delete copies for First account / Group 1',
          exact: true,
        })
        .click()
      expect(await dialog.textContent()).toContain('Conversation: group-1')
      expect(await dialog.textContent()).toContain(
        '1 images · 1 KiB (1,024 bytes)',
      )
      releaseDelete = undefined
      await dialog
        .getByRole('button', { name: 'Delete copies', exact: true })
        .click()
      await expect.poll(() => !!releaseDelete).toBe(true)
      releaseDelete!()
      await page.getByText('24 images · 24 KiB').waitFor()
      expect(deletions.at(-1)).toEqual({
        platformSessionId: 'first',
        conversationId: 'group-1',
        startDate: '2026-10-02',
        endDate: '2026-10-02',
      })
      await page
        .getByRole('button', { name: 'Delete filtered copies', exact: true })
        .click()
      expect(await dialog.textContent()).toContain(
        'All group and private conversations',
      )
      expect(await dialog.textContent()).toContain(
        '24 images · 24 KiB (24,576 bytes)',
      )
      releaseDelete = undefined
      await dialog
        .getByRole('button', { name: 'Delete copies', exact: true })
        .click()
      await expect.poll(() => !!releaseDelete).toBe(true)
      releaseDelete!()
      await page
        .getByRole('heading', { name: 'No stored images in this range' })
        .waitFor()
      expect(deletions.at(-1)).toEqual({
        platformSessionId: 'first',
        startDate: '2026-10-02',
        endDate: '2026-10-02',
      })
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        platformSessionId: 'first',
        conversationId: 'group-0',
        date: '2026-10-01',
      })
      // 原图已删而预览删除失败时，仅剩字节占用也必须能重试范围删除。
      records.push({
        platformSessionId: 'first', conversationId: 'preview-retry',
        conversationTitle: 'Preview retry', date: '2026-10-02', count: 0, bytes: 200,
      })
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByText('0 images · 200 B').waitFor()
      const retryDelete = page.getByRole('button', { name: 'Delete filtered copies', exact: true })
      expect(await retryDelete.isEnabled()).toBe(true)
      await retryDelete.click()
      expect(await dialog.textContent()).toContain('0 images · 200 B (200 bytes)')
      releaseDelete = undefined
      await dialog.getByRole('button', { name: 'Delete copies', exact: true }).click()
      await expect.poll(() => !!releaseDelete).toBe(true)
      releaseDelete!()
      await page.getByRole('heading', { name: 'No stored images in this range' }).waitFor()
      expect(records).toHaveLength(1)
      const beforeInvalidRange = queries.length
      await page
        .getByLabel('Start date (UTC)', { exact: true })
        .fill('2026-10-03')
      await page
        .getByRole('alert')
        .getByText('Start date must be on or before end date.', { exact: true })
        .waitFor()
      expect(queries).toHaveLength(beforeInvalidRange)
      expect(
        await page
          .getByRole('button', { name: 'Refresh', exact: true })
          .isDisabled(),
      ).toBe(true)
      expect(queryTokens).toContain('member-session')
      expect(queryTokens.at(-1)).toBe(adminToken)
      expect(deleteTokens.slice(1).every((token) => token === adminToken)).toBe(
        true,
      )
      expect(errors).toEqual([])
      entry.dispose()
    } finally {
      await browser?.close()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  }, 90_000)
})
