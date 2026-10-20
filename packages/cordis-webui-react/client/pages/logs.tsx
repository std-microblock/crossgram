import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Data } from '@cordisjs/plugin-logger-webui'
import type { Message } from 'cordis'
import { useRpc, type PageProps } from '../sdk.js'
import { Icon } from '../icons.js'
import {
  ActionError,
  LiveContent,
  PageHeader,
  useAsync,
} from '../components.js'
import { stripAnsi } from './admin-model.js'
const LEVELS = ['error', 'warn', 'info', 'debug']
/** Only a bounded window is ever rendered, so one row height is a good guess. */
const ROW_ESTIMATE = 96
/**
 * Live log browser. Records stream in from the logger entry; paging backwards
 * swaps the live window for a server-side history page, and the rendered
 * records are virtualized so a full 100-record window costs only the visible
 * rows instead of the whole DOM.
 */
export default function LogsPage({ entryId }: PageProps) {
  const rpc = useRpc<Data>(entryId)
  const [search, setSearch] = useState(''),
    [level, setLevel] = useState(''),
    [source, setSource] = useState('')
  const [paused, setPaused] = useState<Message[]>(),
    [cursors, setCursors] = useState<number[]>([])
  const cursor = cursors.at(-1)
  const older = useAsync<Message[]>(
    () =>
      rpc.ready && cursor !== undefined
        ? rpc.data.read({ before: cursor, limit: 100 })
        : undefined,
    [rpc.ready, cursor],
  )
  // `useAsync` reports `loading` only after its effect runs, so treat a missing
  // first payload as loading too; otherwise the list would flash an empty state.
  const loadingOlder =
    cursors.length > 0 &&
    (older.loading || (older.data === undefined && !older.error))
  const windowRows = useMemo(
    () =>
      cursors.length
        ? older.error
          ? []
          : (older.data ?? [])
        : (paused ?? rpc.data.messages ?? []),
    [cursors.length, older.error, older.data, paused, rpc.data.messages],
  )
  const filtered = useMemo(() => {
    const text = search.toLowerCase()
    return windowRows
      .filter(
        (message) =>
          (!level || message.type === level) &&
          (!source || message.entryId === source) &&
          (!text ||
            (message.name + ' ' + stripAnsi(message.body ?? ''))
              .toLowerCase()
              .includes(text)),
      )
      .slice(-100)
      .toReversed()
  }, [windowRows, search, level, source])
  const oldest = Math.min(
    ...windowRows.map((message) => message.id ?? Infinity),
  )
  const reset = () => {
    setCursors([])
    setPaused(undefined)
  }
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 8,
  })
  return (
    <>
      <PageHeader
        title="Logs"
        description="A clear view of what happened, without a noisy terminal."
        actions={
          <>
            <button
              className="button outlined"
              disabled={!!cursors.length}
              onClick={() =>
                setPaused(
                  paused
                    ? undefined
                    : (JSON.parse(
                        JSON.stringify(rpc.data.messages ?? []),
                      ) as Message[]),
                )
              }
            >
              {paused ? 'Resume live' : 'Pause live'}
            </button>
            <button className="button tonal" onClick={reset}>
              Latest logs
            </button>
          </>
        }
      />
      <LiveContent ready={rpc.ready}>
        <div className="panel stack">
          <div className="toolbar">
            <label className="field grow">
              <span>Search loaded logs</span>
              <input
                type="search"
                value={search}
                placeholder="Message or namespace…"
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
            </label>
            <label className="field">
              <span>Level</span>
              <select
                aria-label="Level"
                value={level}
                onChange={(event) => setLevel(event.currentTarget.value)}
              >
                <option value="">All levels</option>
                {LEVELS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Plugin</span>
              <select
                aria-label="Plugin"
                value={source}
                onChange={(event) => setSource(event.currentTarget.value)}
              >
                <option value="">All plugins</option>
                {(rpc.data.entryIds ?? []).map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted">
            {cursors.length
              ? 'History page'
              : paused
                ? 'Live view paused'
                : 'Live view'}{' '}
            · Showing up to 100 matching records in this loaded window. Older
            records remain in the server log database.
          </p>
          <ActionError error={older.error ? String(older.error) : ''} />
          {loadingOlder ? (
            <div className="loading" role="status">
              Loading older logs…
            </div>
          ) : (
            <div
              className="log-list"
              ref={scrollRef}
              role="list"
              aria-label="Log records"
              style={{
                maxHeight: 'min(60vh, 640px)',
                overflowY: 'auto',
                overscrollBehavior: 'contain',
              }}
            >
              {filtered.length ? (
                <div
                  role="presentation"
                  style={{
                    position: 'relative',
                    width: '100%',
                    height: virtualizer.getTotalSize(),
                  }}
                >
                  {virtualizer.getVirtualItems().map((item) => {
                    const message = filtered[item.index]!
                    return (
                      <article
                        key={item.key}
                        ref={virtualizer.measureElement}
                        data-index={item.index}
                        className="log-record"
                        role="listitem"
                        data-level={message.type}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: 'translateY(' + item.start + 'px)',
                        }}
                      >
                        <header>
                          <span className={'chip log-level ' + message.type}>
                            {message.type}
                          </span>
                          <strong>{message.name}</strong>
                          <time dateTime={new Date(message.ts).toISOString()}>
                            {new Date(message.ts).toLocaleString()}
                          </time>
                        </header>
                        <pre>
                          {stripAnsi(
                            message.body ??
                              (message.args ?? []).map(String).join(' '),
                          )}
                        </pre>
                        {message.entryId ? (
                          <small className="muted">{message.entryId}</small>
                        ) : null}
                      </article>
                    )
                  })}
                </div>
              ) : null}
              {!filtered.length ? (
                <p className="empty-note">
                  <Icon name="search" size={16} />
                  No matching logs in this window.
                </p>
              ) : null}
            </div>
          )}
          <div className="pagination">
            <button
              className="button outlined"
              disabled={!cursors.length || loadingOlder}
              onClick={() => setCursors((value) => value.slice(0, -1))}
            >
              Newer logs
            </button>
            <span>{filtered.length} records</span>
            <button
              className="button outlined"
              disabled={loadingOlder || !Number.isFinite(oldest) || !rpc.ready}
              onClick={() => setCursors((value) => [...value, oldest])}
            >
              Older logs
            </button>
          </div>
        </div>
      </LiveContent>
    </>
  )
}
