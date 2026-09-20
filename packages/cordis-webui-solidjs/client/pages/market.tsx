/** @jsxImportSource solid-js */
import { createMemo, createResource, createSignal, For, Show } from 'solid-js'
import type { Data, DescribeResult } from '@cordisjs/plugin-market'
import { navigate, useConnection, useRpc, type PageProps } from '../sdk.js'
import {
  ActionError,
  ConfirmAction,
  LiveContent,
  Modal,
  PageHeader,
  useAction,
} from '../components.js'
import { pageSlice } from './admin-model.js'
export default function MarketPage(props: PageProps) {
  const rpc = useRpc<Data>(props.entryId),
    connection = useConnection(),
    action = useAction()
  const [search, setSearch] = createSignal(''),
    [page, setPage] = createSignal(0),
    [selected, setSelected] = createSignal<string>()
  const dependencies = () => props.path === '/dependencies'
  const rows = createMemo(() =>
    Object.values(rpc.data.market?.data ?? {}).filter((row) =>
      (row.package.name + ' ' + row.package.description)
        .toLowerCase()
        .includes(search().toLowerCase()),
    ),
  )
  const deps = createMemo(() =>
    Object.entries(rpc.data.dependencies ?? {}).filter(([name]) =>
      name.toLowerCase().includes(search().toLowerCase()),
    ),
  )
  const install = async (name: string, version: string | null) => {
    const code = await connection.rpc<number>(
      props.entryId,
      'install',
      [{ [name]: version }, false],
      10 * 60_000,
    )
    if (code !== 0)
      throw new Error(
        'Package manager exited with code ' +
          code +
          '. Check server logs before retrying.',
      )
  }
  return (
    <>
      <PageHeader
        title={dependencies() ? 'Dependencies' : 'Plugin library'}
        description={
          dependencies()
            ? 'Keep installed packages deliberate and up to date.'
            : 'Discover something useful for your workspace.'
        }
        actions={
          <>
            <button
              class="button outlined"
              disabled={action.busy() || !rpc.ready}
              onClick={() => void action.run(() => rpc.data.refresh())}
            >
              Refresh catalog
            </button>
            <button
              class="button tonal"
              onClick={() => {
                setPage(0)
                navigate(
                  connection.config.uiPath +
                    (dependencies() ? '/market' : '/dependencies'),
                )
              }}
            >
              {dependencies() ? 'Browse library' : 'Installed packages'}
            </button>
          </>
        }
      />
      <ActionError error={action.error() || rpc.data.market?.error || ''} />
      <LiveContent ready={rpc.ready}>
        <div class="panel stack">
          <div class="toolbar">
            <label class="field grow">
              <span>
                {dependencies()
                  ? 'Search installed packages'
                  : 'Search plugins'}
              </span>
              <input
                type="search"
                value={search()}
                onInput={(event) => {
                  setSearch(event.currentTarget.value)
                  setPage(0)
                }}
              />
            </label>
            <button
              class="button outlined"
              disabled={!search().trim()}
              onClick={() => setSelected(search().trim())}
            >
              Look up package
            </button>
          </div>
          <Show
            when={!dependencies()}
            fallback={
              <div class="table-scroll" tabindex="0">
                <table>
                  <thead>
                    <tr>
                      <th>Package</th>
                      <th>Requested</th>
                      <th>Installed</th>
                      <th>Available</th>
                      <th>Manage</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={pageSlice(deps(), page())}>
                      {([name, dep]) => (
                        <tr>
                          <td>
                            {name}
                            <Show when={dep.workspace}>
                              <span class="chip">Workspace</span>
                            </Show>
                            <Show when={dep.invalid}>
                              <span class="chip error">Invalid</span>
                            </Show>
                          </td>
                          <td>{dep.request}</td>
                          <td>{dep.resolved ?? '—'}</td>
                          <td>{dep.latest ?? '—'}</td>
                          <td>
                            <button
                              class="button outlined"
                              disabled={dep.workspace}
                              onClick={() => setSelected(name)}
                            >
                              Manage package
                            </button>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            }
          >
            <Show when={rpc.data.market?.loading}>
              <p role="status">Refreshing the registry…</p>
            </Show>
            <div class="market-grid">
              <For each={pageSlice(rows(), page(), 24)}>
                {(row) => (
                  <article class="market-card">
                    <header>
                      <span class="quick-icon">◫</span>
                      <span class="muted">{row.package.version}</span>
                    </header>
                    <h2>{row.shortname || row.package.name}</h2>
                    <p>{row.package.description}</p>
                    <div class="toolbar">
                      <Show when={row.verified}>
                        <span class="chip">Verified</span>
                      </Show>
                      <Show when={row.insecure}>
                        <span class="chip error">Security warning</span>
                      </Show>
                      <span class="chip">
                        {row.license || 'Unspecified license'}
                      </span>
                    </div>
                    <button
                      class="button tonal"
                      onClick={() => setSelected(row.package.name)}
                    >
                      {rpc.data.dependencies?.[row.package.name]
                        ? 'Manage'
                        : 'View package'}
                    </button>
                  </article>
                )}
              </For>
            </div>
          </Show>
          <div class="pagination">
            <button
              class="button outlined"
              disabled={page() === 0}
              onClick={() => setPage(page() - 1)}
            >
              Previous page
            </button>
            <span>
              {dependencies() ? deps().length : rows().length} packages
            </span>
            <button
              class="button outlined"
              disabled={
                (page() + 1) * (dependencies() ? 50 : 24) >=
                (dependencies() ? deps().length : rows().length)
              }
              onClick={() => setPage(page() + 1)}
            >
              Next page
            </button>
          </div>
        </div>
        <Show when={selected()} keyed>
          {(name) => (
            <PackageDialog
              name={name}
              data={rpc.data}
              install={install}
              onClose={() => setSelected(undefined)}
            />
          )}
        </Show>
      </LiveContent>
    </>
  )
}
function PackageDialog(props: {
  name: string
  data: Data
  install: (name: string, version: string | null) => Promise<void>
  onClose: () => void
}) {
  const [description] = createResource(
    () => props.name,
    (name) => props.data.describe(name),
  )
  const [metadata] = createResource(
    () => props.name,
    (name) => props.data.registry([name]),
  )
  const [version, setVersion] = createSignal(''),
    [success, setSuccess] = createSignal('')
  const packageInfo = () => (description.error ? undefined : description())
  const registryInfo = () => (metadata.error ? undefined : metadata())
  const chosen = () => version() || packageInfo()?.latest || ''
  const meta = () => registryInfo()?.[props.name]?.[chosen()]
  const installed = () => props.data.dependencies?.[props.name]
  return (
    <Modal title={props.name} onClose={props.onClose}>
      <ActionError
        error={
          description.error
            ? String(description.error)
            : metadata.error
              ? String(metadata.error)
              : ''
        }
      />
      <Show
        when={!description.loading}
        fallback={<p class="loading">Reading package information…</p>}
      >
        <Show
          when={packageInfo()}
          keyed
          fallback={
            <p class="notice error">
              This package could not be found in the configured registry.
            </p>
          }
        >
          {(info) => (
            <div class="stack">
              <p>{info.description}</p>
              <label class="field">
                <span>Version</span>
                <select
                  aria-label="Version"
                  value={chosen()}
                  onChange={(event) => setVersion(event.currentTarget.value)}
                >
                  <For each={info.versions}>
                    {(version) => <option>{version}</option>}
                  </For>
                </select>
              </label>
              <Show when={meta()?.deprecated}>
                <p class="notice error">Deprecated: {meta()!.deprecated}</p>
              </Show>
              <Show when={Object.keys(meta()?.peerDependencies ?? {}).length}>
                <details open>
                  <summary>Peer requirements</summary>
                  <ul>
                    <For each={Object.entries(meta()?.peerDependencies ?? {})}>
                      {([name, range]) => (
                        <li>
                          {name}: {range}
                          {meta()?.peerDependenciesMeta?.[name]?.optional
                            ? ' (optional)'
                            : ''}
                        </li>
                      )}
                    </For>
                  </ul>
                </details>
              </Show>
              <p class="muted">
                Installing package code can restart services. Review the package
                and version before continuing. Workspace packages cannot be
                changed here.
              </p>
              <Show when={success()}>
                <div class="notice" role="status">
                  {success()}
                </div>
              </Show>
              <div class="toolbar">
                <ConfirmAction
                  label={
                    installed() ? 'Install selected version' : 'Install package'
                  }
                  title="Install this package version?"
                  description={
                    props.name +
                    '@' +
                    chosen() +
                    ' will be installed on the server. This executes third-party package code.'
                  }
                  disabled={
                    !chosen() || installed()?.workspace || metadata.loading
                  }
                  action={async () => {
                    await props.install(props.name, chosen())
                    setSuccess('Package installation completed')
                  }}
                />
                <Show when={installed() && !installed()!.workspace}>
                  <ConfirmAction
                    label="Remove dependency"
                    title="Remove this dependency?"
                    description="Configured plugins depending on this package may stop working."
                    danger
                    action={async () => {
                      await props.install(props.name, null)
                      setSuccess('Dependency removed')
                    }}
                  />
                </Show>
              </div>
            </div>
          )}
        </Show>
      </Show>
    </Modal>
  )
}
