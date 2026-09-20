/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, Show } from 'solid-js'
import type { BotDashboardData } from '../../../bridge/src/dashboard-types.js'
import { useRpc, type PageProps } from '../sdk.js'
import {
  ActionError,
  LiveContent,
  PageHeader,
  useAction,
} from '../components.js'
import { botLink, copyText } from './bridge-model.js'
export default function BotsPage(props: PageProps) {
  const rpc = useRpc<BotDashboardData>(props.entryId),
    action = useAction()
  const [search, setSearch] = createSignal(''),
    [page, setPage] = createSignal(0),
    [copied, setCopied] = createSignal('')
  const bots = createMemo(() =>
    (rpc.data.bots ?? []).filter((bot) =>
      (bot.title + ' ' + bot.username + ' ' + bot.sourcePlugin)
        .toLowerCase()
        .includes(search().toLowerCase()),
    ),
  )
  return (
    <>
      <PageHeader
        title="Your bots"
        description="Handy companions for your connected workspace."
        actions={
          <button
            class="button outlined"
            disabled={action.busy() || !rpc.ready}
            onClick={() => void action.run(() => rpc.data.refreshBots())}
          >
            Refresh bots
          </button>
        }
      />
      <ActionError error={action.error()} />
      <LiveContent ready={rpc.ready}>
        <label class="field account-search">
          <span>Find a bot</span>
          <input
            type="search"
            value={search()}
            onInput={(event) => {
              setSearch(event.currentTarget.value)
              setPage(0)
            }}
          />
        </label>
        <div class="bot-grid">
          <For each={bots().slice(page() * 24, (page() + 1) * 24)}>
            {(bot) => (
              <article class="panel bot-card">
                <span class="bot-monogram" aria-hidden="true">
                  {bot.title.trim()[0] ?? 'B'}
                </span>
                <div>
                  <h2>{bot.title}</h2>
                  <code>@{bot.username}</code>
                  <p>{bot.sourcePlugin}</p>
                </div>
                <Show
                  when={botLink(bot.username)}
                  keyed
                  fallback={
                    <p class="notice error">
                      This bot has an invalid username.
                    </p>
                  }
                >
                  {(link) => (
                    <div class="toolbar">
                      <a
                        class="button filled"
                        href={link}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open in Telegram
                      </a>
                      <button
                        class="button outlined"
                        onClick={() =>
                          void action.run(async () => {
                            await copyText(link)
                            setCopied(bot.username)
                          })
                        }
                      >
                        {copied() === bot.username
                          ? 'Link copied'
                          : 'Copy link'}
                      </button>
                    </div>
                  )}
                </Show>
              </article>
            )}
          </For>
        </div>
        <Show when={!bots().length}>
          <section class="panel empty-state">
            <h2>No matching bots</h2>
            <p>Enabled bridge bot providers will appear here automatically.</p>
          </section>
        </Show>
        <div class="pagination">
          <button
            class="button outlined"
            disabled={page() === 0}
            onClick={() => setPage(page() - 1)}
          >
            Previous page
          </button>
          <span>{bots().length} bots</span>
          <button
            class="button outlined"
            disabled={(page() + 1) * 24 >= bots().length}
            onClick={() => setPage(page() + 1)}
          >
            Next page
          </button>
        </div>
      </LiveContent>
    </>
  )
}
