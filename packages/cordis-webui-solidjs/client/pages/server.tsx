/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, Show } from 'solid-js'
import type { Data } from '../../src/server-monitor.js'
import { navigate, useConnection, useRpc, type PageProps } from '../sdk.js'
import {
  ConfirmAction,
  formatBytes,
  JsonView,
  LiveContent,
  Modal,
  PageHeader,
} from '../components.js'
import { pageSlice } from './admin-model.js'
export default function ServerPage(props: PageProps) {
  const rpc = useRpc<Data>(props.entryId),
    connection = useConnection()
  const [search, setSearch] = createSignal(''),
    [page, setPage] = createSignal(0),
    [selected, setSelected] = createSignal<any>()
  const requests = () => props.path === '/server/requests'
  const rows = createMemo(() =>
    (requests()
      ? [...(rpc.data.requests ?? [])].reverse()
      : Object.values(rpc.data.routes ?? {}).sort(
          (a, b) => b.requests - a.requests,
        )
    ).filter((row) =>
      (row.method + ' ' + row.path + ' ' + row.plugin)
        .toLowerCase()
        .includes(search().toLowerCase()),
    ),
  )
  return (
    <>
      <PageHeader
        title={requests() ? 'Incoming requests' : 'Server routes'}
        description="Understand what enters your workspace and where it goes."
        actions={
          <button
            class="button tonal"
            onClick={() => {
              setPage(0)
              navigate(
                connection.config.uiPath +
                  (requests() ? '/server/routes' : '/server/requests'),
              )
            }}
          >
            {requests() ? 'View routes' : 'View requests'}
          </button>
        }
      />
      <LiveContent ready={rpc.ready}>
        <div class="metric-grid compact-metrics">
          <article class="panel metric">
            <span class="eyebrow">SERVER</span>
            <strong class="metric-text">
              {rpc.data.listening ? 'Listening' : 'Not listening'}
            </strong>
            <p>
              {rpc.data.host}:{rpc.data.port}
            </p>
          </article>
          <article class="panel metric">
            <span class="eyebrow">ROUTES</span>
            <strong>{Object.keys(rpc.data.routes ?? {}).length}</strong>
            <p>HTTP and WebSocket endpoints</p>
          </article>
          <article class="panel metric">
            <span class="eyebrow">RECENT REQUESTS</span>
            <strong>{rpc.data.requests?.length ?? 0}</strong>
            <p>A bounded, live history</p>
          </article>
        </div>
        <div class="panel stack">
          <div class="toolbar">
            <label class="field grow">
              <span>Filter {requests() ? 'requests' : 'routes'}</span>
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
              label="Reset counters"
              title="Reset server monitoring?"
              description="Clears recent requests and per-route counters, without changing any routes."
              action={() => rpc.data.clear()}
            />
          </div>
          <div class="table-scroll" tabindex="0">
            <table>
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Path</th>
                  <th>Plugin</th>
                  <th>{requests() ? 'Status' : 'Requests'}</th>
                  <th>{requests() ? 'Received / sent' : 'Average latency'}</th>
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
                          title={row.path}
                          onClick={() => setSelected(row)}
                        >
                          {row.path}
                        </button>
                      </td>
                      <td>{row.plugin ?? '—'}</td>
                      <td>
                        {'status' in row
                          ? row.status || 'Pending'
                          : row.requests}
                      </td>
                      <td>
                        {'avgLatency' in row
                          ? row.avgLatency.toFixed(1) + ' ms'
                          : formatBytes(row.bytesIn) +
                            ' / ' +
                            formatBytes(row.bytesOut)}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
          <Show when={!rows().length}>
            <p class="empty-state">No matching records.</p>
          </Show>
          <div class="pagination">
            <button
              class="button outlined"
              disabled={page() === 0}
              onClick={() => setPage(page() - 1)}
            >
              Previous page
            </button>
            <span>{rows().length} records</span>
            <button
              class="button outlined"
              disabled={(page() + 1) * 50 >= rows().length}
              onClick={() => setPage(page() + 1)}
            >
              Next page
            </button>
          </div>
        </div>
        <Show when={selected()} keyed>
          {(row) => (
            <Modal
              title={row.method + ' ' + row.path}
              onClose={() => setSelected(undefined)}
            >
              <JsonView value={row} />
            </Modal>
          )}
        </Show>
      </LiveContent>
    </>
  )
}
