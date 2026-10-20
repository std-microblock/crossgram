import { useMemo, useState, type CSSProperties } from 'react'
import {
  approveNavigation,
  navigate,
  useConnection,
  useConnectionState,
  useRpc,
  type PageProps,
} from '../sdk.js'
import {
  ActionError,
  ConfirmAction,
  JsonView,
  LiveContent,
  Modal,
  useAction,
  useAsync,
} from '../components.js'
import { configExpression } from '../schema-model.js'
import { SchemaForm } from '../schema.js'

export interface ConfigEntry {
  id: string
  name: string
  label?: string
  config?: any
  disabled?: boolean
  isGroup?: boolean
  parent?: string
  position?: number
  state?: number
  isolate?: any
  intercept?: any
  effects?: unknown[]
}
export interface LoaderData {
  entries: ConfigEntry[]
  packages: Record<string, any>
  services: Record<string, any>
  prefix: string
  createConfig(options: any): Promise<string>
  updateConfig(options: any): Promise<void>
  removeConfig(options: { id: string }): Promise<void>
  getPackageRuntime(options: {
    name: string
  }): Promise<{ schema?: any; usage?: string; inject?: any } | null>
  getPackageReadme(options: {
    name: string
    locale: string
  }): Promise<string | null>
  evalConfig(options: {
    id: string
    expr: string
    schema: any
  }): Promise<{ error?: string; value?: any }>
}
const statuses = [
  'Waiting',
  'Starting',
  'Running',
  'Failed',
  'Disposed',
  'Stopping',
]
const EMPTY_ENTRIES: ConfigEntry[] = []
const serviceSchema = {
  type: 'object',
  meta: {},
  dict: {
    isolate: {
      type: 'dict',
      meta: {
        description:
          'Service names mapped to local (true) or named global scopes.',
      },
      inner: {
        type: 'union',
        meta: {},
        list: [
          { type: 'boolean', meta: {} },
          { type: 'string', meta: {} },
        ],
      },
    },
    intercept: {
      type: 'dict',
      meta: {},
      inner: { type: 'any', meta: {} },
    },
  },
}
const emptySchema = { type: 'any', meta: {} }
export default function LoaderPage(props: PageProps) {
  const rpc = useRpc<LoaderData>(props.entryId),
    connection = useConnection(),
    connectionState = useConnectionState(),
    action = useAction()
  const [browse, setBrowse] = useState(false)
  const [search, setSearch] = useState(''),
    [limit, setLimit] = useState(100),
    [adding, setAdding] = useState(false)
  const entries = rpc.data.entries ?? EMPTY_ENTRIES
  const selected = useMemo(
    () =>
      entries.find(
        (entry) =>
          entry.id === decodeURIComponent(props.path.slice('/plugins/'.length)),
      ),
    [entries, props.path],
  )
  const go = (id?: string) =>
    navigate(
      connection.config.uiPath +
        '/plugins' +
        (id ? '/' + encodeURIComponent(id) : ''),
    )
  const filtered = useMemo(
    () =>
      entries.filter((entry) =>
        (entry.label + ' ' + entry.name + ' ' + entry.id)
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [entries, search],
  )
  const depth = (entry: ConfigEntry) => {
    let depth = 0,
      current = entry
    const seen = new Set([entry.id])
    while (current.parent && depth < 8) {
      const parent = entries.find((item) => item.id === current.parent)
      if (!parent || seen.has(parent.id)) break
      seen.add(parent.id)
      current = parent
      depth++
    }
    return depth
  }
  const configured = entries.length
  const running = entries.filter((entry) => entry.state === 2).length
  return (
    <>
      <ActionError error={action.error} />
      <LiveContent ready={rpc.ready}>
        <div className="workbench plugin-workbench">
          <header className="workbench-header">
            <h1>Plugins</h1>
            <span className="workbench-sub">
              {configured} configured · {running} running
            </span>
            <div className="workbench-actions">
              <button
                className="button filled"
                disabled={connectionState.status !== 'connected'}
                onClick={() => setAdding(true)}
              >
                Add plugin
              </button>
            </div>
          </header>
          <div className="plugin-layout">
          <aside
            className={
              'panel plugin-list' + (selected && !browse ? ' collapsed' : '')
            }
            aria-label="Plugins"
          >
            <button
              className="plugin-browser-toggle"
              aria-expanded={!selected || browse}
              onClick={() => setBrowse(!browse)}
            >
              Choose a plugin <span>{entries.length}</span>
            </button>
            <div className="plugin-browser-content">
              <label className="field">
                <span className="sr-only">Search plugins</span>
                <input
                  type="search"
                  placeholder="Find a plugin…"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.currentTarget.value)
                    setLimit(100)
                  }}
                />
              </label>
              <div className="plugin-list-items">
                {filtered.slice(0, limit).map((entry) => (
                  <button
                    key={entry.id}
                    className={
                      'plugin-list-item' +
                      (selected?.id === entry.id ? ' selected' : '')
                    }
                    style={{ '--depth': depth(entry) } as CSSProperties}
                    onClick={() => {
                      go(entry.id)
                      setBrowse(false)
                    }}
                  >
                    <span
                      className={
                        'plugin-status' +
                        (entry.state === 2 ? ' running' : '') +
                        (entry.state === 3 ? ' failed' : '') +
                        (entry.disabled ? ' disabled' : '')
                      }
                    />
                    <span>
                      <strong>
                        {entry.label ||
                          entry.name.replace('@cordisjs/plugin-', '')}
                      </strong>
                      <small>
                        {entry.disabled
                          ? 'Disabled'
                          : statuses[entry.state ?? 0]}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              {filtered.length > limit ? (
                <button
                  className="button outlined"
                  onClick={() => setLimit(limit + 100)}
                >
                  Show more plugins
                </button>
              ) : null}
            </div>
          </aside>
          <section className="panel plugin-detail">
            {selected?.id ? (
              <PluginDetail
                key={selected.id}
                entry={selected}
                data={rpc.data}
                onRemoved={() => go()}
              />
            ) : (
              <div className="empty-state">
                <h2>Everything in its right place</h2>
                <p>
                  Choose a plugin to edit configuration, inspect its services,
                  or manage its lifecycle.
                </p>
                <div className="toolbar">
                  <span className="chip">{entries.length} configured</span>
                  <span className="chip">
                    {entries.filter((entry) => entry.state === 2).length}{' '}
                    running
                  </span>
                </div>
              </div>
            )}
          </section>
        </div>
        </div>
      </LiveContent>
      {adding ? (
        <AddPlugin
          data={rpc.data}
          parent={selected?.isGroup ? selected?.id : selected?.parent}
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false)
            go(id)
          }}
        />
      ) : null}
    </>
  )
}
function PluginDetail({
  entry,
  data,
  onRemoved,
}: {
  entry: ConfigEntry
  data: LoaderData
  onRemoved: () => void
}) {
  const connection = useConnectionState(),
    action = useAction()
  const runtime = useAsync(
    () => data.getPackageRuntime({ name: entry.name }),
    [entry.name],
  )
  const [tab, setTab] = useState('configuration')
  const [label, setLabel] = useState(entry.label ?? '')
  const [parent, setParent] = useState(entry.parent ?? '')
  const [position, setPosition] = useState(entry.position ?? 0)
  const save = async (config: any) => {
    if (runtime.data?.schema) {
      const result = await data.evalConfig({
        id: entry.id,
        expr: configExpression(config),
        schema: runtime.data.schema,
      })
      if (result.error)
        throw new Error(
          'Plugin configuration failed ' + result.error + ' validation',
        )
    }
    await data.updateConfig({ id: entry.id, config })
  }
  const groups = (data.entries ?? EMPTY_ENTRIES).filter(
    (item) =>
      item.isGroup &&
      item.id !== entry.id &&
      !isDescendant(item, entry.id, data.entries ?? EMPTY_ENTRIES),
  )
  return (
    <div className="stack">
      <header>
        <span className="eyebrow">{entry.id}</span>
        <h2>{entry.label || entry.name}</h2>
        <p className="muted">{entry.name}</p>
      </header>
      <div className="toolbar">
        <span className="chip">
          {entry.disabled ? 'Disabled' : statuses[entry.state ?? 0]}
        </span>
        <ConfirmAction
          label={entry.disabled ? 'Enable plugin' : 'Disable plugin'}
          title={
            entry.disabled ? 'Enable this plugin?' : 'Disable this plugin?'
          }
          description="Dependent services may restart when this plugin changes."
          action={() =>
            data.updateConfig({
              id: entry.id,
              disabled: !entry.disabled,
            })
          }
        />
        <ConfirmAction
          label="Remove plugin"
          title="Remove this plugin?"
          description="This removes the saved configuration. Group removal also removes its children."
          danger
          action={async () => {
            await data.removeConfig({ id: entry.id })
            onRemoved()
          }}
        />
      </div>
      <div className="segmented" role="tablist" aria-label="Plugin details">
        {['configuration', 'organization', 'services', 'usage'].map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? 'selected' : undefined}
            onClick={() => {
              if (name === tab || approveNavigation()) setTab(name)
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <ActionError
        error={action.error || (runtime.error ? String(runtime.error) : '')}
      />
      {tab === 'configuration' ? (
        runtime.loading ? (
          <p className="loading">Loading configuration schema…</p>
        ) : !entry.isGroup ? (
          <SchemaForm
            schema={runtime.data?.schema ?? emptySchema}
            value={entry.config ?? {}}
            onSave={save}
            disabled={connection.status !== 'connected'}
          />
        ) : (
          <p className="muted">
            This is a plugin group. Select a child to edit its configuration.
          </p>
        )
      ) : null}
      {tab === 'organization' ? (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault()
            void action.run(() =>
              data.updateConfig({
                id: entry.id,
                label: label || null,
                parent: parent || null,
                position,
              }),
            )
          }}
        >
          <label className="field">
            <span>Display name</span>
            <input
              value={label}
              onChange={(event) => setLabel(event.currentTarget.value)}
            />
          </label>
          <label className="field">
            <span>Parent group</span>
            <select
              aria-label="Parent group"
              value={parent}
              onChange={(event) => setParent(event.currentTarget.value)}
            >
              <option value="">Workspace root</option>
              {groups.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label || item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Position in group</span>
            <input
              type="number"
              min="0"
              step="1"
              value={position}
              onChange={(event) =>
                setPosition(Math.max(0, event.currentTarget.valueAsNumber || 0))
              }
            />
          </label>
          <button
            className="button filled"
            disabled={action.busy || connection.status !== 'connected'}
          >
            Save organization
          </button>
        </form>
      ) : null}
      {tab === 'services' ? (
        <>
          <h3>Service scopes and interception</h3>
          <SchemaForm
            schema={serviceSchema}
            value={{
              isolate: entry.isolate ?? {},
              intercept: entry.intercept ?? {},
            }}
            onSave={(value) => data.updateConfig({ id: entry.id, ...value })}
            disabled={connection.status !== 'connected'}
          />
          <details>
            <summary>Runtime services</summary>
            <JsonView value={data.services} />
          </details>
          <details>
            <summary>Registered effects</summary>
            <JsonView value={entry.effects} />
          </details>
        </>
      ) : null}
      {tab === 'usage' ? (
        <>
          <p className="usage-text">
            {runtime.data?.usage ||
              'This plugin has not provided usage documentation.'}
          </p>
          <p className="muted">Required services</p>
          <JsonView value={runtime.data?.inject ?? {}} />
        </>
      ) : null}
    </div>
  )
}
function isDescendant(
  entry: ConfigEntry,
  ancestor: string,
  entries: ConfigEntry[],
) {
  const seen = new Set<string>()
  while (entry.parent && !seen.has(entry.id)) {
    seen.add(entry.id)
    if (entry.parent === ancestor) return true
    const parent = entries.find((item) => item.id === entry.parent)
    if (!parent) break
    entry = parent
  }
  return false
}
function AddPlugin({
  data,
  parent,
  onClose,
  onCreated,
}: {
  data: LoaderData
  parent?: string
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [name, setName] = useState(''),
    [label, setLabel] = useState('')
  const action = useAction()
  return (
    <Modal title="Add a plugin" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(async () => {
            const id = await data.createConfig({
              name: name.trim(),
              label: label || null,
              parent: parent ?? null,
              disabled: true,
            })
            onCreated(
              data.prefix && id.startsWith(data.prefix)
                ? id.slice(data.prefix.length)
                : id,
            )
          })
        }}
      >
        <label className="field">
          <span>Installed plugin package</span>
          <input
            required
            list="installed-plugin-packages"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="@cordisjs/plugin-…"
          />
          <datalist id="installed-plugin-packages">
            {Object.keys(data.packages ?? {}).map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>Display name (optional)</span>
          <input
            value={label}
            onChange={(event) => setLabel(event.currentTarget.value)}
          />
        </label>
        <p className="muted">
          The plugin starts disabled so you can configure it before enabling it.
        </p>
        <ActionError error={action.error} />
        <button
          className="button filled"
          disabled={action.busy || !name.trim()}
        >
          Create plugin
        </button>
      </form>
    </Modal>
  )
}
