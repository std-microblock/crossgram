import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from '@testing-library/react'
import type { ReactElement } from 'react'
import { ConnectionContext } from 'cordis-webui-react/client'
import { setSessionToken } from 'cordis-webui-react/session'
import type {
  ImageStorageResult,
  BotDashboardData,
  CrossGramServerConfig,
  PlatformAccountDashboardData,
  StickerPackDashboardData,
} from '../src/dashboard-types.js'
import AccountsPage from './accounts.js'
import BotsPage from './bots.js'
import StickersPage from './stickers.js'
import StoragePage from './storage.js'

/**
 * Minimal stand-in for the WebSocket connection: `useChannel` subscribes through
 * `acquire`/`peek`, and `useRpc` routes methods through `rpc`.
 */
function fakeConnection(entryId: string, value: unknown, methods: string[]) {
  const listeners = new Set<() => void>()
  const state = {
    status: 'connected' as const,
    entries: { [entryId]: { methods } },
    error: '',
    updateAvailable: false,
  }
  let current = { value, ready: true }
  return {
    state,
    peek: () => current,
    acquire: () => ({
      channel: {
        subscribe: (listen: () => void) => {
          listeners.add(listen)
          return () => {
            listeners.delete(listen)
          }
        },
      },
      release: () => {},
    }),
    subscribe: () => () => {},
    getSnapshot: () => state,
    rpc: vi.fn(
      async (
        _entryId: string,
        _method: string,
        _args: unknown[],
      ): Promise<unknown> => undefined,
    ),
    push(next: unknown) {
      current = { value: next, ready: true }
      for (const listen of listeners) listen()
    },
  }
}
type FakeConnection = ReturnType<typeof fakeConnection>

function mount(connection: FakeConnection, page: ReactElement) {
  return render(
    <ConnectionContext.Provider value={connection as never}>
      {page}
    </ConnectionContext.Provider>,
  )
}

afterEach(() => {
  cleanup()
  setSessionToken(null)
  vi.restoreAllMocks()
})

const serverConfig: CrossGramServerConfig = {
  name: 'CrossGram',
  enable_special_config: false,
  host: 'relay.example.test',
  port: 4430,
  rsa_key:
    '-----BEGIN RSA PUBLIC KEY-----\nPLACEHOLDER_KEY\n-----END RSA PUBLIC KEY-----',
  dcs: [{ id: 1, ip: 'relay.example.test', port: 4430 }],
}

function accountsData(): PlatformAccountDashboardData {
  return {
    accounts: [
      {
        platformId: 'qq-main',
        platformKind: 'QQ',
        status: 'ready',
        displayName: 'Main QQ',
        username: 'main',
        virtualPhone: '+888123456789',
        loginCode: '123456',
        validUntil: Date.now() + 30_000,
        hasPassword: false,
      },
      {
        platformId: 'dc-2',
        platformKind: 'Discord',
        status: 'loading',
      },
    ],
    serverConfig,
    loginTokenApprovalUrl: '/api/login-approval',
    updatedAt: 0,
  } as PlatformAccountDashboardData
}

describe('platform accounts page', () => {
  it('renders one card per identity, the readable configuration, and the live login code', () => {
    const connection = fakeConnection('page', accountsData(), [
      'refresh',
      'setLoginPassword',
    ])
    const { container } = mount(
      connection,
      <AccountsPage entryId="page" path="/platform-accounts" />,
    )
    expect(container.textContent).toContain(
      'Your connected identities. Ready for Telegram.',
    )
    expect(container.querySelectorAll('article.identity-card')).toHaveLength(2)
    expect(container.textContent).toContain('Main QQ')
    expect(container.textContent).toContain('Connecting to your platform')
    expect(container.textContent).toContain('+888 123 456 789')
    expect(
      Array.from(container.querySelectorAll('.otp-digits span'))
        .map((node) => node.textContent)
        .join(''),
    ).toBe('123456')
    expect(
      container.querySelector('[aria-label="Copy login code for qq-main"]'),
    ).not.toBeNull()
    const progress = container.querySelector(
      '[role="progressbar"][aria-label="Login code validity"]',
    )!
    expect(Number(progress.getAttribute('aria-valuenow'))).toBeGreaterThan(0)
    expect(progress.getAttribute('aria-valuemax')).toBe('30')
    // The page shows the readable document; only the clipboard copy is single-line.
    const shown = container.querySelector(
      'pre[aria-label="Server configuration"]',
    )!
    expect(shown.textContent!.split('\n').length).toBeGreaterThan(1)
    expect(JSON.parse(shown.textContent!)).toEqual(serverConfig)
  })

  it('copies the single-line configuration and filters accounts without dropping the empty state', async () => {
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined)
    const connection = fakeConnection('page', accountsData(), ['refresh'])
    const { container, getByText } = mount(
      connection,
      <AccountsPage entryId="page" path="/platform-accounts" />,
    )
    fireEvent.click(getByText('Copy server configuration'))
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(serverConfig))
    expect(getByText('Configuration copied')).not.toBeNull()

    const search = container.querySelector('input[type="search"]')!
    fireEvent.change(search, { target: { value: 'nothing-here' } })
    expect(container.textContent).toContain('No matching accounts')
    expect(container.querySelectorAll('article.identity-card')).toHaveLength(0)
    fireEvent.change(search, { target: { value: 'main' } })
    expect(container.querySelectorAll('article.identity-card')).toHaveLength(1)
  })

  it('asks the server to refresh through the entry method', async () => {
    const connection = fakeConnection('page', accountsData(), ['refresh'])
    const { getByText } = mount(
      connection,
      <AccountsPage entryId="page" path="/platform-accounts" />,
    )
    fireEvent.click(getByText('Refresh accounts'))
    await waitFor(() =>
      expect(connection.rpc).toHaveBeenCalledWith('page', 'refresh', []),
    )
  })
})

describe('bots page', () => {
  function botsData(count = 2): BotDashboardData {
    return {
      bots: Array.from({ length: count }, (_, index) => ({
        conversationId: 'c' + index,
        title: 'Helper ' + index,
        username: index === 1 ? 'bad name' : 'helper_bot',
        sourcePlugin: 'bridge',
      })),
      botUpdatedAt: 0,
    } as BotDashboardData
  }

  it('offers Telegram links, reports invalid usernames, and filters bots', () => {
    const connection = fakeConnection('page', botsData(), ['refreshBots'])
    const { container, getByText } = mount(
      connection,
      <BotsPage entryId="page" path="/bots" />,
    )
    expect(container.textContent).toContain('2 bots')
    expect(
      container.querySelector('a[href="https://t.me/helper_bot"]')!.textContent,
    ).toBe('Open in Telegram')
    expect(container.textContent).toContain('This bot has an invalid username.')
    expect(container.querySelectorAll('article.bot-card')).toHaveLength(2)

    fireEvent.change(container.querySelector('input[type="search"]')!, {
      target: { value: 'helper 0' },
    })
    expect(container.querySelectorAll('article.bot-card')).toHaveLength(1)
    expect(container.textContent).toContain('1 bots')

    fireEvent.change(container.querySelector('input[type="search"]')!, {
      target: { value: 'none' },
    })
    expect(container.textContent).toContain('No matching bots')
    expect(getByText('Refresh bots')).not.toBeNull()
  })

  it('keeps the 24-row page window', () => {
    const connection = fakeConnection('page', botsData(30), ['refreshBots'])
    const { container, getByText } = mount(
      connection,
      <BotsPage entryId="page" path="/bots" />,
    )
    expect(container.querySelectorAll('article.bot-card')).toHaveLength(24)
    fireEvent.click(getByText('Next page'))
    expect(container.querySelectorAll('article.bot-card')).toHaveLength(6)
    fireEvent.click(getByText('Previous page'))
    expect(container.querySelectorAll('article.bot-card')).toHaveLength(24)
  })
})

describe('sticker collections page', () => {
  function stickersData(): StickerPackDashboardData {
    return {
      stickerAccounts: [
        {
          platformId: 'qq',
          platformSessionId: 's1',
          platformKind: 'QQ',
          displayName: 'Main QQ',
          userId: '42',
        },
      ],
      stickerPacks: [
        {
          providerId: 'p',
          packId: 'a',
          title: 'Pack A',
          count: 3,
          sourcePlatformSessionId: 's1',
          assignments: [
            { platformSessionId: 's1', assigned: true, automatic: false },
          ],
        },
        {
          providerId: 'p',
          packId: 'b',
          title: 'Pack B',
          assignments: [
            { platformSessionId: 's1', assigned: true, automatic: true },
          ],
        },
        {
          providerId: 'p',
          packId: 'c',
          title: 'Pack C',
          assignments: [
            { platformSessionId: 's1', assigned: false, automatic: false },
          ],
        },
      ],
      stickerUpdatedAt: 0,
    } as StickerPackDashboardData
  }

  it('marks the assigned pack, locks automatic ones, and toggles the rest', async () => {
    const connection = fakeConnection('page', stickersData(), [
      'refreshStickerPacks',
      'setStickerPackAssigned',
    ])
    const { container, getByText } = mount(
      connection,
      <StickersPage entryId="page" path="/sticker-packs" />,
    )
    const select = container.querySelector('select') as HTMLSelectElement
    expect(select.value).toBe('s1')
    expect(container.querySelectorAll('article.sticker-card')).toHaveLength(3)
    const [assigned, automatic, free] = Array.from(
      container.querySelectorAll('article.sticker-card'),
    )
    expect(assigned.className).toBe('panel sticker-card assigned')
    expect(assigned.getAttribute('data-pack')).toBe('a')
    expect(assigned.querySelector('button')!.textContent).toBe('Added · remove')
    const automaticButton = automatic.querySelector('button')!
    expect(automaticButton.textContent).toBe('Automatically assigned')
    expect((automaticButton as HTMLButtonElement).disabled).toBe(true)
    expect(automaticButton.getAttribute('aria-label')).toBe(
      'Automatically assigned Pack B',
    )
    expect(free.querySelector('button')!.getAttribute('aria-label')).toBe(
      'Add Pack C',
    )
    fireEvent.click(getByText('Add to account'))
    await waitFor(() =>
      expect(connection.rpc).toHaveBeenCalledWith(
        'page',
        'setStickerPackAssigned',
        ['s1', 'p', 'c', true],
      ),
    )
    expect(container.textContent).toContain('3 stickers')
    expect(container.textContent).toContain('From Main QQ')
  })

  it('filters collections and reports an empty search', () => {
    const connection = fakeConnection('page', stickersData(), [
      'refreshStickerPacks',
    ])
    const { container } = mount(
      connection,
      <StickersPage entryId="page" path="/sticker-packs" />,
    )
    fireEvent.change(container.querySelector('input[type="search"]')!, {
      target: { value: 'pack c' },
    })
    expect(container.querySelectorAll('article.sticker-card')).toHaveLength(1)
    expect(container.textContent).toContain('1 collections')
    fireEvent.change(container.querySelector('input[type="search"]')!, {
      target: { value: 'zzz' },
    })
    expect(container.textContent).toContain('No matching collections')
  })
})

describe('image storage page', () => {
  function storageResult(
    title = 'Stored group',
    count = 1,
    bytes = 1024,
  ): ImageStorageResult {
    return {
      count,
      bytes,
      pendingCount: 0,
      groups: bytes
        ? [
            {
              platformSessionId: 's1',
              conversationId: 'group-1',
              conversationTitle: title,
              count,
              bytes,
            },
          ]
        : [],
      totalGroups: 26,
      page: 1,
      pageSize: 25,
    }
  }

  function storageConnection() {
    return fakeConnection(
      'page',
      {
        imageStorageEnabled: false,
        stickerAccounts: [
          { platformSessionId: 's1', displayName: 'Main QQ', userId: '42' },
        ],
      },
      ['getImageStorage', 'deleteImageStorage'],
    )
  }

  it('commits conversation text on blur, resets pagination, and ignores superseded filter responses', async () => {
    setSessionToken('member')
    const connection = storageConnection()
    connection.rpc.mockResolvedValue(storageResult())
    const { container, getByRole, getByLabelText } = mount(
      connection,
      <StoragePage entryId="page" path="/image-storage" />,
    )
    await waitFor(() => expect(container.textContent).toContain('Stored group'))
    fireEvent.click(getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(container.textContent).toContain('Page 2 of 2'))
    fireEvent.change(getByLabelText('Account'), { target: { value: 's1' } })
    await waitFor(() => expect(container.textContent).toContain('Page 1 of 2'))
    expect(connection.rpc).toHaveBeenLastCalledWith('page', 'getImageStorage', [
      {
        platformSessionId: 's1',
        groupBy: 'conversation',
        page: 1,
        pageSize: 25,
      },
      'member',
    ])

    const first = Promise.withResolvers<ImageStorageResult>(),
      latest = Promise.withResolvers<ImageStorageResult>(),
      input = getByLabelText(
        'Conversation ID (group or private)',
      ) as HTMLInputElement,
      beforeTyping = connection.rpc.mock.calls.length
    connection.rpc
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise)
    fireEvent.change(input, { target: { value: 'old' } })
    expect(input.disabled).toBe(false)
    expect(connection.rpc).toHaveBeenCalledTimes(beforeTyping)
    fireEvent.blur(input)
    expect(connection.rpc).toHaveBeenLastCalledWith('page', 'getImageStorage', [
      {
        platformSessionId: 's1',
        conversationId: 'old',
        groupBy: 'conversation',
        page: 1,
        pageSize: 25,
      },
      'member',
    ])
    expect(container.textContent).not.toContain('Stored group')
    expect(input.disabled).toBe(false)
    fireEvent.change(input, { target: { value: ' new ' } })
    fireEvent.blur(input)
    expect(connection.rpc).toHaveBeenLastCalledWith('page', 'getImageStorage', [
      {
        platformSessionId: 's1',
        conversationId: 'new',
        groupBy: 'conversation',
        page: 1,
        pageSize: 25,
      },
      'member',
    ])
    await act(async () => latest.resolve(storageResult('Newest group', 2)))
    expect(container.textContent).toContain('Newest group')
    await act(async () => first.resolve(storageResult('Obsolete group', 99)))
    expect(container.textContent).toContain('Newest group')
    expect(container.textContent).not.toContain('Obsolete group')
  })

  it('clears old rows and confirmation on token switch and logout, including late responses', async () => {
    setSessionToken('first-member')
    const connection = storageConnection()
    connection.rpc.mockResolvedValue(storageResult('First member group'))
    const { container, getByRole, queryByRole } = mount(
      connection,
      <StoragePage entryId="page" path="/image-storage" />,
    )
    await waitFor(() =>
      expect(container.textContent).toContain('First member group'),
    )
    fireEvent.click(getByRole('button', { name: 'Delete filtered copies' }))
    const first = Promise.withResolvers<ImageStorageResult>(),
      second = Promise.withResolvers<ImageStorageResult>()
    connection.rpc
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    fireEvent.click(getByRole('button', { name: 'Refresh' }))
    act(() => {
      setSessionToken('second-member')
      window.dispatchEvent(new Event('focus'))
    })
    expect(queryByRole('dialog')).toBeNull()
    expect(container.textContent).not.toContain('First member group')
    expect(connection.rpc).toHaveBeenLastCalledWith('page', 'getImageStorage', [
      { groupBy: 'conversation', page: 1, pageSize: 25 },
      'second-member',
    ])
    await act(async () =>
      second.resolve(storageResult('Second member group', 2)),
    )
    fireEvent.click(getByRole('button', { name: 'Delete filtered copies' }))
    await act(async () =>
      first.resolve(storageResult('Late first member group', 99)),
    )
    expect(container.textContent).toContain('Second member group')
    expect(container.textContent).not.toContain('Late first member group')
    expect(getByRole('dialog').textContent).toContain('2 images')

    const late = Promise.withResolvers<ImageStorageResult>()
    connection.rpc
      .mockReturnValueOnce(late.promise)
      .mockRejectedValueOnce(new Error('Sign in required'))
    fireEvent.click(getByRole('button', { name: 'Refresh' }))
    act(() => {
      setSessionToken(null)
      window.dispatchEvent(new Event('storage'))
    })
    expect(queryByRole('dialog')).toBeNull()
    expect(container.textContent).not.toContain('Second member group')
    await waitFor(() =>
      expect(getByRole('alert').textContent).toContain('Sign in required'),
    )
    await act(async () =>
      late.resolve(storageResult('Late second member group', 88)),
    )
    expect(queryByRole('dialog')).toBeNull()
    expect(queryByRole('button', { name: 'Delete filtered copies' })).toBeNull()
    expect(container.textContent).not.toContain('Late second member group')
    expect(connection.rpc).toHaveBeenLastCalledWith('page', 'getImageStorage', [
      { groupBy: 'conversation', page: 1, pageSize: 25 },
      undefined,
    ])
  })

  it('does not leak a late deletion error after switching away from and back to a token', async () => {
    setSessionToken('member')
    const connection = storageConnection()
    connection.rpc.mockResolvedValue(storageResult())
    const { container, getByRole, queryByRole } = mount(
      connection,
      <StoragePage entryId="page" path="/image-storage" />,
    )
    await waitFor(() => expect(container.textContent).toContain('Stored group'))
    fireEvent.click(getByRole('button', { name: 'Delete filtered copies' }))
    const deletion = Promise.withResolvers<ImageStorageResult>()
    connection.rpc.mockReturnValueOnce(deletion.promise)
    fireEvent.click(
      within(getByRole('dialog')).getByRole('button', {
        name: 'Delete copies',
      }),
    )
    act(() => {
      setSessionToken('other-member')
      window.dispatchEvent(new Event('storage'))
    })
    expect(queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(container.textContent).toContain('Stored group'))
    act(() => {
      setSessionToken('member')
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(container.textContent).toContain('Stored group'))
    await act(async () => deletion.reject(new Error('Obsolete deletion error')))
    expect(queryByRole('alert')).toBeNull()
    expect(queryByRole('dialog')).toBeNull()
    expect(container.textContent).toContain('Stored group')
    fireEvent.click(getByRole('button', { name: 'Delete filtered copies' }))
    expect(getByRole('dialog').textContent).toContain('1 images')
  })

  it('allows preview-only cleanup, cancellation, error retry, and deletion with the latest token', async () => {
    setSessionToken('member')
    const connection = storageConnection()
    connection.rpc.mockResolvedValue(storageResult('Preview only', 0, 200))
    const { container, getByRole, queryByRole } = mount(
      connection,
      <StoragePage entryId="page" path="/image-storage" />,
    )
    await waitFor(() => expect(container.textContent).toContain('Preview only'))
    const remove = getByRole('button', {
      name: 'Delete filtered copies',
    }) as HTMLButtonElement
    expect(remove.disabled).toBe(false)
    fireEvent.click(remove)
    expect(getByRole('dialog').textContent).toContain(
      '0 images · 200 B (200 bytes)',
    )
    fireEvent.click(
      within(getByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    )
    expect(
      connection.rpc.mock.calls.some(
        (call) => call[1] === 'deleteImageStorage',
      ),
    ).toBe(false)

    fireEvent.click(remove)
    setSessionToken('fresh-member')
    connection.rpc.mockRejectedValueOnce(new Error('Storage deletion failed'))
    fireEvent.click(
      within(getByRole('dialog')).getByRole('button', {
        name: 'Delete copies',
      }),
    )
    await waitFor(() =>
      expect(
        within(getByRole('dialog')).getByRole('alert').textContent,
      ).toContain('Storage deletion failed'),
    )
    expect(connection.rpc).toHaveBeenLastCalledWith(
      'page',
      'deleteImageStorage',
      [{}, 'fresh-member'],
    )
    connection.rpc.mockResolvedValue(storageResult('', 0, 0))
    fireEvent.click(
      within(getByRole('dialog')).getByRole('button', {
        name: 'Delete copies',
      }),
    )
    await waitFor(() => expect(queryByRole('dialog')).toBeNull())
    await waitFor(() =>
      expect(container.textContent).toContain('No stored images in this range'),
    )
    expect(
      (
        getByRole('button', {
          name: 'Delete filtered copies',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    expect(connection.rpc).toHaveBeenLastCalledWith('page', 'getImageStorage', [
      { groupBy: 'conversation', page: 1, pageSize: 25 },
      'fresh-member',
    ])
  })
})
