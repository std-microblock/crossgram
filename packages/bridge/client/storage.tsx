import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ImageStorageDashboardData,
  ImageStorageFilter,
  ImageStorageGroup,
  StickerPackDashboardData,
} from '../src/dashboard-types.js'
import { useRpc, type PageProps } from 'cordis-webui-react/client'
import { sessionToken } from 'cordis-webui-react/session'
import {
  ActionError,
  EmptyState,
  formatBytes,
  LiveContent,
  Modal,
  PageHeader,
  useAction,
  useAsync,
} from 'cordis-webui-react/components'

export default function StoragePage(props: PageProps) {
  const rpc = useRpc<ImageStorageDashboardData & StickerPackDashboardData>(
      props.entryId,
    ),
    action = useAction()
  const [account, setAccount] = useState(''),
    [conversation, setConversation] = useState(''),
    [startDate, setStartDate] = useState(''),
    [endDate, setEndDate] = useState(''),
    [groupBy, setGroupBy] = useState<'conversation' | 'date'>('conversation'),
    [page, setPage] = useState(0),
    [token, setToken] = useState(sessionToken),
    [deletion, setDeletion] = useState<{
      filter: ImageStorageFilter
      scope: string
      count: number
      bytes: number
    }>()
  const generation = useRef(0)
  useEffect(
    () => () => {
      generation.current++
    },
    [],
  )
  const syncToken = useCallback(() => {
    const next = sessionToken()
    if (next !== token) {
      generation.current++
      setDeletion(undefined)
      action.clear()
      setToken(next)
    }
  }, [token, action.clear])
  useEffect(() => {
    window.addEventListener('storage', syncToken)
    window.addEventListener('focus', syncToken)
    return () => {
      window.removeEventListener('storage', syncToken)
      window.removeEventListener('focus', syncToken)
    }
  }, [syncToken])
  const invalidDates = !!(startDate && endDate && startDate > endDate),
    filter: ImageStorageFilter = {
      platformSessionId: account || undefined,
      conversationId: conversation.trim() || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    }
  const query = useMemo(
    () => ({
      platformSessionId: account || undefined,
      conversationId: conversation.trim() || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      groupBy,
      page: page + 1,
      pageSize: 25,
    }),
    [account, conversation, startDate, endDate, groupBy, page],
  )
  const result = useAsync(
    async () =>
      rpc.ready && !invalidDates
        ? {
            token,
            query,
            value: await rpc.data.getImageStorage(query, token ?? undefined),
          }
        : undefined,
    [rpc.ready, invalidDates, query, token],
  )
  const snapshot =
      !result.error &&
      !invalidDates &&
      result.data?.token === token &&
      result.data?.query === query
        ? result.data.value
        : undefined,
    busy = !rpc.ready || action.busy || result.loading,
    controlsDisabled = !rpc.ready || action.busy,
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
    if (!snapshot || busy || invalidDates) return
    const selected: ImageStorageFilter = {
      ...filter,
      ...(group && { platformSessionId: group.platformSessionId }),
      ...(group?.conversationId && { conversationId: group.conversationId }),
      ...(group?.date && { startDate: group.date, endDate: group.date }),
    }
    action.clear()
    setDeletion({
      filter: selected,
      scope: scope(selected),
      count: group?.count ?? snapshot.count,
      bytes: group?.bytes ?? snapshot.bytes,
    })
  }
  const change = (update: () => void) => {
    update()
    setPage(0)
  }
  return (
    <>
      <PageHeader
        title="Image storage"
        description="Manage server copies of message images. Dates use UTC message time."
        actions={
          <button
            className="button outlined"
            disabled={busy || invalidDates}
            onClick={() => {
              if (sessionToken() === token) result.reload()
              else syncToken()
            }}
          >
            Refresh
          </button>
        }
      />
      <ActionError error={action.error} />
      <LiveContent ready={rpc.ready}>
        <div className="panel stack image-storage">
          <p className="muted">
            New image storage:{' '}
            <strong>
              {rpc.data.imageStorageEnabled ? 'Enabled' : 'Disabled (default)'}
            </strong>
            . Change this in the bridge configuration. Existing copies remain
            available when disabled.
          </p>
          <div className="image-storage-filters">
            <label className="field">
              <span>Account</span>
              <select
                aria-label="Account"
                value={account}
                disabled={controlsDisabled}
                onChange={(event) =>
                  change(() => setAccount(event.currentTarget.value))
                }
              >
                <option value="">All accounts</option>
                {(rpc.data.stickerAccounts ?? []).map((item) => (
                  <option
                    key={item.platformSessionId}
                    value={item.platformSessionId}
                  >
                    {item.displayName} · {item.userId}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Conversation ID (group or private)</span>
              <input
                defaultValue={conversation}
                disabled={controlsDisabled}
                placeholder="All conversations"
                onBlur={(event) =>
                  change(() => setConversation(event.currentTarget.value))
                }
              />
            </label>
            <label className="field">
              <span>Start date (UTC)</span>
              <input
                type="date"
                value={startDate}
                max={endDate || undefined}
                disabled={controlsDisabled}
                onChange={(event) =>
                  change(() => setStartDate(event.currentTarget.value))
                }
              />
            </label>
            <label className="field">
              <span>End date (UTC, inclusive)</span>
              <input
                type="date"
                value={endDate}
                min={startDate || undefined}
                disabled={controlsDisabled}
                onChange={(event) =>
                  change(() => setEndDate(event.currentTarget.value))
                }
              />
            </label>
            <label className="field">
              <span>Group by</span>
              <select
                aria-label="Group by"
                value={groupBy}
                disabled={controlsDisabled}
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
              invalidDates
                ? 'Start date must be on or before end date.'
                : result.error
                  ? String(result.error)
                  : ''
            }
          />
          {result.loading ? <p role="status">Loading image storage…</p> : null}
          {!result.loading && snapshot ? (
            <>
              <div className="toolbar">
                <p className="grow" role="status">
                  {snapshot.count.toLocaleString()} images ·{' '}
                  {formatBytes(snapshot.bytes)} (
                  {snapshot.bytes.toLocaleString()} bytes)
                  {snapshot.pendingCount ? (
                    <> · {snapshot.pendingCount} pending</>
                  ) : null}
                </p>
                <button
                  className="button danger"
                  disabled={
                    busy ||
                    !(snapshot.count || snapshot.pendingCount || snapshot.bytes)
                  }
                  onClick={() => requestDeletion()}
                >
                  Delete filtered copies
                </button>
              </div>
              <p className="muted">
                Only server copies are deleted. Messages and original platform
                images are not affected. Pending downloads in the selected range
                are cancelled.
              </p>
              {snapshot.groups.length ? (
                <div
                  className="table-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label="Image storage groups"
                >
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Account</th>
                        <th scope="col">
                          {groupBy === 'date' ? 'Date (UTC)' : 'Conversation'}
                        </th>
                        <th scope="col">Images</th>
                        <th scope="col">Stored size</th>
                        <th scope="col">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.groups.map((group) => (
                        <tr
                          key={
                            group.platformSessionId +
                            '/' +
                            (group.date ?? group.conversationId)
                          }
                        >
                          <td>{accountName(group.platformSessionId)}</td>
                          <td>
                            {group.date ??
                              group.conversationTitle ??
                              group.conversationId}
                            {group.conversationTitle ? (
                              <>
                                <br />
                                <small className="muted">
                                  {group.conversationId}
                                </small>
                              </>
                            ) : null}
                          </td>
                          <td>{group.count.toLocaleString()}</td>
                          <td title={group.bytes.toLocaleString() + ' bytes'}>
                            {formatBytes(group.bytes)}
                          </td>
                          <td>
                            <button
                              className="button danger"
                              disabled={busy}
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
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState
                  icon="search"
                  title="No stored images in this range"
                  description="Try another account, conversation or UTC date range."
                />
              )}
              <div className="pagination">
                <button
                  className="button outlined"
                  disabled={busy || page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  Previous page
                </button>
                <span>
                  Page {page + 1} of{' '}
                  {Math.max(1, Math.ceil(snapshot.totalGroups / 25))} ·{' '}
                  {snapshot.totalGroups} groups
                </span>
                <button
                  className="button outlined"
                  disabled={busy || (page + 1) * 25 >= snapshot.totalGroups}
                  onClick={() => setPage(page + 1)}
                >
                  Next page
                </button>
              </div>
            </>
          ) : null}
        </div>
      </LiveContent>
      {deletion ? (
        <Modal
          title="Delete server image copies?"
          onClose={() => {
            if (!action.busy) setDeletion(undefined)
          }}
        >
          <div className="stack">
            <p className="image-storage-scope">{deletion.scope}</p>
            <p>
              {deletion.count.toLocaleString()} images ·{' '}
              {formatBytes(deletion.bytes)} ({deletion.bytes.toLocaleString()}{' '}
              bytes). Pending downloads in this range will also be cancelled.
            </p>
            <p>
              Messages and original platform images will not be deleted. Server
              copies cannot be restored without downloading them again.
            </p>
            <ActionError error={action.error} />
            <div className="toolbar">
              <button
                className="button danger"
                disabled={!rpc.ready || action.busy}
                onClick={() =>
                  void action.run(async () => {
                    const version = generation.current
                    try {
                      await rpc.data.deleteImageStorage(
                        deletion.filter,
                        sessionToken() ?? undefined,
                      )
                    } catch (error) {
                      if (generation.current === version) throw error
                      return
                    }
                    if (generation.current !== version) return
                    setDeletion(undefined)
                    if (sessionToken() !== token) syncToken()
                    else if (page === 0) result.reload()
                    if (page !== 0) setPage(0)
                  })
                }
              >
                {action.busy ? 'Deleting…' : 'Delete copies'}
              </button>
              <button
                className="button outlined"
                disabled={action.busy}
                onClick={() => setDeletion(undefined)}
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  )
}
