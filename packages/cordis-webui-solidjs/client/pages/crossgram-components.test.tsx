/** @jsxImportSource solid-js */
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountCard } from '../../../bridge/client/accounts.js'
import { StatsTable } from '../../../mtproto-statistics/client/page.js'
import { JsonTree } from '../../../mtproto-debug/client/page.js'
const disposers: (() => void)[] = []
function mount(component: () => any) {
  const root = document.createElement('div')
  document.body.append(root)
  disposers.push(render(component, root))
  return root
}
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})
describe('bounded Crossgram components', () => {
  it('expires credentials without remounting the card and retains failed-avatar fallback across equivalent updates', () => {
    const [now, setNow] = createSignal(1000),
      [account, setAccount] = createSignal({
        platformId: 'test',
        platformKind: 'QQ',
        status: 'ready' as const,
        avatarUrl: '/missing.png',
        displayName: 'Test Account',
        virtualPhone: '+88812345',
        loginCode: '123456',
        validUntil: 3000,
      })
    const root = mount(() => (
      <AccountCard account={account()} now={now()} connected />
    ))
    const card = root.querySelector('article')!,
      copy = root.querySelector(
        '[aria-label="Copy login code for test"]',
      ) as HTMLButtonElement
    expect(copy.disabled).toBe(false)
    root.querySelector('img')!.dispatchEvent(new Event('error'))
    expect(root.querySelector('img')).toBeNull()
    setAccount((value) => ({ ...value }))
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('article')).toBe(card)
    setNow(3001)
    expect(copy.disabled).toBe(true)
    expect(copy.textContent).toBe('------')
  })
  it('renders only one page of large statistics tables and reuses table rows across live snapshots', () => {
    const [rows, setRows] = createSignal(
      Array.from({ length: 5000 }, (_, index) => ({
        method: 'method-' + index,
        count: index,
      })),
    )
    const root = mount(() => (
      <StatsTable
        title="Many methods"
        rows={rows()}
        columns={[
          { label: 'Method', key: 'method' },
          { label: 'Count', key: 'count' },
        ]}
      />
    ))
    const first = root.querySelector('tbody tr')!
    expect(root.querySelectorAll('tbody tr')).toHaveLength(25)
    setRows((value) => value.map((row) => ({ ...row, count: row.count + 1 })))
    expect(root.querySelector('tbody tr')).toBe(first)
    expect(first.lastElementChild?.textContent).toBe('1')
    const input = root.querySelector('input')!
    input.value = 'method-4999'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(root.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(root.textContent).toContain('method-4999')
  })
  it('retains JSON expansion when a live parent refresh returns the same payload', () => {
    const payload = { result: { message: 'Still expanded' } }
    const [event, setEvent] = createSignal({ payload })
    const root = mount(() => <JsonTree value={event().payload} />)
    const button = Array.from(
      root.querySelectorAll<HTMLButtonElement>('.json-toggle'),
    ).find((button) => button.textContent?.includes('result'))!
    button.click()
    setEvent({ payload })
    expect(root.textContent).toContain('Still expanded')
    expect(
      Array.from(root.querySelectorAll('.json-toggle')).find((node) =>
        node.textContent?.includes('result'),
      ),
    ).toBe(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
  })
  it('lazily renders large JSON arrays and bounds large scalar previews', () => {
    const root = mount(() => (
      <JsonTree value={Array.from({ length: 10_000 }, (_, index) => index)} />
    ))
    expect(root.querySelectorAll('.json-leaf')).toHaveLength(30)
    Array.from(root.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Show 30 more'))!
      .click()
    expect(root.querySelectorAll('.json-leaf')).toHaveLength(60)
    root.querySelector<HTMLButtonElement>('.json-toggle')!.click()
    expect(root.querySelectorAll('.json-leaf')).toHaveLength(0)
    const large = mount(() => <JsonTree value={'x'.repeat(100_000)} />)
    expect(large.textContent!.length).toBeLessThan(1000)
    large.querySelector('button')!.click()
    expect(large.textContent!.length).toBeLessThan(3000)
  })
})
