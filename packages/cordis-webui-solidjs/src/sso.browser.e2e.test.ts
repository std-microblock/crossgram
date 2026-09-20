import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import Timer from '@cordisjs/plugin-timer'
import Database from '@cordisjs/plugin-database'
import SQLite from '@cordisjs/plugin-database-sqlite'
import SSO, { ChallengeProvider, type Sso } from '@cordisjs/plugin-sso'
import Password from '@cordisjs/plugin-sso-password'
import * as SsoServer from '@cordisjs/plugin-sso-server'
import * as SsoWebui from '@cordisjs/plugin-webui-sso'
import { chromium } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import SolidWebUI from './index.js'

class TestCodeProvider extends ChallengeProvider<
  any,
  any,
  { username: string }
> {
  name = 'test-code'
  canBePrimary = true
  canStepUp = true
  identities = new Map<string, number>()
  async issue(input: any) {
    return {
      challengeId: crypto.randomUUID(),
      response: { shape: 'code' as const, length: 6, digits: true },
      extra: { username: input.username ?? '' },
      data: { instruction: 'Use the test verification code' },
    }
  }
  async verify(_pending: any, input: any) {
    return input.code === '123456'
  }
  async resolve(pending: Sso.Pending<{ username: string }>) {
    const identityId = this.identities.get(pending.extra.username)
    return identityId ? { identityId } : null
  }
  async writeIdentity(
    _userId: number,
    identityId: number,
    pending: Sso.Pending<{ username: string }>,
  ) {
    this.identities.set(pending.extra.username, identityId)
  }
}
describe('Solid SSO with real password, challenge, session and identity backends', () => {
  it('registers, signs out/in, links a code factor, unlinks it, and keeps the final identity protected', async () => {
    const ctx = new Context()
    ctx.baseUrl = new URL('../../../', import.meta.url).href
    const fibers = [
      ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
      ctx.plugin(Timer),
      ctx.plugin(Database),
      ctx.plugin(SQLite, { path: ':memory:' }),
      ctx.plugin(SSO),
      ctx.plugin(Password),
      ctx.plugin(TestCodeProvider),
      ctx.plugin(SsoServer),
      ctx.plugin(SolidWebUI),
      ctx.plugin(SsoWebui),
    ]
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      await Promise.all(fibers)
      await vi.waitFor(() =>
        expect(fibers.every((fiber) => fiber.state === 2)).toBe(true),
      )
      const ui = ctx.get('webui') as unknown as SolidWebUI
      await vi.waitFor(() =>
        expect(Object.values(ui.entries)[0]?.data.providers).toHaveLength(2),
      )
      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      })
      const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        }),
        errors: string[] = [],
        requests: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('request', (request) => requests.push(request.url()))
      await page.goto(ctx.server.baseUrl + '/sso')
      await page.getByRole('tab', { name: 'Register', exact: true }).click()
      await page.getByLabel('Username', { exact: true }).fill('solid-user')
      await page
        .getByLabel('Password', { exact: true })
        .fill('strong-test-password')
      await page
        .getByRole('button', { name: 'Create account', exact: true })
        .click()
      await page.getByText('You are signed in', { exact: true }).waitFor()
      expect(
        await page
          .getByRole('button', { name: 'Unlink', exact: true })
          .isDisabled(),
      ).toBe(true)
      const token = await page.evaluate(() =>
        localStorage.getItem('cordis:webui-sso:token'),
      )
      expect(await ctx.sso.validateSession(token!)).toMatchObject({
        name: 'solid-user',
      })
      await page.getByLabel('Sign-in provider').selectOption('test-code')
      await page.getByLabel('Username', { exact: true }).fill('solid-user')
      await page
        .getByRole('button', { name: 'Link method', exact: true })
        .click()
      await page.getByLabel('Verification code', { exact: true }).fill('123456')
      await page
        .getByRole('button', { name: 'Verify code', exact: true })
        .click()
      await page.getByText('Sign-in method linked', { exact: true }).waitFor()
      expect(await page.locator('.identity-row').count()).toBe(2)
      await page
        .locator('.identity-row')
        .filter({ hasText: 'test-code' })
        .getByRole('button', { name: 'Unlink', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Unlink', exact: true })
        .click()
      await expect.poll(() => page.locator('.identity-row').count()).toBe(1)
      await page.getByRole('button', { name: 'Sign out', exact: true }).click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Sign out', exact: true })
        .click()
      await page.getByRole('heading', { name: 'Welcome back' }).waitFor()
      expect(await ctx.sso.validateSession(token!)).toBeNull()
      await page.getByLabel('Sign-in provider').selectOption('password')
      await page.getByLabel('Username', { exact: true }).fill('solid-user')
      await page
        .getByLabel('Password', { exact: true })
        .fill('incorrect-password')
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await page
        .getByRole('alert')
        .filter({ hasText: 'ACCOUNT_NOT_FOUND' })
        .waitFor()
      await page
        .getByLabel('Password', { exact: true })
        .fill('strong-test-password')
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await page.getByText('You are signed in', { exact: true }).waitFor()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
      expect(requests.some((url) => /assets\/esm-/.test(url))).toBe(false)
      expect(errors).toEqual([])
    } finally {
      await browser?.close()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  }, 60_000)
})
