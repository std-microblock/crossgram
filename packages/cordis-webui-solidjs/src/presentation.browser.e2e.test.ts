import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import Timer from '@cordisjs/plugin-timer'
import { chromium } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import SolidWebUI from './index.js'
import { waitForConnection } from './browser-test-utils.js'

describe('Solid WebUI presentation contract', () => {
  it('keeps the shell on a real icon set, hides the drawer affordances on desktop, and never overflows narrow screens', async () => {
    const ctx = new Context(),
      fibers = [
        ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
        ctx.plugin(SolidWebUI, { uiPath: '/console' }),
        ctx.plugin(Timer),
      ]
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      await Promise.all(fibers)
      await vi.waitFor(() =>
        expect(fibers.every((fiber) => fiber.state === 2)).toBe(true),
      )
      const ui = ctx.get('webui') as unknown as SolidWebUI
      ui.addEntry(
        {
          baseUrl: import.meta.url,
          client: 'loader',
          routes: ['/plugins{/*id}'],
          // A page with a missing icon glyph must still resolve to a real SVG icon.
          pages: [
            {
              path: '/plugins',
              title: 'Plugins',
              icon: 'plugins',
              group: 'Manage',
            },
            {
              path: '/odd',
              title: 'Odd page',
              icon: 'not-a-real-icon',
              group: 'Manage',
            },
          ],
        },
        { entries: [], packages: {}, services: {}, prefix: '' },
      )
      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      })
      const desktop = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      })
      const errors: string[] = []
      desktop.on('pageerror', (error) => errors.push(error.message))
      await desktop.goto(ctx.server.baseUrl + '/console/')
      await waitForConnection(desktop)
      // Every navigation entry draws an inline SVG, never a text glyph.
      const navText = await desktop.locator('.nav-item').allInnerTexts()
      const navGlyphs = navText.filter((text) =>
        /[\u2190-\u2BFF\u25A0-\u27BF]/.test(text),
      )
      expect(navGlyphs).toEqual([])
      expect(await desktop.locator('.nav-item .icon').count()).toBeGreaterThan(
        3,
      )
      // The drawer button exists for phones but stays out of the desktop layout.
      expect(await desktop.locator('.mobile-menu').isVisible()).toBe(false)
      // The skip link is reachable by keyboard but invisible until focused, so it never
      // shows up in screenshots or reads as stray page content.
      const skip = desktop.locator('.skip-link')
      expect(
        await skip.evaluate((element) => getComputedStyle(element).opacity),
      ).toBe('0')
      await desktop.keyboard.press('Tab')
      // The reveal is animated, so poll instead of sampling a single frame.
      await expect
        .poll(() =>
          skip.evaluate((element) => getComputedStyle(element).opacity),
        )
        .toBe('1')
      await expect
        .poll(() =>
          skip.evaluate((element) => getComputedStyle(element).transform),
        )
        .toBe('none')
      await skip.press('Enter')
      expect(await desktop.evaluate(() => location.hash)).toBe('#main')
      // A page card without a matching icon still renders an icon, not the raw string.
      expect(await desktop.locator('.page-card .icon').count()).toBeGreaterThan(
        0,
      )
      expect(
        await desktop
          .locator('.page-card', { hasText: 'Odd page' })
          .innerText(),
      ).not.toContain('not-a-real-icon')
      const phone = await browser.newPage({
        viewport: { width: 360, height: 780 },
      })
      phone.on('pageerror', (error) => errors.push(error.message))
      await phone.goto(ctx.server.baseUrl + '/console/')
      await waitForConnection(phone)
      expect(await phone.locator('.mobile-menu').isVisible()).toBe(true)
      expect(
        await phone.locator('[data-status="connected"]').first().isVisible(),
      ).toBe(true)
      for (const width of [360, 390, 768]) {
        await phone.setViewportSize({ width, height: 780 })
        await phone.waitForTimeout(120)
        expect(
          await phone.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          ),
          'width ' + width,
        ).toBeLessThanOrEqual(1)
      }
      await phone.setViewportSize({ width: 360, height: 780 })
      await phone.locator('.mobile-menu').click()
      await expect
        .poll(() => phone.locator('.navigation').getAttribute('class'))
        .toContain('open')
      // Focus moves into the drawer and Escape returns it to the toggle.
      expect(
        await phone.evaluate(
          () => document.activeElement?.closest('.navigation') !== null,
        ),
      ).toBe(true)
      await phone.keyboard.press('Escape')
      await expect
        .poll(() =>
          phone.evaluate(() =>
            document.activeElement?.getAttribute('aria-label'),
          ),
        )
        .toBe('Open navigation')
      expect(
        await phone.locator('.navigation').getAttribute('class'),
      ).not.toContain('open')
      expect(errors).toEqual([])
    } finally {
      await browser?.close()
      for (const fiber of fibers.reverse())
        await Promise.resolve((fiber as any).dispose?.())
    }
  }, 90_000)
})
