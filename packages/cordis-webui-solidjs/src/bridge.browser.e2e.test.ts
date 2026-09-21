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
        assignments: unknown[][] = []
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
        ],
        serverConfig: {
          name: 'CrossGram',
          enable_special_config: false,
          host: 'example.test',
          port: 4430,
          rsa_key: 'PUBLIC_TEST_KEY',
          dcs: [],
        },
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
      expect(
        JSON.parse(await page.evaluate(() => navigator.clipboard.readText())),
      ).toMatchObject({ host: 'example.test', rsa_key: 'PUBLIC_TEST_KEY' })
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
      }
      expect(errors).toEqual([])
      entry.dispose()
    } finally {
      await browser?.close()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  }, 60_000)
})
