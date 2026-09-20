import { expect, vi } from 'vitest'
import type { Page } from 'playwright'
import type SolidWebUI from './index.js'
/** Observe the transient DOM state before closing the socket; polling can miss a fast reconnect. */
export async function expectReconnectWithoutReload(
  page: Page,
  webui: SolidWebUI,
) {
  const origin = await page.evaluate(() => performance.timeOrigin)
  await page.evaluate(() => {
    const state = { observed: false }
    ;(window as any).__solidReconnectTest = state
    const target = document.querySelector('.connection-pill')!
    const observer = new MutationObserver(() => {
      if (target.textContent?.includes('reconnecting')) state.observed = true
      if (state.observed && target.textContent?.trim() === 'connected')
        observer.disconnect()
    })
    observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
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
      document.querySelector('.connection-pill')?.textContent?.trim() ===
        'connected',
  )
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin)
}
