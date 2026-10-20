import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { ConnectionContext } from 'cordis-webui-react/client'
import type {
  BackfillConversationSnapshot,
  BackfillSessionSnapshot,
  BackfillSnapshot,
  HistoryBackfillData,
} from '../src/types.js'
import HistoryBackfillPage, { BackfillDashboard } from './page.js'

/** Stand-in connection: `useChannel` reads through `peek`/`acquire`, methods go to `rpc`. */
function fakeConnection(entryId: string, value: unknown, methods: string[]) {
  const state = {
    status: 'connected' as const,
    entries: { [entryId]: { methods } },
    error: '',
    updateAvailable: false,
  }
  // `useSyncExternalStore` compares snapshots by identity, so keep one object.
  const current = { value, ready: true }
  return {
    state,
    peek: () => current,
    acquire: () => ({
      channel: { subscribe: () => () => {} },
      release: () => {},
    }),
    subscribe: () => () => {},
    getSnapshot: () => state,
    rpc: vi.fn(async () => {}),
  }
}

function mount(
  connection: ReturnType<typeof fakeConnection>,
  page: ReactElement,
) {
  return render(
    <ConnectionContext.Provider value={connection as never}>
      {page}
    </ConnectionContext.Provider>,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const complete: BackfillConversationSnapshot = {
  conversationId: 'c1',
  title: 'Group A',
  kind: 'group',
  mode: 'sequence',
  bootstrapped: true,
  spans: 1,
  covered: 10,
  minSequence: 1,
  maxSequence: 10,
  gapCount: 0,
  missing: 0,
  floorReached: true,
  floorReason: 'start',
  oldestTimestamp: 1_700_000_000,
  requests: 1,
  fetched: 10,
  inserted: 5,
  failures: 0,
}
const pending: BackfillConversationSnapshot = {
  ...complete,
  conversationId: 'c2',
  title: 'Group B',
  floorReached: false,
  floorReason: undefined,
  gapCount: 2,
  missing: 7,
  failures: 1,
  lastError: 'rate limited',
  nextAttemptAt: 1_800_000_000_000,
}
const session: BackfillSessionSnapshot = {
  platformSessionId: 'qq:1',
  platformId: 'qq',
  status: 'capped',
  lastActivityAt: 1_800_000_000_000,
  requestsToday: 12,
  dailyRequestCap: 200,
  totals: {
    conversations: 2,
    complete: 1,
    gaps: 2,
    missing: 7,
    fetched: 20,
    inserted: 9,
  },
  conversations: [complete, pending],
}
const snapshot: BackfillSnapshot = {
  enabled: false,
  busy: false,
  settings: {
    idleAfterMs: 60_000,
    intervalMs: 2_500,
    pageSize: 100,
    dailyRequestCap: 200,
    maxAgeDays: 30,
  },
  sessions: [session],
  recent: [
    {
      at: 1_800_000_000_000,
      platformSessionId: 'qq:1',
      conversationId: 'c1',
      title: 'Group A',
      mode: 'sequence',
      kind: 'gap',
      range: '1–10',
      fetched: 10,
      inserted: 5,
    },
  ],
}

describe('history backfill dashboard', () => {
  it('describes the schedule, totals, and per-conversation progress', () => {
    const data = {
      resetConversation: vi.fn(async () => {}),
    } as unknown as HistoryBackfillData
    const { container } = render(
      <BackfillDashboard snapshot={snapshot} data={data} />,
    )
    expect(container.textContent).toContain('Paused')
    expect(container.textContent).toContain('idle after 60s')
    expect(container.textContent).toContain('one request every ≥2.5s')
    expect(container.textContent).toContain('100 messages per request')
    expect(container.textContent).toContain('up to 30 days back')
    expect(container.textContent).toContain('progress is kept in memory')
    expect(container.textContent).toContain('Daily request limit reached')
    expect(container.textContent).toContain('1 fully backfilled')
    expect(container.textContent).toContain('7 sequence numbers missing')
    expect(container.textContent).toContain('Recent requests')
    expect(container.textContent).toContain('gap · sequence')
    expect(container.textContent).toContain('Group A')
    expect(container.textContent).toContain('seq 1–10 · 10 covered')
    // Only the unfinished conversation is listed under the default filter.
    const conversationTable = container.querySelectorAll('table')[0]
    expect(conversationTable.querySelectorAll('tbody tr')).toHaveLength(1)
  })

  it('switches between pending and all conversations without losing the retry action', async () => {
    const resetConversation = vi.fn(async () => {})
    const data = { resetConversation } as unknown as HistoryBackfillData
    const { container, getByText } = render(
      <BackfillDashboard snapshot={snapshot} data={data} />,
    )
    const tables = container.querySelectorAll('table')
    const conversationRows = () => tables[0].querySelectorAll('tbody tr')
    // The first table is the conversation list, the second one the recent requests.
    expect(conversationRows()).toHaveLength(1)
    expect(conversationRows()[0].textContent).toContain('Group B')
    fireEvent.click(getByText('All'))
    expect(conversationRows()).toHaveLength(2)
    fireEvent.click(getByText('Pending'))
    expect(conversationRows()).toHaveLength(1)
    fireEvent.click(getByText('Retry'))
    await waitFor(() =>
      expect(resetConversation).toHaveBeenCalledWith('qq:1', 'c2'),
    )
  })

  it('explains that backfill waits for an account when no session exists', () => {
    const data = {} as HistoryBackfillData
    const { container } = render(
      <BackfillDashboard
        snapshot={{ ...snapshot, sessions: [], recent: [] }}
        data={data}
      />,
    )
    expect(container.textContent).toContain('No active accounts')
    expect(container.textContent).toContain(
      'Backfill starts once a platform account is online.',
    )
    expect(container.textContent).not.toContain('Recent requests')
  })
})

describe('history backfill page', () => {
  it('starts and pauses backfill through the entry method', async () => {
    const value = {
      snapshot,
      setEnabled: async () => {},
      resetConversation: async () => {},
    } as unknown as HistoryBackfillData
    const connection = fakeConnection('page', value, [
      'setEnabled',
      'resetConversation',
    ])
    const { getByText, unmount } = mount(
      connection,
      <HistoryBackfillPage entryId="page" path="/history-backfill" />,
    )
    fireEvent.click(getByText('Start backfill'))
    await waitFor(() =>
      expect(connection.rpc).toHaveBeenCalledWith('page', 'setEnabled', [true]),
    )
    unmount()
    connection.rpc.mockClear()
    const running = fakeConnection(
      'page',
      { ...value, snapshot: { ...snapshot, enabled: true } },
      ['setEnabled'],
    )
    const second = mount(
      running,
      <HistoryBackfillPage entryId="page" path="/history-backfill" />,
    )
    fireEvent.click(second.getByText('Pause backfill'))
    await waitFor(() =>
      expect(running.rpc).toHaveBeenCalledWith('page', 'setEnabled', [false]),
    )
  })
})
