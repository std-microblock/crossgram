/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import type { Data, HistoryEntry } from '@cordisjs/plugin-http-webui'
import { navigate, useConnection, useRpc, type PageProps } from '../sdk.js'
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
  const compose = () => props.path === '/http/compose'
  return (
    <>
      <PageHeader
        title={compose() ? 'Request studio' : 'Outbound traffic'}
        description={
          compose()
            ? 'Compose, send, and inspect requests through your server.'
            : 'A live view of the requests your plugins make.'
        }
        actions={
          <button
            class="button tonal"
            onClick={() =>
              navigate(
                connection.config.uiPath +
                  (compose() ? '/http/history' : '/http/compose'),
              )
            }
          >
            {compose() ? 'View history' : 'Compose request'}
          </button>
        }
      />
      <LiveContent ready={rpc.ready}>
        <Show when={compose()} fallback={<HttpHistory data={rpc.data} />}>
          <HttpComposer proxy={rpc.data.proxyBaseUrl} ready={rpc.ready} />
        </Show>
      </LiveContent>
    </>
  )
}
function HttpHistory(props: { data: Data }) {
  const [search, setSearch] = createSignal(''),
    [page, setPage] = createSignal(0),
    [selected, setSelected] = createSignal<HistoryEntry>()
  const rows = createMemo(() =>
    (props.data.history ?? [])
      .filter((row) =>
        (row.url + ' ' + row.method + ' ' + row.status)
          .toLowerCase()
          .includes(search().toLowerCase()),
      )
      .toReversed(),
  )
  return (
    <div class="panel stack">
      <div class="toolbar">
        <label class="field grow">
          <span>Search requests</span>
          <input
            type="search"
            value={search()}
            onInput={(event) => {
              setSearch(event.currentTarget.value)
              setPage(0)
            }}
          />
        </label>
        <ConfirmAction
          label="Clear history"
          title="Clear outbound history?"
          description="Current monitoring records will be removed. Future requests will still be recorded."
          action={() => props.data.clear()}
        />
      </div>
      <div class="table-scroll" tabindex="0">
        <table>
          <thead>
            <tr>
              <th>Method</th>
              <th>Destination</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Received</th>
            </tr>
          </thead>
          <tbody>
            <For each={pageSlice(rows(), page())}>
              {(row) => (
                <tr>
                  <td>
                    <span class="chip">{row.method}</span>
                  </td>
                  <td>
                    <button
                      class="cell-edit truncate"
                      title={row.url}
                      onClick={() => setSelected(row)}
                    >
                      {row.url}
                    </button>
                  </td>
                  <td>{row.wsStatus ?? (row.statusText || row.status)}</td>
                  <td>
                    {row.endTime
                      ? row.endTime - row.startTime + ' ms'
                      : 'In progress'}
                  </td>
                  <td>{formatBytes(row.bytesIn)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <Show when={!rows().length}>
        <p class="empty-state">No outbound requests yet.</p>
      </Show>
      <div class="pagination">
        <button
          class="button outlined"
          disabled={page() === 0}
          onClick={() => setPage(page() - 1)}
        >
          Previous page
        </button>
        <span>{rows().length} requests</span>
        <button
          class="button outlined"
          disabled={(page() + 1) * 50 >= rows().length}
          onClick={() => setPage(page() + 1)}
        >
          Next page
        </button>
      </div>
      <Show when={selected()} keyed>
        {(row) => (
          <Modal
            title={row.method + ' request'}
            onClose={() => setSelected(undefined)}
          >
            <JsonView value={row} />
          </Modal>
        )}
      </Show>
    </div>
  )
}
export function HttpComposer(props: { proxy: string; ready: boolean }) {
  const [url, setUrl] = createSignal(''),
    [method, setMethod] = createSignal('GET'),
    [headers, setHeaders] = createSignal(''),
    [body, setBody] = createSignal(''),
    [bodyType, setBodyType] = createSignal('text')
  const [result, setResult] = createSignal<{
    status: number
    statusText: string
    headers: Record<string, string>
    text: string
    truncated?: boolean
    elapsed: number
  }>()
  const [wsState, setWsState] = createSignal('closed'),
    [message, setMessage] = createSignal(''),
    [messages, setMessages] = createSignal<
      { direction: string; text: string }[]
    >([])
  const action = useAction()
  let abort: AbortController | undefined,
    socket: WebSocket | undefined,
    timeout: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    abort?.abort()
    clearTimeout(timeout)
    socket?.close()
  })
  const target = () => {
    if (!props.proxy)
      throw new Error('The server proxy service is not available')
    return props.proxy.replace(/\/$/, '') + '/' + safeHttpURL(url())
  }
  const send = () =>
    void action.run(async () => {
      if (method() === 'WS') {
        openSocket()
        return
      }
      const endpoint = target(),
        requestHeaders = parseHeaders(headers())
      let payload: BodyInit | undefined = ['GET', 'HEAD'].includes(method())
        ? undefined
        : body()
      if (payload !== undefined && bodyType() === 'json') {
        JSON.parse(body())
        requestHeaders['content-type'] ??= 'application/json'
      }
      if (payload !== undefined && bodyType() === 'urlencoded') {
        payload = new URLSearchParams(body())
        requestHeaders['content-type'] ??= 'application/x-www-form-urlencoded'
      }
      if (payload !== undefined && bodyType() === 'multipart') {
        const form = new FormData()
        for (const [key, value] of new URLSearchParams(body()))
          form.append(key, value)
        payload = form
      }
      abort?.abort()
      abort = new AbortController()
      timeout = setTimeout(() => abort?.abort(), 30_000)
      setResult(undefined)
      const started = performance.now()
      try {
        const response = await fetch(endpoint, {
          method: method(),
          headers: requestHeaders,
          body: payload,
          signal: abort.signal,
        })
        const info = {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers),
          text: '',
          elapsed: 0,
        }
        setResult(info)
        const content = await readResponse(response, 1024 * 1024, (text) =>
          setResult({ ...info, text, elapsed: performance.now() - started }),
        )
        setResult({ ...info, ...content, elapsed: performance.now() - started })
      } finally {
        clearTimeout(timeout)
        timeout = undefined
      }
    })
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
    if (socket && socket.readyState < 2) {
      socket.close()
      return
    }
    const dest = new URL(url())
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
    socket = new WebSocket(endpoint.href.replace(/\/$/, '') + '/' + dest.href)
    socket.binaryType = 'arraybuffer'
    setWsState('connecting')
    setMessages([])
    socket.onopen = () => setWsState('open')
    socket.onmessage = (event) =>
      append(
        'Received',
        typeof event.data === 'string'
          ? event.data
          : '[binary ' + event.data.byteLength + ' bytes]',
      )
    socket.onclose = () => setWsState('closed')
    socket.onerror = () => {
      setWsState('error')
      append('Error', 'WebSocket connection failed')
    }
  }
  return (
    <div class="panel stack">
      <form
        class="stack"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <div class="toolbar">
          <label class="field">
            <span>Method</span>
            <select
              aria-label="Method"
              value={method()}
              disabled={
                action.busy() ||
                wsState() === 'open' ||
                wsState() === 'connecting'
              }
              onChange={(event) => setMethod(event.currentTarget.value)}
            >
              <For
                each={[
                  'GET',
                  'POST',
                  'PUT',
                  'PATCH',
                  'DELETE',
                  'HEAD',
                  'OPTIONS',
                  'WS',
                ]}
              >
                {(value) => <option>{value}</option>}
              </For>
            </select>
          </label>
          <label class="field grow">
            <span>Request URL</span>
            <input
              required
              value={url()}
              placeholder={
                method() === 'WS'
                  ? 'wss://example.com/socket'
                  : 'https://example.com/api'
              }
              onInput={(event) => setUrl(event.currentTarget.value)}
            />
          </label>
          <button
            class="button filled"
            disabled={!props.ready || action.busy()}
          >
            {method() === 'WS'
              ? wsState() === 'open' || wsState() === 'connecting'
                ? 'Disconnect'
                : 'Connect'
              : action.busy()
                ? 'Sending…'
                : 'Send request'}
          </button>
          <Show when={action.busy()}>
            <button
              type="button"
              class="button outlined"
              onClick={() => abort?.abort()}
            >
              Cancel request
            </button>
          </Show>
        </div>
        <Show when={method() !== 'WS'}>
          <label class="field">
            <span>Request headers</span>
            <textarea
              rows={3}
              placeholder="Accept: application/json"
              value={headers()}
              onInput={(event) => setHeaders(event.currentTarget.value)}
            />
          </label>
          <Show when={!['GET', 'HEAD'].includes(method())}>
            <label class="field">
              <span>Body format</span>
              <select
                aria-label="Body format"
                value={bodyType()}
                onChange={(event) => setBodyType(event.currentTarget.value)}
              >
                <option value="text">Raw text</option>
                <option value="json">JSON</option>
                <option value="urlencoded">Form URL-encoded</option>
                <option value="multipart">Multipart text fields</option>
              </select>
            </label>
            <label class="field">
              <span>Request body</span>
              <textarea
                rows={6}
                spellcheck={false}
                value={body()}
                onInput={(event) => setBody(event.currentTarget.value)}
              />
            </label>
          </Show>
        </Show>
      </form>
      <ActionError error={action.error()} />
      <Show when={method() === 'WS'}>
        <div class="toolbar">
          <span class="chip">{wsState()}</span>
          <span class="muted">
            The latest 100 messages are kept. Browser WebSockets cannot set
            custom headers.
          </span>
        </div>
        <form
          class="toolbar"
          onSubmit={(event) => {
            event.preventDefault()
            void action.run(async () => {
              if (!socket || socket.readyState !== 1)
                throw new Error('WebSocket is not open')
              if (new TextEncoder().encode(message()).length > 1024 * 1024)
                throw new Error('Message exceeds 1 MiB')
              socket.send(message())
              append('Sent', message())
              setMessage('')
            })
          }}
        >
          <label class="field grow">
            <span>WebSocket message</span>
            <textarea
              value={message()}
              onInput={(event) => setMessage(event.currentTarget.value)}
            />
          </label>
          <button class="button filled" disabled={wsState() !== 'open'}>
            Send message
          </button>
        </form>
        <For each={messages()}>
          {(row) => (
            <div>
              <span class="chip">{row.direction}</span>
              <pre>{row.text}</pre>
            </div>
          )}
        </For>
      </Show>
      <Show when={result()} keyed>
        {(response) => (
          <section class="stack">
            <div class="toolbar">
              <span class="chip">
                {response.status} {response.statusText}
              </span>
              <span class="muted">
                {Math.round(response.elapsed)} ms ·{' '}
                {formatBytes(new TextEncoder().encode(response.text).length)}
              </span>
            </div>
            <Show when={response.truncated}>
              <p class="notice">
                Response preview stopped at 1 MiB to keep the interface
                responsive.
              </p>
            </Show>
            <details>
              <summary>Response headers</summary>
              <JsonView value={response.headers} />
            </details>
            <pre class="response-body" aria-label="Response body">
              {response.text}
            </pre>
          </section>
        )}
      </Show>
    </div>
  )
}
