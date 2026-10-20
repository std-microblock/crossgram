import { useEffect, useMemo, useRef, useState } from 'react'
import type { Data, HistoryEntry } from '@cordisjs/plugin-http-webui'
import { navigate, useConnection, useRpc, type PageProps } from '../sdk.js'
import { Icon } from '../icons.js'
import {
  ActionError,
  ConfirmAction,
  formatBytes,
  JsonView,
  LiveContent,
  Modal,
  PageHeader,
  useAction,
} from '../components.js'
import {
  pageSlice,
  parseHeaders,
  readResponse,
  safeHttpURL,
} from './admin-model.js'
export default function HttpPage(props: PageProps) {
  const rpc = useRpc<Data>(props.entryId),
    connection = useConnection()
  const compose = props.path === '/http/compose'
  return (
    <>
      {compose ? (
        <PageHeader
          title="Request studio"
          description="Compose, send, and inspect requests through your server."
          actions={
            <button
              className="button tonal"
              onClick={() =>
                navigate(connection.config.uiPath + '/http/history')
              }
            >
              View history
            </button>
          }
        />
      ) : null}
      <LiveContent ready={rpc.ready}>
        {compose ? (
          <HttpComposer proxy={rpc.data.proxyBaseUrl} ready={rpc.ready} />
        ) : (
          <HttpHistory
            data={rpc.data}
            onCompose={() =>
              navigate(connection.config.uiPath + '/http/compose')
            }
          />
        )}
      </LiveContent>
    </>
  )
}
function HttpHistory({
  data,
  onCompose,
}: {
  data: Data
  onCompose: () => void
}) {
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState<HistoryEntry>()
  const history = data.history
  const rows = useMemo(
    () =>
      (history ?? [])
        .filter((row) =>
          (row.url + ' ' + row.method + ' ' + row.status)
            .toLowerCase()
            .includes(search.toLowerCase()),
        )
        .toReversed(),
    [history, search],
  )
  return (
    <div className="workbench http-workbench">
      <header className="workbench-header">
        <h1>Outbound traffic</h1>
        <span className="workbench-sub">
          {history?.length ?? 0} requests · live view of what your plugins call
        </span>
        <div className="workbench-actions">
          <button className="button tonal" onClick={onCompose}>
            Compose request
          </button>
        </div>
      </header>
      <div className="workbench-toolbar">
        <label className="field grow">
          <span className="sr-only">Search requests</span>
          <input
            type="search"
            aria-label="Search requests"
            placeholder="Filter by URL, method, status…"
            value={search}
            onChange={(event) => {
              setSearch(event.currentTarget.value)
              setPage(0)
            }}
          />
        </label>
        <span className="chip">{rows.length} requests</span>
        <ConfirmAction
          label="Clear history"
          title="Clear outbound history?"
          description="Current monitoring records will be removed. Future requests will still be recorded."
          action={() => data.clear()}
        />
      </div>
      <div className="workbench-body">
        <div className="workbench-scroll">
          <table className="workbench-table http-table">
            <thead>
              <tr>
                <th>Method</th>
                <th>Destination</th>
                <th>Status</th>
                <th className="cell-right">Duration</th>
                <th className="cell-right">Received</th>
              </tr>
            </thead>
            <tbody>
              {pageSlice(rows, page).map((row) => (
                <tr key={row.id}>
                  <td>
                    <span className="chip">{row.method}</span>
                  </td>
                  <td className="cell-grow">
                    <button
                      className="cell-edit"
                      title={row.url}
                      onClick={() => setSelected(row)}
                    >
                      {row.url}
                    </button>
                  </td>
                  <td>{row.wsStatus ?? (row.statusText || row.status)}</td>
                  <td className="cell-right">
                    {row.endTime
                      ? row.endTime - row.startTime + ' ms'
                      : 'In progress'}
                  </td>
                  <td className="cell-right">{formatBytes(row.bytesIn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length ? (
            <p className="empty-note">
              <Icon name="traffic" size={16} /> No outbound requests recorded
              yet.
            </p>
          ) : null}
        </div>
      </div>
      <footer className="workbench-footer">
        <button
          className="button outlined"
          disabled={page === 0}
          onClick={() => setPage(page - 1)}
        >
          Previous page
        </button>
        <span>
          {rows.length} requests · page {page + 1}
        </span>
        <button
          className="button outlined"
          disabled={(page + 1) * 50 >= rows.length}
          onClick={() => setPage(page + 1)}
        >
          Next page
        </button>
      </footer>
      {selected ? (
        <Modal
          title={selected.method + ' request'}
          onClose={() => setSelected(undefined)}
        >
          <JsonView value={selected} />
        </Modal>
      ) : null}
    </div>
  )
}
interface ComposerResult {
  status: number
  statusText: string
  headers: Record<string, string>
  text: string
  truncated?: boolean
  elapsed: number
}
export function HttpComposer(props: { proxy: string; ready: boolean }) {
  const [url, setUrl] = useState(''),
    [method, setMethod] = useState('GET'),
    [headers, setHeaders] = useState(''),
    [body, setBody] = useState(''),
    [bodyType, setBodyType] = useState('text')
  const [result, setResult] = useState<ComposerResult>()
  const [wsState, setWsState] = useState('closed'),
    [message, setMessage] = useState(''),
    [messages, setMessages] = useState<{ direction: string; text: string }[]>(
      [],
    )
  const action = useAction()
  const abort = useRef<AbortController | undefined>(undefined),
    socket = useRef<WebSocket | undefined>(undefined),
    timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(
    () => () => {
      abort.current?.abort()
      clearTimeout(timeout.current)
      socket.current?.close()
    },
    [],
  )
  const target = () => {
    if (!props.proxy)
      throw new Error('The server proxy service is not available')
    return props.proxy.replace(/\/$/, '') + '/' + safeHttpURL(url)
  }
  const append = (direction: string, text: string) =>
    setMessages((rows) => [
      ...rows.slice(-99),
      {
        direction,
        text:
          text.length > 64_000
            ? text.slice(0, 64_000) + '\n[message truncated]'
            : text,
      },
    ])
  function openSocket() {
    const current = socket.current
    if (current && current.readyState < 2) {
      current.close()
      return
    }
    const dest = new URL(url)
    if (
      !['ws:', 'wss:'].includes(dest.protocol) ||
      dest.username ||
      dest.password
    )
      throw new Error('Use a ws:// or wss:// URL without embedded credentials')
    if (!props.proxy)
      throw new Error('The server proxy service is not available')
    const endpoint = new URL(props.proxy, location.href)
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    const next = new WebSocket(
      endpoint.href.replace(/\/$/, '') + '/' + dest.href,
    )
    socket.current = next
    next.binaryType = 'arraybuffer'
    setWsState('connecting')
    setMessages([])
    next.onopen = () => setWsState('open')
    next.onmessage = (event) =>
      append(
        'Received',
        typeof event.data === 'string'
          ? event.data
          : '[binary ' + event.data.byteLength + ' bytes]',
      )
    next.onclose = () => setWsState('closed')
    next.onerror = () => {
      setWsState('error')
      append('Error', 'WebSocket connection failed')
    }
  }
  const send = () =>
    void action.run(async () => {
      if (method === 'WS') {
        openSocket()
        return
      }
      const endpoint = target(),
        requestHeaders = parseHeaders(headers)
      let payload: BodyInit | undefined = ['GET', 'HEAD'].includes(method)
        ? undefined
        : body
      if (payload !== undefined && bodyType === 'json') {
        JSON.parse(body)
        requestHeaders['content-type'] ??= 'application/json'
      }
      if (payload !== undefined && bodyType === 'urlencoded') {
        payload = new URLSearchParams(body)
        requestHeaders['content-type'] ??= 'application/x-www-form-urlencoded'
      }
      if (payload !== undefined && bodyType === 'multipart') {
        const form = new FormData()
        for (const [key, value] of new URLSearchParams(body))
          form.append(key, value)
        payload = form
      }
      abort.current?.abort()
      const controller = new AbortController()
      abort.current = controller
      timeout.current = setTimeout(() => abort.current?.abort(), 30_000)
      setResult(undefined)
      const started = performance.now()
      try {
        const response = await fetch(endpoint, {
          method,
          headers: requestHeaders,
          body: payload,
          signal: controller.signal,
        })
        const info = {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers) as Record<
            string,
            string
          >,
          text: '',
          elapsed: 0,
        }
        setResult(info)
        const content = await readResponse(response, 1024 * 1024, (text) =>
          setResult({ ...info, text, elapsed: performance.now() - started }),
        )
        setResult({ ...info, ...content, elapsed: performance.now() - started })
      } finally {
        clearTimeout(timeout.current)
        timeout.current = undefined
      }
    })
  return (
    <div className="panel stack">
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <div className="toolbar">
          <label className="field">
            <span>Method</span>
            <select
              aria-label="Method"
              value={method}
              disabled={
                action.busy || wsState === 'open' || wsState === 'connecting'
              }
              onChange={(event) => setMethod(event.currentTarget.value)}
            >
              {[
                'GET',
                'POST',
                'PUT',
                'PATCH',
                'DELETE',
                'HEAD',
                'OPTIONS',
                'WS',
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>Request URL</span>
            <input
              required
              value={url}
              placeholder={
                method === 'WS'
                  ? 'wss://example.com/socket'
                  : 'https://example.com/api'
              }
              onChange={(event) => setUrl(event.currentTarget.value)}
            />
          </label>
          <button
            className="button filled"
            disabled={!props.ready || action.busy}
          >
            {method === 'WS'
              ? wsState === 'open' || wsState === 'connecting'
                ? 'Disconnect'
                : 'Connect'
              : action.busy
                ? 'Sending…'
                : 'Send request'}
          </button>
          {action.busy ? (
            <button
              type="button"
              className="button outlined"
              onClick={() => abort.current?.abort()}
            >
              Cancel request
            </button>
          ) : null}
        </div>
        {method !== 'WS' ? (
          <>
            <label className="field">
              <span>Request headers</span>
              <textarea
                rows={3}
                placeholder="Accept: application/json"
                value={headers}
                onChange={(event) => setHeaders(event.currentTarget.value)}
              />
            </label>
            {!['GET', 'HEAD'].includes(method) ? (
              <>
                <label className="field">
                  <span>Body format</span>
                  <select
                    aria-label="Body format"
                    value={bodyType}
                    onChange={(event) => setBodyType(event.currentTarget.value)}
                  >
                    <option value="text">Raw text</option>
                    <option value="json">JSON</option>
                    <option value="urlencoded">Form URL-encoded</option>
                    <option value="multipart">Multipart text fields</option>
                  </select>
                </label>
                <label className="field">
                  <span>Request body</span>
                  <textarea
                    rows={6}
                    spellCheck={false}
                    value={body}
                    onChange={(event) => setBody(event.currentTarget.value)}
                  />
                </label>
              </>
            ) : null}
          </>
        ) : null}
      </form>
      <ActionError error={action.error} />
      {method === 'WS' ? (
        <>
          <div className="toolbar">
            <span className="chip">{wsState}</span>
            <span className="muted">
              The latest 100 messages are kept. Browser WebSockets cannot set
              custom headers.
            </span>
          </div>
          <form
            className="toolbar"
            onSubmit={(event) => {
              event.preventDefault()
              void action.run(async () => {
                if (!socket.current || socket.current.readyState !== 1)
                  throw new Error('WebSocket is not open')
                if (new TextEncoder().encode(message).length > 1024 * 1024)
                  throw new Error('Message exceeds 1 MiB')
                socket.current.send(message)
                append('Sent', message)
                setMessage('')
              })
            }}
          >
            <label className="field grow">
              <span>WebSocket message</span>
              <textarea
                value={message}
                onChange={(event) => setMessage(event.currentTarget.value)}
              />
            </label>
            <button className="button filled" disabled={wsState !== 'open'}>
              Send message
            </button>
          </form>
          {messages.map((row, index) => (
            <div key={index}>
              <span className="chip">{row.direction}</span>
              <pre>{row.text}</pre>
            </div>
          ))}
        </>
      ) : null}
      {result ? (
        <section className="stack">
          <div className="toolbar">
            <span className="chip">
              {result.status} {result.statusText}
            </span>
            <span className="muted">
              {Math.round(result.elapsed)} ms ·{' '}
              {formatBytes(new TextEncoder().encode(result.text).length)}
            </span>
          </div>
          {result.truncated ? (
            <p className="notice">
              Response preview stopped at 1 MiB to keep the interface
              responsive.
            </p>
          ) : null}
          <details>
            <summary>Response headers</summary>
            <JsonView value={result.headers} />
          </details>
          <pre className="response-body" aria-label="Response body">
            {result.text}
          </pre>
        </section>
      ) : null}
    </div>
  )
}
