/** @jsxImportSource solid-js */
import {
  batch,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from 'solid-js'
import type {
  ImageStorageDashboardData,
  ImageStorageFilter,
  ImageStorageGroup,
  StickerPackDashboardData,
} from '../src/dashboard-types.js'
import { useRpc, type PageProps } from 'cordis-webui-solidjs/client'
import { sessionToken } from 'cordis-webui-solidjs/session'
import {
  ActionError,
  EmptyState,
  formatBytes,
  LiveContent,
  Modal,
  PageHeader,
  useAction,
} from 'cordis-webui-solidjs/components'

export default function StoragePage(props: PageProps) {
  const rpc = useRpc<ImageStorageDashboardData & StickerPackDashboardData>(
      props.entryId,
    ),
    action = useAction()
  const [account, setAccount] = createSignal(''),
    [conversation, setConversation] = createSignal(''),
    [startDate, setStartDate] = createSignal(''),
    [endDate, setEndDate] = createSignal(''),
    [groupBy, setGroupBy] = createSignal<'conversation' | 'date'>(
      'conversation',
    ),
    [page, setPage] = createSignal(0),
    [token, setToken] = createSignal(sessionToken()),
    [deletion, setDeletion] = createSignal<{
      filter: ImageStorageFilter
      scope: string
      count: number
      bytes: number
    }>()
  const syncToken = () => {
    const current = sessionToken()
    if (current !== token())
      batch(() => {
        setDeletion(undefined)
        setToken(current)
      })
  }
  window.addEventListener('storage', syncToken)
  window.addEventListener('focus', syncToken)
  onCleanup(() => {
    window.removeEventListener('storage', syncToken)
    window.removeEventListener('focus', syncToken)
  })
  const invalidDates = () =>
      !!(startDate() && endDate() && startDate() > endDate()),
    filter = (): ImageStorageFilter => ({
      platformSessionId: account() || undefined,
      conversationId: conversation().trim() || undefined,
      startDate: startDate() || undefined,
      endDate: endDate() || undefined,
    })
  const [result, { refetch }] = createResource(
    () =>
      rpc.ready && !invalidDates()
        ? {
            query: {
              ...filter(),
              groupBy: groupBy(),
              page: page() + 1,
              pageSize: 25,
            },
            token: token(),
          }
        : false,
    ({ query, token }) => rpc.data.getImageStorage(query, token ?? undefined),
  )
  const snapshot = () => (result.error ? undefined : result()),
    busy = () => !rpc.ready || action.busy() || result.loading,
    accountName = (id: string) =>
      rpc.data.stickerAccounts?.find((item) => item.platformSessionId === id)
        ?.displayName ?? id,
    scope = (value: ImageStorageFilter) =>
      [
        value.platformSessionId
          ? 'Account: ' +
            accountName(value.platformSessionId) +
            ' (' +
            value.platformSessionId +
            ')'
          : 'All accounts',
        value.conversationId
          ? 'Conversation: ' + value.conversationId
          : 'All group and private conversations',
        (value.startDate ?? 'Beginning') +
          ' to ' +
          (value.endDate ?? 'present') +
          ' (UTC, inclusive)',
      ].join('\n')
  const requestDeletion = (group?: ImageStorageGroup) => {
    const current = snapshot()
    if (!current || busy() || invalidDates()) return
    const selected: ImageStorageFilter = {
      ...filter(),
      ...(group && { platformSessionId: group.platformSessionId }),
      ...(group?.conversationId && { conversationId: group.conversationId }),
      ...(group?.date && { startDate: group.date, endDate: group.date }),
    }
    action.clear()
    setDeletion({
      filter: selected,
      scope: scope(selected),
      count: group?.count ?? current.count,
      bytes: group?.bytes ?? current.bytes,
    })
  }
  const change = (update: () => void) =>
    batch(() => {
      update()
      setPage(0)
    })
  return (
    <>
      <PageHeader
        title="Image storage"
        description="Manage server copies of message images. Dates use UTC message time."
        actions={
          <button
            class="button outlined"
            disabled={busy() || invalidDates()}
            onClick={() => {
              if (sessionToken() === token()) void refetch()
              else syncToken()
            }}
          >
            Refresh
          </button>
        }
      />
      <ActionError error={action.error()} />
      <LiveContent ready={rpc.ready}>
        <div class="panel stack image-storage">
          <p class="muted">
            New image storage:{' '}
            <strong>
              {rpc.data.imageStorageEnabled ? 'Enabled' : 'Disabled (default)'}
            </strong>
            . Change this in the bridge configuration. Existing copies remain
            available when disabled.
          </p>
          <div class="image-storage-filters">
            <label class="field">
              <span>Account</span>
              <select
                aria-label="Account"
                value={account()}
                disabled={busy()}
                onChange={(event) =>
                  change(() => setAccount(event.currentTarget.value))
                }
              >
                <option value="">All accounts</option>
                <For each={rpc.data.stickerAccounts}>
                  {(item) => (
                    <option value={item.platformSessionId}>
                      {item.displayName} · {item.userId}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <label class="field">
              <span>Conversation ID (group or private)</span>
              <input
                value={conversation()}
                disabled={busy()}
                placeholder="All conversations"
                onChange={(event) =>
                  change(() => setConversation(event.currentTarget.value))
                }
              />
            </label>
            <label class="field">
              <span>Start date (UTC)</span>
              <input
                type="date"
                value={startDate()}
                max={endDate() || undefined}
                disabled={busy()}
                onChange={(event) =>
                  change(() => setStartDate(event.currentTarget.value))
                }
              />
            </label>
            <label class="field">
              <span>End date (UTC, inclusive)</span>
              <input
                type="date"
                value={endDate()}
                min={startDate() || undefined}
                disabled={busy()}
                onChange={(event) =>
                  change(() => setEndDate(event.currentTarget.value))
                }
              />
            </label>
            <label class="field">
              <span>Group by</span>
              <select
                aria-label="Group by"
                value={groupBy()}
                disabled={busy()}
                onChange={(event) =>
                  change(() =>
                    setGroupBy(
                      event.currentTarget.value as 'conversation' | 'date',
                    ),
                  )
                }
              >
                <option value="conversation">Conversation</option>
                <option value="date">Date (UTC)</option>
              </select>
            </label>
          </div>
          <ActionError
            error={
              invalidDates()
                ? 'Start date must be on or before end date.'
                : result.error
                  ? String(result.error)
                  : ''
            }
          />
          <Show when={result.loading}>
            <p role="status">Loading image storage…</p>
          </Show>
          <Show when={!result.loading && !invalidDates() && snapshot()}>
            <div class="toolbar">
              <p class="grow" role="status">
                {snapshot()!.count.toLocaleString()} images ·{' '}
                {formatBytes(snapshot()!.bytes)} (
                {snapshot()!.bytes.toLocaleString()} bytes)
                <Show when={snapshot()!.pendingCount}>
                  {' '}
                  · {snapshot()!.pendingCount} pending
                </Show>
              </p>
              <button
                class="button danger"
                disabled={
                  busy() || !(snapshot()!.count || snapshot()!.pendingCount || snapshot()!.bytes)
                }
                onClick={() => requestDeletion()}
              >
                Delete filtered copies
              </button>
            </div>
            <p class="muted">
              Only server copies are deleted. Messages and original platform
              images are not affected. Pending downloads in the selected range
              are cancelled.
            </p>
            <Show
              when={snapshot()!.groups.length}
              fallback={
                <EmptyState
                  icon="search"
                  title="No stored images in this range"
                  description="Try another account, conversation or UTC date range."
                />
              }
            >
              <div
                class="table-scroll"
                tabindex="0"
                role="region"
                aria-label="Image storage groups"
              >
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Account</th>
                      <th scope="col">
                        {groupBy() === 'date' ? 'Date (UTC)' : 'Conversation'}
                      </th>
                      <th scope="col">Images</th>
                      <th scope="col">Stored size</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={snapshot()!.groups}>
                      {(group) => (
                        <tr>
                          <td>{accountName(group.platformSessionId)}</td>
                          <td>
                            {group.date ??
                              group.conversationTitle ??
                              group.conversationId}
                            <Show when={group.conversationTitle}>
                              <br />
                              <small class="muted">
                                {group.conversationId}
                              </small>
                            </Show>
                          </td>
                          <td>{group.count.toLocaleString()}</td>
                          <td title={group.bytes.toLocaleString() + ' bytes'}>
                            {formatBytes(group.bytes)}
                          </td>
                          <td>
                            <button
                              class="button danger"
                              disabled={busy()}
                              aria-label={
                                'Delete copies for ' +
                                accountName(group.platformSessionId) +
                                ' / ' +
                                (group.date ??
                                  group.conversationTitle ??
                                  group.conversationId)
                              }
                              onClick={() => requestDeletion(group)}
                            >
                              Delete copies
                            </button>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </Show>
            <div class="pagination">
              <button
                class="button outlined"
                disabled={busy() || page() === 0}
                onClick={() => setPage(page() - 1)}
              >
                Previous page
              </button>
              <span>
                Page {page() + 1} of{' '}
                {Math.max(1, Math.ceil(snapshot()!.totalGroups / 25))} ·{' '}
                {snapshot()!.totalGroups} groups
              </span>
              <button
                class="button outlined"
                disabled={
                  busy() || (page() + 1) * 25 >= snapshot()!.totalGroups
                }
                onClick={() => setPage(page() + 1)}
              >
                Next page
              </button>
            </div>
          </Show>
        </div>
      </LiveContent>
      <Show when={deletion()} keyed>
        {(selected) => (
          <Modal
            title="Delete server image copies?"
            onClose={() => {
              if (!action.busy()) setDeletion(undefined)
            }}
          >
            <div class="stack">
              <p class="image-storage-scope">{selected.scope}</p>
              <p>
                {selected.count.toLocaleString()} images ·{' '}
                {formatBytes(selected.bytes)} ({selected.bytes.toLocaleString()}{' '}
                bytes). Pending downloads in this range will also be cancelled.
              </p>
              <p>
                Messages and original platform images will not be deleted.
                Server copies cannot be restored without downloading them again.
              </p>
              <ActionError error={action.error()} />
              <div class="toolbar">
                <button
                  class="button danger"
                  disabled={!rpc.ready || action.busy()}
                  onClick={() =>
                    void action.run(async () => {
                      await rpc.data.deleteImageStorage(
                        selected.filter,
                        sessionToken() ?? undefined,
                      )
                      setDeletion(undefined)
                      if (page() === 0) await refetch()
                      else setPage(0)
                    })
                  }
                >
                  {action.busy() ? 'Deleting…' : 'Delete copies'}
                </button>
                <button
                  class="button outlined"
                  disabled={action.busy()}
                  onClick={() => setDeletion(undefined)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </Modal>
        )}
      </Show>
    </>
  )
}
