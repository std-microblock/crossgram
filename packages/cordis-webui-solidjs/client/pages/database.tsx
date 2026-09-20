/** @jsxImportSource solid-js */
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
} from 'solid-js'
import type {
  Data,
  FieldInfo,
  TableInfo,
} from '@cordisjs/plugin-database-webui'
import { useConnection, useRpc, type PageProps } from '../sdk.js'
import {
  ActionError,
  LiveContent,
  Modal,
  PageHeader,
  useAction,
} from '../components.js'
import { displayValue, parseCell, primaryKey } from './admin-model.js'
export default function DatabasePage(props: PageProps) {
  const rpc = useRpc<Data>(props.entryId),
    connection = useConnection()
  const [table, setTable] = createSignal(''),
    [offset, setOffset] = createSignal(0),
    [size, setSize] = createSignal(50)
  const [sort, setSort] = createSignal<{
    field: string
    direction: 'asc' | 'desc'
  }>()
  const [editing, setEditing] = createSignal<{
    table: TableInfo
    row: any
    field: FieldInfo
  }>()
  createEffect(() => {
    if (rpc.ready && !rpc.data.tables.some((item) => item.name === table())) {
      setTable(rpc.data.tables[0]?.name ?? '')
      setOffset(0)
    }
  })
  const current = createMemo(() =>
    rpc.data.tables?.find((item) => item.name === table()),
  )
  const [result, { refetch }] = createResource(
    () =>
      rpc.ready && table()
        ? { table: table(), offset: offset(), limit: size(), sort: sort() }
        : false,
    (query) => rpc.data.query(query),
  )
  const snapshot = () => (result.error ? undefined : result())
  const chooseTable = (value: string) => {
    setTable(value)
    setOffset(0)
    setSort(undefined)
  }
  return (
    <>
      <PageHeader
        title="Database"
        description="Browse your data. Make precise, deliberate changes."
        actions={
          <button
            class="button outlined"
            disabled={!rpc.ready || result.loading}
            onClick={() => void refetch()}
          >
            Refresh
          </button>
        }
      />
      <LiveContent ready={rpc.ready}>
        <div class="panel stack">
          <div class="toolbar">
            <label class="field">
              <span>Table</span>
              <select
                aria-label="Table"
                value={table()}
                onChange={(event) => chooseTable(event.currentTarget.value)}
              >
                <For each={rpc.data.tables}>
                  {(item) => <option value={item.name}>{item.name}</option>}
                </For>
              </select>
            </label>
            <label class="field">
              <span>Rows per page</span>
              <select
                aria-label="Rows per page"
                value={String(size())}
                onChange={(event) => {
                  setSize(+event.currentTarget.value)
                  setOffset(0)
                }}
              >
                <For each={[25, 50, 100]}>
                  {(count) => <option value={String(count)}>{count}</option>}
                </For>
              </select>
            </label>
            <span class="chip">{snapshot()?.total ?? 0} rows</span>
          </div>
          <ActionError error={result.error ? String(result.error) : ''} />
          <Show
            when={!result.loading}
            fallback={
              <div class="loading" role="status">
                Reading this page…
              </div>
            }
          >
            <Show when={current()} keyed>
              {(meta) => (
                <div
                  class="table-scroll"
                  tabindex="0"
                  aria-label="Database rows"
                >
                  <table>
                    <thead>
                      <tr>
                        <For each={meta.fields}>
                          {(field) => (
                            <th
                              aria-sort={
                                sort()?.field === field.name
                                  ? sort()?.direction === 'asc'
                                    ? 'ascending'
                                    : 'descending'
                                  : 'none'
                              }
                            >
                              <button
                                class="table-sort"
                                onClick={() => {
                                  setOffset(0)
                                  setSort({
                                    field: field.name,
                                    direction:
                                      sort()?.field === field.name &&
                                      sort()?.direction === 'asc'
                                        ? 'desc'
                                        : 'asc',
                                  })
                                }}
                              >
                                {field.primary ? '⌑ ' : ''}
                                {field.name}
                                <small>{field.type}</small>
                              </button>
                            </th>
                          )}
                        </For>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={snapshot()?.rows ?? []}>
                        {(row) => (
                          <tr>
                            <For each={meta.fields}>
                              {(field) => (
                                <td>
                                  <Show
                                    when={
                                      !field.primary &&
                                      field.type !== 'expr' &&
                                      meta.primary.length
                                    }
                                    fallback={
                                      <span
                                        title={displayValue(row[field.name])}
                                      >
                                        {displayValue(row[field.name]).slice(
                                          0,
                                          240,
                                        )}
                                      </span>
                                    }
                                  >
                                    <button
                                      class="cell-edit"
                                      disabled={
                                        connection.state.status !== 'connected'
                                      }
                                      aria-label={
                                        'Edit ' +
                                        field.name +
                                        ' in row ' +
                                        meta.primary
                                          .map((key) => displayValue(row[key]))
                                          .join(', ')
                                      }
                                      onClick={() =>
                                        setEditing({ table: meta, row, field })
                                      }
                                    >
                                      {displayValue(row[field.name]).slice(
                                        0,
                                        240,
                                      )}
                                    </button>
                                  </Show>
                                </td>
                              )}
                            </For>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              )}
            </Show>
            <Show when={!snapshot()?.rows.length}>
              <p class="empty-state">No rows in this table.</p>
            </Show>
          </Show>
          <div class="pagination">
            <button
              class="button outlined"
              disabled={offset() === 0 || result.loading}
              onClick={() => setOffset(Math.max(0, offset() - size()))}
            >
              Previous page
            </button>
            <span>Page {Math.floor(offset() / size()) + 1}</span>
            <button
              class="button outlined"
              disabled={
                result.loading || offset() + size() >= (snapshot()?.total ?? 0)
              }
              onClick={() => setOffset(offset() + size())}
            >
              Next page
            </button>
          </div>
          <Show when={current()}>
            <details>
              <summary>Table schema and primary keys</summary>
              <p class="muted">
                Primary key:{' '}
                {current()!.primary.join(', ') || 'none; table is read-only'}
              </p>
              <div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Type</th>
                      <th>Constraints</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={current()!.fields}>
                      {(field) => (
                        <tr>
                          <td>{field.name}</td>
                          <td>{field.type}</td>
                          <td>
                            {[
                              field.primary && 'Primary',
                              field.unique && 'Unique',
                              field.nullable && 'Nullable',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </details>
          </Show>
        </div>
      </LiveContent>
      <Show when={editing()} keyed>
        {(edit) => (
          <EditCell
            edit={edit}
            onClose={() => setEditing(undefined)}
            onSave={async (value) => {
              await rpc.data.update({
                table: edit.table.name,
                where: primaryKey(edit.row, edit.table.primary),
                field: edit.field.name,
                value,
              })
              setEditing(undefined)
              await refetch()
            }}
          />
        )}
      </Show>
    </>
  )
}
function EditCell(props: {
  edit: { table: TableInfo; row: any; field: FieldInfo }
  onClose: () => void
  onSave: (value: unknown) => Promise<void>
}) {
  const [text, setText] = createSignal(
    props.edit.row[props.edit.field.name] === null
      ? ''
      : displayValue(props.edit.row[props.edit.field.name]),
  )
  const [isNull, setNull] = createSignal(
      props.edit.row[props.edit.field.name] === null,
    ),
    action = useAction()
  return (
    <Modal
      title={'Edit ' + props.edit.field.name}
      onClose={() => {
        if (!action.busy()) props.onClose()
      }}
    >
      <form
        class="stack"
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(() =>
            props.onSave(
              parseCell(
                text(),
                props.edit.field.type,
                !!props.edit.field.nullable,
                isNull(),
              ),
            ),
          )
        }}
      >
        <p class="muted">
          {props.edit.table.name} · primary key{' '}
          {JSON.stringify(primaryKey(props.edit.row, props.edit.table.primary))}
        </p>
        <label class="field">
          <span>Value ({props.edit.field.type})</span>
          <textarea
            value={text()}
            disabled={isNull() || action.busy()}
            onInput={(event) => setText(event.currentTarget.value)}
          />
        </label>
        <Show when={props.edit.field.nullable}>
          <label class="checkbox-label">
            <input
              type="checkbox"
              checked={isNull()}
              onChange={(event) => setNull(event.currentTarget.checked)}
            />
            Set to null
          </label>
        </Show>
        <ActionError error={action.error()} />
        <button class="button filled" disabled={action.busy()}>
          {action.busy() ? 'Saving…' : 'Save cell'}
        </button>
      </form>
    </Modal>
  )
}
