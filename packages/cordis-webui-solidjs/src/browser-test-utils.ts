import { expect, vi } from 'vitest'
import type { Page } from 'playwright'
import type SolidWebUI from './index.js'

/** Connection state is exposed as a data attribute so tests never depend on shell copy. */
export async function waitForConnection(page: Page, timeout = 15_000) {
  await page.waitForFunction(
    () => !!document.querySelector('[data-status="connected"]'),
    undefined,
    { timeout },
  )
}

/** Click a sidebar entry, opening the drawer first when the sidebar is collapsed. */
export async function clickNav(page: Page, title: string) {
  const toggle = page.locator('.mobile-menu')
  if (await toggle.isVisible()) {
    await toggle.click()
    await page.locator('.navigation.open').waitFor()
  }
  await page
    .locator('.nav-item')
    .filter({ hasText: new RegExp('^' + title + '$') })
    .first()
    .click()
}

/** Open a registered page from the shell, using the drawer when the sidebar is collapsed. */
export async function openPage(page: Page, title: string) {
  await clickNav(page, title)
  await page
    .locator('.navigation.open')
    .waitFor({ state: 'detached' })
    .catch(() => undefined)
}

/**
 * Drop the server side of the connection and assert the browser resynchronises in place.
 * The transition is observed through mutations rather than polling, because the banner is
 * short-lived and a polled read can miss it entirely.
 */
export async function expectReconnectWithoutReload(
  page: Page,
  webui: SolidWebUI,
) {
  const origin = await page.evaluate(() => performance.timeOrigin)
  await page.evaluate(() => {
    const state = { observed: false }
    ;(window as any).__solidReconnectTest = state
    const target = document.querySelector('.connection-pill')!
    state.observed = target.getAttribute('data-status') === 'reconnecting'
    const observer = new MutationObserver(() => {
      const status = target.getAttribute('data-status')
      if (status === 'reconnecting') state.observed = true
      if (state.observed && status === 'connected') observer.disconnect()
    })
    observer.observe(target, {
      attributes: true,
      attributeFilter: ['data-status'],
    })
  })
  const previous = Object.values(webui.clients)[0]
  expect(previous).toBeDefined()
  previous.socket.close(1012, 'browser reconnect regression')
  await vi.waitFor(
    () => {
      const clients = Object.values(webui.clients)
      expect(clients).toHaveLength(1)
      expect(clients[0].id).not.toBe(previous.id)
    },
    { timeout: 10_000 },
  )
  await page.waitForFunction(
    () =>
      (window as any).__solidReconnectTest.observed &&
      document
        .querySelector('.connection-pill')
        ?.getAttribute('data-status') === 'connected',
  )
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin)
}
