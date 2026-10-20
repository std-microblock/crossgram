import { useMemo, useState } from 'react'
import type {
  Data,
  ServerRequest,
  ServerRoute,
} from '../../src/server-monitor.js'
import { navigate, useConnection, useRpc, type PageProps } from '../sdk.js'
import { Icon } from '../icons.js'
import {
  ConfirmAction,
  formatBytes,
  JsonView,
  LiveContent,
  Modal,
} from '../components.js'
import { pageSlice } from './admin-model.js'
type Row = ServerRequest | ServerRoute
export default function ServerPage({ entryId, path }: PageProps) {
  const rpc = useRpc<Data>(entryId),
    connection = useConnection()
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState<Row>()
  const requests = path === '/server/requests'
  const rows = useMemo<Row[]>(
    () =>
      (requests
        ? [...(rpc.data.requests ?? [])].reverse()
        : Object.values(rpc.data.routes ?? {}).sort(
            (a, b) => b.requests - a.requests,
          )
      ).filter((row) =>
        (row.method + ' ' + row.path + ' ' + row.plugin)
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [requests, rpc.data.requests, rpc.data.routes, search],
  )
  const routeCount = Object.keys(rpc.data.routes ?? {}).length
  return (
    <>
      <LiveContent ready={rpc.ready}>
        <div className="workbench server-workbench">
          <header className="workbench-header">
            <h1>{requests ? 'Incoming requests' : 'Server routes'}</h1>
            <span className="workbench-sub">
              {rpc.data.listening ? 'Listening' : 'Not listening'} ·{' '}
              {rpc.data.host}:{rpc.data.port} · {routeCount} routes ·{' '}
              {rpc.data.requests?.length ?? 0} recent requests
            </span>
            <div className="workbench-actions">
              <button
                className="button tonal"
                onClick={() => {
                  setPage(0)
                  navigate(
                    connection.config.uiPath +
                      (requests ? '/server/routes' : '/server/requests'),
                  )
                }}
              >
                {requests ? 'View routes' : 'View requests'}
              </button>
            </div>
          </header>
          <div className="workbench-toolbar">
            <label className="field grow">
              <span className="sr-only">
                Filter {requests ? 'requests' : 'routes'}
              </span>
              <input
                type="search"
                aria-label={'Filter ' + (requests ? 'requests' : 'routes')}
                placeholder={
                  'Filter ' + (requests ? 'requests' : 'routes') + '…'
                }
                value={search}
                onChange={(event) => {
                  setSearch(event.currentTarget.value)
                  setPage(0)
                }}
              />
            </label>
            <span className="chip">{rows.length} records</span>
            <ConfirmAction
              label="Reset counters"
              title="Reset server monitoring?"
              description="Clears recent requests and per-route counters, without changing any routes."
              action={() => rpc.data.clear()}
            />
          </div>
          <div className="workbench-body">
            <div className="workbench-scroll">
              <table className="workbench-table server-table">
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Path</th>
                    <th>Plugin</th>
                    <th className="cell-right">
                      {requests ? 'Status' : 'Requests'}
                    </th>
                    <th className="cell-right">
                      {requests ? 'Received / sent' : 'Average latency'}
                    </th>
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
                          title={row.path}
                          onClick={() => setSelected(row)}
                        >
                          {row.path}
                        </button>
                      </td>
                      <td>{row.plugin ?? '—'}</td>
                      <td className="cell-right">
                        {'status' in row ? row.status || 'Pending' : row.requests}
                      </td>
                      <td className="cell-right">
                        {'avgLatency' in row
                          ? row.avgLatency.toFixed(1) + ' ms'
                          : formatBytes(row.bytesIn) +
                            ' / ' +
                            formatBytes(row.bytesOut)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!rows.length ? (
                <p className="empty-note">
                  <Icon name="search" size={16} /> No matching records.
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
              {rows.length} records · page {page + 1}
            </span>
            <button
              className="button outlined"
              disabled={(page + 1) * 50 >= rows.length}
              onClick={() => setPage(page + 1)}
            >
              Next page
            </button>
          </footer>
        </div>
        {selected ? (
          <Modal
            title={selected.method + ' ' + selected.path}
            onClose={() => setSelected(undefined)}
          >
            <JsonView value={selected} />
          </Modal>
        ) : null}
      </LiveContent>
    </>
  )
}
