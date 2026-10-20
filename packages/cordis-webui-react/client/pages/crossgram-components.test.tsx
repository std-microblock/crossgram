import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { AccountCard } from '../../../bridge/client/accounts.js'
import { StatsTable } from '../../../mtproto-statistics/client/page.js'
import { JsonTree } from '../../../mtproto-debug/client/page.js'
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
describe('bounded Crossgram components', () => {
  it('expires credentials without remounting the card and retains failed-avatar fallback across equivalent updates', () => {
    let now = 1000
    let account = {
      platformId: 'test',
      platformKind: 'QQ',
      status: 'ready' as const,
      avatarUrl: '/missing.png',
      displayName: 'Test Account',
      virtualPhone: '+88812345',
      loginCode: '123456',
      validUntil: 3000,
    }
    const view = (props: { now: number; account: typeof account }) => (
      <AccountCard
        account={props.account as any}
        now={props.now}
        connected
        setPassword={async () => {}}
      />
    )
    const { container, rerender } = render(view({ now, account }))
    const card = container.querySelector('article')!
    const copy = () =>
      container.querySelector(
        '[aria-label="Copy login code for test"]',
      ) as HTMLButtonElement
    expect(copy().disabled).toBe(false)
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()
    account = { ...account }
    rerender(view({ now, account }))
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('article')).toBe(card)
    now = 3001
    rerender(view({ now, account }))
    expect(copy().disabled).toBe(true)
    expect(copy().textContent).toBe('------')
  })
  it('renders only one page of large statistics tables and reuses table rows across live snapshots', () => {
    const columns = [
      { label: 'Method', key: 'method' },
      { label: 'Count', key: 'count' },
    ]
    let rows = Array.from({ length: 5000 }, (_, index) => ({
      method: 'method-' + index,
      count: index,
    }))
    const view = () => (
      <StatsTable title="Many methods" rows={rows} columns={columns as any} />
    )
    const { container, rerender } = render(view())
    const first = container.querySelector('tbody tr')!
    expect(container.querySelectorAll('tbody tr')).toHaveLength(25)
    rows = rows.map((row) => ({ ...row, count: row.count + 1 }))
    rerender(view())
    expect(container.querySelector('tbody tr')).toBe(first)
    expect(first.lastElementChild?.textContent).toBe('1')
    fireEvent.change(container.querySelector('input')!, {
      target: { value: 'method-4999' },
    })
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(container.textContent).toContain('method-4999')
  })
  it('retains JSON expansion when a live parent refresh returns the same payload', () => {
    const payload = { result: { message: 'Still expanded' } }
    const { container, rerender } = render(<JsonTree value={payload} />)
    const toggles = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('.json-toggle'))
    const button = toggles().find((node) =>
      node.textContent?.includes('result'),
    )!
    fireEvent.click(button)
    rerender(<JsonTree value={payload} />)
    expect(container.textContent).toContain('Still expanded')
    expect(toggles().find((node) => node.textContent?.includes('result'))).toBe(
      button,
    )
    expect(button.getAttribute('aria-expanded')).toBe('true')
  })
  it('lazily renders large JSON arrays and bounds large scalar previews', () => {
    const large = render(
      <JsonTree value={Array.from({ length: 10_000 }, (_, index) => index)} />,
    )
    const container = large.container
    expect(container.querySelectorAll('.json-value')).toHaveLength(100)
    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Show 100 more'),
      )!,
    )
    expect(container.querySelectorAll('.json-value')).toHaveLength(200)
    fireEvent.click(container.querySelector<HTMLButtonElement>('.json-toggle')!)
    expect(container.querySelectorAll('.json-value')).toHaveLength(0)
    large.unmount()
    const preview = render(<JsonTree value={'x'.repeat(100_000)} />)
    expect(preview.container.textContent!.length).toBeLessThan(1000)
    fireEvent.click(preview.container.querySelector('button')!)
    expect(preview.container.textContent!.length).toBeLessThan(3000)
  })
})
