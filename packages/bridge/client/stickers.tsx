import { useEffect, useState } from 'react'
import type { StickerPackDashboardData } from '../src/dashboard-types.js'
import { useRpc, type PageProps } from 'cordis-webui-react/client'
import { Icon } from 'cordis-webui-react/icons'
import {
  ActionError,
  EmptyState,
  LiveContent,
  PageHeader,
  useAction,
} from 'cordis-webui-react/components'
export default function StickersPage(props: PageProps) {
  const rpc = useRpc<StickerPackDashboardData>(props.entryId),
    action = useAction()
  const [selected, setSelected] = useState(''),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(0)
  const stickerAccounts = rpc.data.stickerAccounts ?? []
  useEffect(() => {
    if (
      rpc.ready &&
      !stickerAccounts.some((account) => account.platformSessionId === selected)
    )
      setSelected(stickerAccounts[0]?.platformSessionId ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc.ready, rpc.data.stickerAccounts, selected])
  const packs = new Map(
    (rpc.data.stickerPacks ?? []).map((pack) => [
      JSON.stringify([pack.providerId, pack.packId]),
      pack,
    ]),
  )
  const ids = [...packs.keys()].filter((key) => {
    const pack = packs.get(key)!
    return (pack.title + ' ' + pack.providerId + ' ' + pack.packId)
      .toLowerCase()
      .includes(search.toLowerCase())
  })
  return (
    <>
      <PageHeader
        title="Sticker collections"
        description="Choose the collections that make each account feel like yours."
        actions={
          <button
            className="button outlined"
            disabled={action.busy || !rpc.ready}
            onClick={() =>
              void action.run(() => rpc.data.refreshStickerPacks())
            }
          >
            Refresh collections
          </button>
        }
      />
      <ActionError error={action.error} />
      <LiveContent ready={rpc.ready}>
        <div className="panel toolbar sticker-controls">
          <label className="field grow">
            <span>Assign to account</span>
            <select
              aria-label="Assign to account"
              value={selected}
              onChange={(event) => setSelected(event.currentTarget.value)}
            >
              {stickerAccounts.map((account) => (
                <option
                  key={account.platformSessionId}
                  value={account.platformSessionId}
                >
                  {account.displayName} · {account.platformKind} ·{' '}
                  {account.userId}
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>Find a collection</span>
            <input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.currentTarget.value)
                setPage(0)
              }}
            />
          </label>
        </div>
        {selected ? (
          <>
            <div className="sticker-grid">
              {ids.slice(page * 24, (page + 1) * 24).map((id) => {
                const pack = packs.get(id)!,
                  assignment = pack.assignments.find(
                    (item) => item.platformSessionId === selected,
                  ),
                  source = stickerAccounts.find(
                    (account) =>
                      account.platformSessionId ===
                      pack.sourcePlatformSessionId,
                  )
                return (
                  <article
                    key={id}
                    className={
                      'panel sticker-card' +
                      (assignment?.assigned ? ' assigned' : '')
                    }
                    data-pack={pack.packId}
                  >
                    <div className="sticker-monogram" aria-hidden="true">
                      {pack.title.trim()[0] ?? <Icon name="smile" size={20} />}
                    </div>
                    <h2>{pack.title}</h2>
                    <p>
                      {pack.count === undefined
                        ? 'Count unavailable'
                        : pack.count + ' stickers'}
                    </p>
                    <div className="sticker-meta">
                      <span className="chip">
                        {pack.providerId} / {pack.packId}
                      </span>
                      {source ? (
                        <span className="chip">From {source.displayName}</span>
                      ) : null}
                    </div>
                    <button
                      className={
                        'button ' +
                        (assignment?.assigned ? 'tonal' : 'outlined')
                      }
                      disabled={
                        !rpc.ready || action.busy || assignment?.automatic
                      }
                      aria-label={
                        (assignment?.automatic
                          ? 'Automatically assigned '
                          : assignment?.assigned
                            ? 'Remove '
                            : 'Add ') + pack.title
                      }
                      onClick={() => {
                        const accountId = selected,
                          value = pack,
                          assigned = !assignment?.assigned
                        void action.run(() =>
                          rpc.data.setStickerPackAssigned(
                            accountId,
                            value.providerId,
                            value.packId,
                            assigned,
                          ),
                        )
                      }}
                    >
                      {assignment?.automatic
                        ? 'Automatically assigned'
                        : assignment?.assigned
                          ? 'Added · remove'
                          : 'Add to account'}
                    </button>
                  </article>
                )
              })}
            </div>
            {!ids.length ? (
              <EmptyState
                icon="search"
                title="No matching collections"
                description="Try a different search term."
              />
            ) : null}
            <div className="pagination">
              <button
                className="button outlined"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                Previous page
              </button>
              <span>{ids.length} collections</span>
              <button
                className="button outlined"
                disabled={(page + 1) * 24 >= ids.length}
                onClick={() => setPage(page + 1)}
              >
                Next page
              </button>
            </div>
          </>
        ) : (
          <section className="panel empty-state">
            <h2>No accounts to manage yet</h2>
            <p>
              Connect a platform account before assigning sticker collections.
            </p>
          </section>
        )}
      </LiveContent>
    </>
  )
}
