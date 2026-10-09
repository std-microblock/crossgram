import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import { chromium } from 'playwright'
import QRCode from 'qrcode'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { waitForConnection, openPage } from './browser-test-utils.js'
import type { BridgeDashboardData } from '../../bridge/src/dashboard-types.js'
import {
  LoginTokenStore,
  parseTelegramLoginToken,
} from '../../bridge/src/login-token.js'
import { findDuplicateAccounts } from '../../bridge/src/account-duplicates.js'
import SolidWebUI from './index.js'
describe('Crossgram accounts, stickers and bots in the Solid shell', () => {
  it('keeps identity cards stable, decodes QR in a worker, requires explicit account approval and manages sticker/bot pages on a phone', async () => {
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
        tokenStore = new LoginTokenStore(),
        authKey = new Uint8Array([1, 2, 3, 4]),
        issued = tokenStore.issue(authKey)
      const tokenUrl =
          'tg://login?token=' + Buffer.from(issued).toString('base64url'),
        approvals: unknown[] = [],
        assignments: unknown[][] = [],
        described: string[][] = [],
        removed: string[][] = []
      ctx.server.post('/bridge/login-tokens/:platform/approve', async (req) => {
        const body = await req.json(),
          token = parseTelegramLoginToken(body.token)
        if (
          !token ||
          !tokenStore.approve(token, {
            platformId: req.params.platform,
            platformSessionId: req.params.platform + '-session',
          })
        )
          return Response.json({ error: 'AUTH_TOKEN_INVALID' }, { status: 400 })
        approvals.push({ platform: req.params.platform, token: body.token })
        return Response.json({ ok: true })
      })
      const data: BridgeDashboardData = {
        accounts: [
          {
            platformId: 'qq-main',
            platformKind: 'QQ',
            status: 'ready',
            displayName: 'Primary account',
            username: 'primary',
            userId: '12345',
            virtualPhone: '+888123456789',
            loginCode: '123456',
            validUntil: Date.now() + 30_000,
          },
          {
            platformId: 'matrix-alt',
            platformKind: 'Matrix',
            status: 'ready',
            displayName: 'Second account',
            userId: '67890',
            virtualPhone: '+888987654321',
            loginCode: '654321',
            validUntil: Date.now() + 30_000,
          },
          {
            platformId: 'offline',
            platformKind: 'Other',
            status: 'error',
            error: 'Platform disconnected',
          },
          {
            // A second QQ entry that could not claim the virtual phone of `qq-main`
            // carries no profile, exactly like the backend error projection.
            platformId: 'qq-duplicate',
            platformKind: 'QQ',
            status: 'error',
            userId: '12345',
            virtualPhone: '+888123456789',
            error: 'virtual phone is already assigned to platform entry',
          },
        ],
        serverConfig: {
          name: 'CrossGram',
          enable_special_config: false,
          host: 'example.test',
          port: 4430,
          rsa_key:
            '-----BEGIN RSA PUBLIC KEY-----\nPUBLIC_TEST_KEY\n-----END RSA PUBLIC KEY-----',
          dcs: [
            { id: 1, ip: 'example.test', port: 4430 },
            { id: 2, ip: 'example.test', port: 4430 },
          ],
        },
        serverEndpoints: [
          { host: 'example.test', port: 4430, primary: true },
          { host: 'backup.test', port: 8443, primary: false },
        ],
        loginTokenApprovalUrl: '/bridge/login-tokens',
        updatedAt: Date.now(),
        stickerAccounts: [
          {
            platformId: 'qq-main',
            platformSessionId: 'qq-session',
            platformKind: 'QQ',
            displayName: 'Primary account',
            userId: '12345',
          },
          {
            platformId: 'matrix-alt',
            platformSessionId: 'matrix-session',
            platformKind: 'Matrix',
            displayName: 'Second account',
            userId: '67890',
          },
        ],
        stickerPacks: Array.from({ length: 60 }, (_, id) => ({
          providerId: 'provider',
          packId: String(id),
          title: 'Collection ' + id,
          count: 20,
          sourcePlatformSessionId: 'qq-session',
          assignments: [
            {
              platformSessionId: 'qq-session',
              assigned: id === 0,
              automatic: id === 0,
            },
            {
              platformSessionId: 'matrix-session',
              assigned: false,
              automatic: false,
            },
          ],
        })),
        stickerUpdatedAt: Date.now(),
        bots: Array.from({ length: 40 }, (_, id) => ({
          conversationId: 'bot-' + id,
          title: 'Helpful bot ' + id,
          username: 'helper_' + id + '_bot',
          sourcePlugin: 'test-provider',
        })),
        botUpdatedAt: Date.now(),
        async refresh() {
          entry.mutate((value) => {
            value.accounts = value.accounts.map((account) => ({ ...account }))
            value.updatedAt = Date.now()
          })
        },
        async refreshBots() {},
        async refreshStickerPacks() {},
        async setLoginPassword() {},
        async findDuplicateAccounts() {
          return findDuplicateAccounts(
            data.accounts.map((account) => ({
              platformId: account.platformId,
              platformKind: account.platformKind,
              userId: account.userId,
              clientAuthorizations:
                account.platformId === 'qq-main'
                  ? 2
                  : account.platformId === 'matrix-alt'
                    ? 1
                    : 0,
            })),
          )
        },
        async describeAccountRemoval(platformIds) {
          described.push(platformIds)
          return {
            targets: platformIds.map((platformId) => ({
              platformId,
              platformKind:
                data.accounts.find((account) => account.platformId === platformId)
                  ?.platformKind ?? 'unknown',
              displayName: data.accounts.find(
                (account) => account.platformId === platformId,
              )?.displayName,
              clientAuthorizations:
                platformId === 'qq-main' ? 2 : platformId === 'matrix-alt' ? 1 : 0,
              managed: platformId !== 'offline',
            })),
            clientAuthorizations: platformIds.reduce(
              (total, platformId) =>
                total +
                (platformId === 'qq-main' ? 2 : platformId === 'matrix-alt' ? 1 : 0),
              0,
            ),
          }
        },
        async deleteAccounts(platformIds) {
          removed.push(platformIds)
          entry.mutate((value) => {
            value.accounts = value.accounts.filter(
              (account) => !platformIds.includes(account.platformId),
            )
          })
        },
        async setStickerPackAssigned(account, provider, pack, assigned) {
          assignments.push([account, provider, pack, assigned])
          entry.mutate((value) => {
            value.stickerPacks
              .find((item) => item.packId === pack)!
              .assignments.find(
                (item) => item.platformSessionId === account,
              )!.assigned = assigned
          })
        },
      }
      const entry = ui.addEntry(
        {
          baseUrl: new URL('../../bridge/src/index.ts', import.meta.url).href,
          manifest: '../dist/manifest.json',
          routes: ['/platform-accounts', '/sticker-packs', '/bots'],
        },
        data,
      )
      await entry.ready
      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      })
      const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          permissions: ['clipboard-read', 'clipboard-write'],
        }),
        page = await context.newPage()
      const requests: string[] = [],
        errors: string[] = []
      page.on('request', (request) => requests.push(request.url()))
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(ctx.server.baseUrl + '/console/')
      await waitForConnection(page)
      expect(
        requests.some((url) =>
          /assets\/(accounts|stickers|bots|qr|jsQR)-/.test(url),
        ),
      ).toBe(false)
      const go = (name: string) => openPage(page, name)
      await go('Platform accounts')
      await page
        .getByRole('heading', { name: 'Primary account', exact: true })
        .waitFor()

      // Vite hoists the plugin stylesheet into a shared chunk; a regression there silently
      // renders every card unstyled, so assert a real computed style rather than class names.
      expect(
        await page
          .locator('.otp-digits > span')
          .first()
          .evaluate((element) => getComputedStyle(element).borderRadius),
      ).toBe('8px')
      expect(
        await page
          .locator('.identity-avatar')
          .first()
          .evaluate((element) => getComputedStyle(element).borderTopLeftRadius),
      ).toBe('14px')
      expect(
        await page.evaluate(() => {
          const title = document
            .querySelector('.page-title')!
            .getBoundingClientRect()
          const actions = document
            .querySelector('.page-heading>.toolbar')!
            .getBoundingClientRect()
          return actions.top >= title.bottom
        }),
      ).toBe(true)
      await page
        .getByRole('button', { name: 'Copy phone for qq-main', exact: true })
        .click()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        '+888123456789',
      )
      await page
        .getByRole('button', {
          name: 'Copy login code for qq-main',
          exact: true,
        })
        .click()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        '123456',
      )
      await page.locator('[data-platform="qq-main"]').evaluate((element) => {
        element.setAttribute('data-stable-marker', 'same-node')
      })
      await data.refresh()
      await page.waitForTimeout(50)
      expect(
        await page
          .locator('[data-platform="qq-main"]')
          .getAttribute('data-stable-marker'),
      ).toBe('same-node')
      await page
        .getByRole('button', { name: 'Copy server configuration', exact: true })
        .click()
      const copiedConfiguration = await page.evaluate(() =>
        navigator.clipboard.readText(),
      )
      expect(JSON.parse(copiedConfiguration)).toEqual(data.serverConfig)
      expect(copiedConfiguration).toContain('PUBLIC_TEST_KEY')
      // Phones open the console over plain http, where navigator.clipboard is missing and
      // copyText falls back to a hidden textarea; that path must produce the same document.
      await page.evaluate(() =>
        Object.defineProperty(navigator.clipboard, 'writeText', {
          value: undefined,
          configurable: true,
        }),
      )
      await page
        .getByRole('button', { name: 'Configuration copied', exact: true })
        .click()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        copiedConfiguration,
      )
      // The clipboard and the readable document on the page are the same configuration.
      const displayedConfiguration = await page
        .getByLabel('Server configuration')
        .textContent()
      expect(JSON.parse(displayedConfiguration!)).toEqual(
        JSON.parse(copiedConfiguration),
      )
      // Copying for another endpoint only rewrites host/port, so a reader who needs
      // the backup address does not have to edit the pasted document by hand. The
      // mobile fallback path above is still active, so this covers it as well.
      const endpointPicker = page.getByLabel('Copy endpoint')
      expect(await endpointPicker.inputValue()).toBe('example.test:4430')
      await page
        .getByRole('button', { name: 'Configuration copied', exact: true })
        .click()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        copiedConfiguration,
      )
      await endpointPicker.selectOption('backup.test:8443')
      expect(await page.getByLabel('Server configuration').textContent()).toContain(
        '"host": "backup.test"',
      )
      await page
        .getByRole('button', { name: 'Configuration copied', exact: true })
        .click()
      const alternateConfiguration = await page.evaluate(() =>
        navigator.clipboard.readText(),
      )
      expect(JSON.parse(alternateConfiguration)).toEqual({
        ...data.serverConfig,
        host: 'backup.test',
        port: 8443,
        dcs: data.serverConfig.dcs.map((dc) => ({
          ...dc,
          ip: 'backup.test',
          port: 8443,
        })),
      })
      await endpointPicker.selectOption('example.test:4430')
      await page
        .getByRole('button', { name: 'Approve QR login', exact: true })
        .click()
      const dialog = page.getByRole('dialog', {
        name: 'Approve Telegram QR login',
      })
      await dialog.getByLabel('QR image').setInputFiles({
        name: 'telegram-login.png',
        mimeType: 'image/png',
        buffer: await QRCode.toBuffer(tokenUrl, { width: 320, margin: 2 }),
      })
      await expect
        .poll(() => dialog.getByLabel('Telegram login link').inputValue())
        .toBe(tokenUrl)
      expect(
        requests.some(
          (url) =>
            url.includes('/console/-/modules/') && url.includes('/qr-worker-'),
        ),
      ).toBe(true)
      expect(approvals).toEqual([])
      await dialog
        .getByLabel('Sign in as', { exact: true })
        .selectOption('matrix-alt')
      await dialog
        .getByRole('button', { name: 'Approve login', exact: true })
        .click()
      await page
        .getByText('Login approved. Continue in your Telegram client.')
        .waitFor()
      expect(tokenStore.claim(issued, authKey)?.identity).toEqual({
        platformId: 'matrix-alt',
        platformSessionId: 'matrix-alt-session',
      })
      await dialog.getByRole('button', { name: 'Close dialog' }).click()
      await go('Sticker collections')
      await page
        .getByRole('heading', { name: 'Collection 0', exact: true })
        .waitFor()
      expect(await page.locator('.sticker-card').count()).toBe(24)
      expect(
        await page
          .getByRole('button', {
            name: 'Automatically assigned Collection 0',
            exact: true,
          })
          .isDisabled(),
      ).toBe(true)
      await page
        .getByRole('button', { name: 'Add Collection 1', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Remove Collection 1', exact: true })
        .waitFor()
      expect(assignments.at(-1)).toEqual(['qq-session', 'provider', '1', true])
      await page
        .getByLabel('Assign to account', { exact: true })
        .selectOption('matrix-session')
      await page
        .getByRole('button', { name: 'Add Collection 1', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Remove Collection 1', exact: true })
        .waitFor()
      expect(assignments.at(-1)).toEqual([
        'matrix-session',
        'provider',
        '1',
        true,
      ])
      await page.getByLabel('Find a collection').fill('Collection 59')
      await page
        .getByRole('heading', { name: 'Collection 59', exact: true })
        .waitFor()
      expect(await page.locator('.sticker-card').count()).toBe(1)
      await go('Your bots')
      await page
        .getByRole('heading', { name: 'Helpful bot 0', exact: true })
        .waitFor()
      expect(await page.locator('.bot-card').count()).toBe(24)
      await page.getByLabel('Find a bot').fill('helper_39_bot')
      const bot = page.locator('.bot-card')
      expect(
        await bot
          .getByRole('link', { name: 'Open in Telegram' })
          .getAttribute('href'),
      ).toBe('https://t.me/helper_39_bot')
      await bot.getByRole('button', { name: 'Copy link' }).click()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        'https://t.me/helper_39_bot',
      )
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
      await go('Platform accounts')
      await page
        .getByRole('heading', { name: 'Primary account', exact: true })
        .waitFor()

      // Duplicate entries are reported by the backend with the entry that owns the
      // account, so the reader can see what would go before selecting anything.
      const duplicates = page.locator('[data-duplicates]')
      await duplicates.getByText('1 duplicate account', { exact: true }).waitFor()
      expect(await duplicates.textContent()).toContain(
        'qq-duplicate duplicates qq-main',
      )
      const duplicateCard = page.locator('[data-platform="qq-duplicate"]')
      expect(
        await duplicateCard.locator('[data-duplicate-of]').textContent(),
      ).toContain('Duplicate of qq-main')
      if (process.env.WEBUI_SCREENSHOTS) {
        await mkdir(process.env.WEBUI_SCREENSHOTS, { recursive: true })
        await page.screenshot({
          path: join(
            process.env.WEBUI_SCREENSHOTS,
            'accounts-duplicates-mobile.png',
          ),
          fullPage: true,
          animations: 'disabled',
        })
      }

      // An entry the configuration file does not own cannot be deleted, and the
      // dialog says so instead of dropping the entry from the runtime only.
      await page.getByRole('button', { name: 'Delete offline', exact: true }).click()
      const unmanagedDialog = page.getByRole('dialog', {
        name: 'Delete platform accounts',
      })
      await unmanagedDialog.getByText('offline is not managed by').waitFor()
      expect(
        await unmanagedDialog
          .getByRole('button', { name: 'Delete accounts', exact: true })
          .isDisabled(),
      ).toBe(true)
      await unmanagedDialog
        .getByRole('button', { name: 'Cancel', exact: true })
        .click()

      // Deleting an account clients are signed in through is confirmed with the
      // exact number of sessions that lose access.
      await page
        .getByRole('button', { name: 'Delete qq-main', exact: true })
        .click()
      const inUseDialog = page.getByRole('dialog', {
        name: 'Delete platform accounts',
      })
      await inUseDialog
        .getByText(/2 Telegram clients signed in through the selected entries will be signed out\./)
        .waitFor()
      await inUseDialog
        .getByRole('button', { name: 'Cancel', exact: true })
        .click()

      await page
        .getByRole('button', { name: 'Select duplicates', exact: true })
        .click()
      await page.getByText('1 selected', { exact: true }).waitFor()
      expect(
        await page
          .getByRole('checkbox', { name: 'Select qq-duplicate', exact: true })
          .isChecked(),
      ).toBe(true)
      await page
        .getByRole('button', { name: 'Delete selected', exact: true })
        .click()
      const deleteDialog = page.getByRole('dialog', {
        name: 'Delete platform accounts',
      })
      await deleteDialog.getByText('qq-duplicate', { exact: false }).first().waitFor()
      if (process.env.WEBUI_SCREENSHOTS) {
        await page.screenshot({
          path: join(
            process.env.WEBUI_SCREENSHOTS,
            'accounts-delete-confirm-mobile.png',
          ),
          animations: 'disabled',
        })
      }
      await deleteDialog
        .getByRole('button', { name: 'Delete accounts', exact: true })
        .click()
      await page.locator('[data-platform="qq-duplicate"]').waitFor({ state: 'detached' })
      await duplicates.waitFor({ state: 'detached' })
      expect(removed).toEqual([['qq-duplicate']])
      expect(described).toContainEqual(['qq-duplicate'])
      expect(await page.locator('.identity-card').count()).toBe(3)

      if (process.env.WEBUI_SCREENSHOTS) {
        await mkdir(process.env.WEBUI_SCREENSHOTS, { recursive: true })
        await page.screenshot({
          path: join(
            process.env.WEBUI_SCREENSHOTS,
            'solid-accounts-mobile.png',
          ),
          fullPage: true,
          animations: 'disabled',
        })
        await page.setViewportSize({ width: 1440, height: 1000 })
        await page.screenshot({
          path: join(
            process.env.WEBUI_SCREENSHOTS,
            'solid-accounts-desktop.png',
          ),
          fullPage: true,
          animations: 'disabled',
        })
        // A native <select> popup cannot be captured by Chromium, so the endpoint
        // picker is documented with the main endpoint selected and then with the
        // backup endpoint selected next to the document it produces.
        await page.evaluate(() => scrollTo(0, 0))
        await page
          .locator('.connection-config')
          .screenshot({
            path: join(
              process.env.WEBUI_SCREENSHOTS,
              'accounts-endpoint-main-desktop.png',
            ),
            animations: 'disabled',
          })
        await page.getByLabel('Copy endpoint').selectOption('backup.test:8443')
        await page
          .locator('.connection-config details')
          .evaluate((details) => details.setAttribute('open', 'open'))
        await page
          .locator('.connection-config')
          .screenshot({
            path: join(
              process.env.WEBUI_SCREENSHOTS,
              'accounts-endpoint-backup-desktop.png',
            ),
            animations: 'disabled',
          })
      }
      expect(errors).toEqual([])
      entry.dispose()
    } finally {
      await browser?.close()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  }, 60_000)
})
