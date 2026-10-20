import { useState } from 'react'
import type { BotDashboardData } from '../src/dashboard-types.js'
import { useRpc, type PageProps } from 'cordis-webui-react/client'
import {
  ActionError,
  LiveContent,
  PageHeader,
  useAction,
} from 'cordis-webui-react/components'
import { botLink, copyText } from './bridge-model.js'
export default function BotsPage(props: PageProps) {
  const rpc = useRpc<BotDashboardData>(props.entryId),
    action = useAction()
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(0),
    [copied, setCopied] = useState('')
  const bots = (rpc.data.bots ?? []).filter((bot) =>
    (bot.title + ' ' + bot.username + ' ' + bot.sourcePlugin)
      .toLowerCase()
      .includes(search.toLowerCase()),
  )
  return (
    <>
      <PageHeader
        title="Your bots"
        description="Handy companions for your connected workspace."
        actions={
          <button
            className="button outlined"
            disabled={action.busy || !rpc.ready}
            onClick={() => void action.run(() => rpc.data.refreshBots())}
          >
            Refresh bots
          </button>
        }
      />
      <ActionError error={action.error} />
      <LiveContent ready={rpc.ready}>
        <label className="field account-search">
          <span>Find a bot</span>
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.currentTarget.value)
              setPage(0)
            }}
          />
        </label>
        <div className="bot-grid">
          {bots.slice(page * 24, (page + 1) * 24).map((bot) => {
            const link = botLink(bot.username)
            return (
              <article className="panel bot-card" key={bot.conversationId}>
                <span className="bot-monogram" aria-hidden="true">
                  {bot.title.trim()[0] ?? 'B'}
                </span>
                <div>
                  <h2>{bot.title}</h2>
                  <code>@{bot.username}</code>
                  <p>{bot.sourcePlugin}</p>
                </div>
                {link ? (
                  <div className="toolbar">
                    <a
                      className="button filled"
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open in Telegram
                    </a>
                    <button
                      className="button outlined"
                      onClick={() =>
                        void action.run(async () => {
                          await copyText(link)
                          setCopied(bot.username)
                        })
                      }
                    >
                      {copied === bot.username ? 'Link copied' : 'Copy link'}
                    </button>
                  </div>
                ) : (
                  <p className="notice error">
                    This bot has an invalid username.
                  </p>
                )}
              </article>
            )
          })}
        </div>
        {!bots.length ? (
          <section className="panel empty-state">
            <h2>No matching bots</h2>
            <p>Enabled bridge bot providers will appear here automatically.</p>
          </section>
        ) : null}
        <div className="pagination">
          <button
            className="button outlined"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            Previous page
          </button>
          <span>{bots.length} bots</span>
          <button
            className="button outlined"
            disabled={(page + 1) * 24 >= bots.length}
            onClick={() => setPage(page + 1)}
          >
            Next page
          </button>
        </div>
      </LiveContent>
    </>
  )
}
