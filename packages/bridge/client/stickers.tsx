/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import type { StickerPackDashboardData } from '../src/dashboard-types.js'
import { useRpc, type PageProps } from 'cordis-webui-solidjs/client'
import {
  ActionError,
  LiveContent,
  PageHeader,
  useAction,
} from 'cordis-webui-solidjs/components'
export default function StickersPage(props: PageProps) {
  const rpc = useRpc<StickerPackDashboardData>(props.entryId),
    action = useAction()
  const [selected, setSelected] = createSignal(''),
    [search, setSearch] = createSignal(''),
    [page, setPage] = createSignal(0)
  createEffect(() => {
    if (
      rpc.ready &&
      !rpc.data.stickerAccounts.some(
        (account) => account.platformSessionId === selected(),
      )
    )
      setSelected(rpc.data.stickerAccounts[0]?.platformSessionId ?? '')
  })
  const packs = createMemo(
    () =>
      new Map(
        (rpc.data.stickerPacks ?? []).map((pack) => [
          JSON.stringify([pack.providerId, pack.packId]),
          pack,
        ]),
      ),
  )
  const ids = createMemo(() =>
    [...packs().keys()].filter((key) => {
      const pack = packs().get(key)!
      return (pack.title + ' ' + pack.providerId + ' ' + pack.packId)
        .toLowerCase()
        .includes(search().toLowerCase())
    }),
  )
  return (
    <>
      <PageHeader
        title="Sticker collections"
        description="Choose the collections that make each account feel like yours."
        actions={
          <button
            class="button outlined"
            disabled={action.busy() || !rpc.ready}
            onClick={() =>
              void action.run(() => rpc.data.refreshStickerPacks())
            }
          >
            Refresh collections
          </button>
        }
      />
      <ActionError error={action.error()} />
      <LiveContent ready={rpc.ready}>
        <div class="panel toolbar sticker-controls">
          <label class="field grow">
            <span>Assign to account</span>
            <select
              aria-label="Assign to account"
              value={selected()}
              onChange={(event) => setSelected(event.currentTarget.value)}
            >
              <For each={rpc.data.stickerAccounts}>
                {(account) => (
                  <option value={account.platformSessionId}>
                    {account.displayName} · {account.platformKind} ·{' '}
                    {account.userId}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="field grow">
            <span>Find a collection</span>
            <input
              type="search"
              value={search()}
              onInput={(event) => {
                setSearch(event.currentTarget.value)
                setPage(0)
              }}
            />
          </label>
        </div>
        <Show
          when={selected()}
          fallback={
            <section class="panel empty-state">
              <h2>No accounts to manage yet</h2>
              <p>
                Connect a platform account before assigning sticker collections.
              </p>
            </section>
          }
        >
          <div class="sticker-grid">
            <For each={ids().slice(page() * 24, (page() + 1) * 24)}>
              {(id) => {
                const pack = () => packs().get(id)!,
                  assignment = () =>
                    pack().assignments.find(
                      (item) => item.platformSessionId === selected(),
                    ),
                  source = () =>
                    rpc.data.stickerAccounts.find(
                      (account) =>
                        account.platformSessionId ===
                        pack().sourcePlatformSessionId,
                    )
                return (
                  <article
                    class="panel sticker-card"
                    classList={{ assigned: assignment()?.assigned }}
                    data-pack={pack().packId}
                  >
                    <div class="sticker-monogram" aria-hidden="true">
                      {pack().title.trim().slice(0, 2) || '☺'}
                    </div>
                    <h2>{pack().title}</h2>
                    <p>
                      {pack().count === undefined
                        ? 'Count unavailable'
                        : pack().count + ' stickers'}
                    </p>
                    <code>
                      {pack().providerId} / {pack().packId}
                    </code>
                    <Show when={source()}>
                      <small>From {source()!.displayName}</small>
                    </Show>
                    <button
                      class={
                        'button ' +
                        (assignment()?.assigned ? 'tonal' : 'filled')
                      }
                      disabled={
                        !rpc.ready || action.busy() || assignment()?.automatic
                      }
                      aria-label={
                        (assignment()?.automatic
                          ? 'Automatically assigned '
                          : assignment()?.assigned
                            ? 'Remove '
                            : 'Add ') + pack().title
                      }
                      onClick={() => {
                        const accountId = selected(),
                          value = pack(),
                          assigned = !assignment()?.assigned
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
                      {assignment()?.automatic
                        ? 'Automatically assigned'
                        : assignment()?.assigned
                          ? 'Added · remove'
                          : 'Add to account'}
                    </button>
                  </article>
                )
              }}
            </For>
          </div>
          <Show when={!ids().length}>
            <p class="panel empty-state">No matching sticker collections.</p>
          </Show>
          <div class="pagination">
            <button
              class="button outlined"
              disabled={page() === 0}
              onClick={() => setPage(page() - 1)}
            >
              Previous page
            </button>
            <span>{ids().length} collections</span>
            <button
              class="button outlined"
              disabled={(page() + 1) * 24 >= ids().length}
              onClick={() => setPage(page() + 1)}
            >
              Next page
            </button>
          </div>
        </Show>
      </LiveContent>
    </>
  )
}
