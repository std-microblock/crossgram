/** @jsxImportSource solid-js */
import { createMemo, createResource, createSignal, For, Show } from 'solid-js'
import type { Data } from '@cordisjs/plugin-logger-webui'
import type { Message } from 'cordis'
import { useRpc, type PageProps } from '../sdk.js'
import { ActionError, LiveContent, PageHeader } from '../components.js'
import { stripAnsi } from './admin-model.js'
export default function LogsPage(props: PageProps) {
  const rpc = useRpc<Data>(props.entryId)
  const [search, setSearch] = createSignal(''),
    [level, setLevel] = createSignal(''),
    [source, setSource] = createSignal('')
  const [paused, setPaused] = createSignal<Message[]>(),
    [cursors, setCursors] = createSignal<number[]>([])
  const [older] = createResource(
    () => (rpc.ready && cursors().length ? cursors().at(-1) : false),
    (before) => rpc.data.read({ before, limit: 100 }),
  )
  const windowRows = () =>
    cursors().length
      ? older.error
        ? []
        : (older() ?? [])
      : (paused() ?? rpc.data.messages ?? [])
  const filtered = createMemo(() => {
    const text = search().toLowerCase()
    return windowRows()
      .filter(
        (message) =>
          (!level() || message.type === level()) &&
          (!source() || message.entryId === source()) &&
          (!text ||
            (message.name + ' ' + stripAnsi(message.body ?? ''))
              .toLowerCase()
              .includes(text)),
      )
      .slice(-100)
      .toReversed()
  })
  const oldest = () =>
    Math.min(...windowRows().map((message) => message.id ?? Infinity))
  const reset = () => {
    setCursors([])
    setPaused(undefined)
  }
  return (
    <>
      <PageHeader
        title="Logs"
        description="A clear view of what happened, without a noisy terminal."
        actions={
          <>
            <button
              class="button outlined"
              disabled={!!cursors().length}
              onClick={() =>
                setPaused(
                  paused()
                    ? undefined
                    : JSON.parse(JSON.stringify(rpc.data.messages ?? [])),
                )
              }
            >
              {paused() ? 'Resume live' : 'Pause live'}
            </button>
            <button class="button tonal" onClick={reset}>
              Latest logs
            </button>
          </>
        }
      />
      <LiveContent ready={rpc.ready}>
        <div class="panel stack">
          <div class="toolbar">
            <label class="field grow">
              <span>Search loaded logs</span>
              <input
                type="search"
                value={search()}
                placeholder="Message or namespace…"
                onInput={(event) => setSearch(event.currentTarget.value)}
              />
            </label>
            <label class="field">
              <span>Level</span>
              <select
                aria-label="Level"
                value={level()}
                onChange={(event) => setLevel(event.currentTarget.value)}
              >
                <option value="">All levels</option>
                <For each={['error', 'warn', 'info', 'debug']}>
                  {(name) => <option value={name}>{name}</option>}
                </For>
              </select>
            </label>
            <label class="field">
              <span>Plugin</span>
              <select
                aria-label="Plugin"
                value={source()}
                onChange={(event) => setSource(event.currentTarget.value)}
              >
                <option value="">All plugins</option>
                <For each={rpc.data.entryIds}>
                  {(id) => <option value={id}>{id}</option>}
                </For>
              </select>
            </label>
          </div>
          <p class="muted">
            {cursors().length
              ? 'History page'
              : paused()
                ? 'Live view paused'
                : 'Live view'}{' '}
            · Showing up to 100 matching records in this loaded window. Older
            records remain in the server log database.
          </p>
          <ActionError error={older.error ? String(older.error) : ''} />
          <Show
            when={!older.loading}
            fallback={
              <div class="loading" role="status">
                Loading older logs…
              </div>
            }
          >
            <div class="log-list" role="list" aria-label="Log records">
              <For each={filtered()}>
                {(message) => (
                  <article
                    class="log-record"
                    role="listitem"
                    data-level={message.type}
                  >
                    <header>
                      <span class={'chip log-level ' + message.type}>
                        {message.type}
                      </span>
                      <strong>{message.name}</strong>
                      <time datetime={new Date(message.ts).toISOString()}>
                        {new Date(message.ts).toLocaleString()}
                      </time>
                    </header>
                    <pre>
                      {stripAnsi(
                        message.body ??
                          (message.args ?? []).map(String).join(' '),
                      )}
                    </pre>
                    <Show when={message.entryId}>
                      <small class="muted">{message.entryId}</small>
                    </Show>
                  </article>
                )}
              </For>
              <Show when={!filtered().length}>
                <p class="empty-state">No matching logs in this window.</p>
              </Show>
            </div>
          </Show>
          <div class="pagination">
            <button
              class="button outlined"
              disabled={!cursors().length || older.loading}
              onClick={() => setCursors((value) => value.slice(0, -1))}
            >
              Newer logs
            </button>
            <span>{filtered().length} records</span>
            <button
              class="button outlined"
              disabled={
                older.loading || !Number.isFinite(oldest()) || !rpc.ready
              }
              onClick={() => setCursors((value) => [...value, oldest()])}
            >
              Older logs
            </button>
          </div>
        </div>
      </LiveContent>
    </>
  )
}
