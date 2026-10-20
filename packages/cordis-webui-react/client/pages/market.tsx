import { useMemo, useState } from 'react'
import type { Data, DescribeResult } from '@cordisjs/plugin-market'
import { navigate, useConnection, useRpc, type PageProps } from '../sdk.js'
import {
  ActionError,
  ConfirmAction,
  LiveContent,
  Modal,
  PageHeader,
  useAction,
  useAsync,
} from '../components.js'
import { Icon } from '../icons.js'
import { pageSlice } from './admin-model.js'
export default function MarketPage(props: PageProps) {
  const rpc = useRpc<Data>(props.entryId),
    connection = useConnection(),
    action = useAction()
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState<string>()
  const dependencies = props.path === '/dependencies'
  const marketData = rpc.data.market?.data
  const dependencyData = rpc.data.dependencies
  const rows = useMemo(
    () =>
      Object.values(marketData ?? {}).filter((row) =>
        (row.package.name + ' ' + row.package.description)
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [marketData, search],
  )
  const deps = useMemo(
    () =>
      Object.entries(dependencyData ?? {}).filter(([name]) =>
        name.toLowerCase().includes(search.toLowerCase()),
      ),
    [dependencyData, search],
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
        title={dependencies ? 'Dependencies' : 'Plugin library'}
        description={
          dependencies
            ? 'Keep installed packages deliberate and up to date.'
            : 'Discover something useful for your workspace.'
        }
        actions={
          <>
            <button
              className="button outlined"
              disabled={action.busy || !rpc.ready}
              onClick={() => void action.run(() => rpc.data.refresh())}
            >
              Refresh catalog
            </button>
            <button
              className="button tonal"
              onClick={() => {
                setPage(0)
                navigate(
                  connection.config.uiPath +
                    (dependencies ? '/market' : '/dependencies'),
                )
              }}
            >
              {dependencies ? 'Browse library' : 'Installed packages'}
            </button>
          </>
        }
      />
      <ActionError error={action.error || rpc.data.market?.error || ''} />
      <LiveContent ready={rpc.ready}>
        <div className="panel stack">
          <div className="toolbar">
            <label className="field grow">
              <span>
                {dependencies ? 'Search installed packages' : 'Search plugins'}
              </span>
              <input
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.currentTarget.value)
                  setPage(0)
                }}
              />
            </label>
            <button
              className="button outlined"
              disabled={!search.trim()}
              onClick={() => setSelected(search.trim())}
            >
              Look up package
            </button>
          </div>
          {!dependencies ? (
            <>
              {rpc.data.market?.loading ? (
                <p role="status">Refreshing the registry…</p>
              ) : null}
              <div className="market-grid">
                {pageSlice(rows, page, 24).map((row) => (
                  <article key={row.package.name} className="market-card">
                    <header>
                      <Icon name="extension" size={20} />
                      <span className="muted">{row.package.version}</span>
                    </header>
                    <h2>{row.shortname || row.package.name}</h2>
                    <p>{row.package.description}</p>
                    <div className="toolbar">
                      {row.verified ? (
                        <span className="chip">Verified</span>
                      ) : null}
                      {row.insecure ? (
                        <span className="chip error">Security warning</span>
                      ) : null}
                      <span className="chip">
                        {row.license || 'Unspecified license'}
                      </span>
                    </div>
                    <button
                      className="button tonal"
                      onClick={() => setSelected(row.package.name)}
                    >
                      {rpc.data.dependencies?.[row.package.name]
                        ? 'Manage'
                        : 'View package'}
                    </button>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <div className="table-scroll" tabIndex={0}>
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
                  {pageSlice(deps, page).map(([name, dep]) => (
                    <tr key={name}>
                      <td>
                        {name}
                        {dep.workspace ? (
                          <span className="chip">Workspace</span>
                        ) : null}
                        {dep.invalid ? (
                          <span className="chip error">Invalid</span>
                        ) : null}
                      </td>
                      <td>{dep.request}</td>
                      <td>{dep.resolved ?? '—'}</td>
                      <td>{dep.latest ?? '—'}</td>
                      <td>
                        <button
                          className="button outlined"
                          disabled={dep.workspace}
                          onClick={() => setSelected(name)}
                        >
                          Manage package
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="pagination">
            <button
              className="button outlined"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              Previous page
            </button>
            <span>{dependencies ? deps.length : rows.length} packages</span>
            <button
              className="button outlined"
              disabled={
                (page + 1) * (dependencies ? 50 : 24) >=
                (dependencies ? deps.length : rows.length)
              }
              onClick={() => setPage(page + 1)}
            >
              Next page
            </button>
          </div>
        </div>
        {selected ? (
          <PackageDialog
            key={selected}
            name={selected}
            data={rpc.data}
            install={install}
            onClose={() => setSelected(undefined)}
          />
        ) : null}
      </LiveContent>
    </>
  )
}
function PackageDialog({
  name,
  data,
  install,
  onClose,
}: {
  name: string
  data: Data
  install: (name: string, version: string | null) => Promise<void>
  onClose: () => void
}) {
  const description = useAsync(() => data.describe(name), [name])
  const metadata = useAsync(() => data.registry([name]), [name])
  const [version, setVersion] = useState(''),
    [success, setSuccess] = useState('')
  const packageInfo: DescribeResult | null | undefined = description.error
    ? undefined
    : description.data
  const registryInfo = metadata.error ? undefined : metadata.data
  const chosen = version || packageInfo?.latest || ''
  const meta = registryInfo?.[name]?.[chosen]
  const installed = data.dependencies?.[name]
  return (
    <Modal title={name} onClose={onClose}>
      <ActionError
        error={
          description.error
            ? String(description.error)
            : metadata.error
              ? String(metadata.error)
              : ''
        }
      />
      {!description.loading ? (
        packageInfo ? (
          <div className="stack">
            <p>{packageInfo.description}</p>
            <label className="field">
              <span>Version</span>
              <select
                aria-label="Version"
                value={chosen}
                onChange={(event) => setVersion(event.currentTarget.value)}
              >
                {packageInfo.versions.map((version) => (
                  <option key={version}>{version}</option>
                ))}
              </select>
            </label>
            {meta?.deprecated ? (
              <p className="notice error">Deprecated: {meta.deprecated}</p>
            ) : null}
            {Object.keys(meta?.peerDependencies ?? {}).length ? (
              <details open>
                <summary>Peer requirements</summary>
                <ul>
                  {Object.entries(meta?.peerDependencies ?? {}).map(
                    ([peerName, range]) => (
                      <li key={peerName}>
                        {peerName}: {range}
                        {meta?.peerDependenciesMeta?.[peerName]?.optional
                          ? ' (optional)'
                          : ''}
                      </li>
                    ),
                  )}
                </ul>
              </details>
            ) : null}
            <p className="muted">
              Installing package code can restart services. Review the package
              and version before continuing. Workspace packages cannot be
              changed here.
            </p>
            {success ? (
              <div className="notice" role="status">
                {success}
              </div>
            ) : null}
            <div className="toolbar">
              <ConfirmAction
                label={
                  installed ? 'Install selected version' : 'Install package'
                }
                title="Install this package version?"
                description={
                  name +
                  '@' +
                  chosen +
                  ' will be installed on the server. This executes third-party package code.'
                }
                disabled={!chosen || installed?.workspace || metadata.loading}
                action={async () => {
                  await install(name, chosen)
                  setSuccess('Package installation completed')
                }}
              />
              {installed && !installed.workspace ? (
                <ConfirmAction
                  label="Remove dependency"
                  title="Remove this dependency?"
                  description="Configured plugins depending on this package may stop working."
                  danger
                  action={async () => {
                    await install(name, null)
                    setSuccess('Dependency removed')
                  }}
                />
              ) : null}
            </div>
          </div>
        ) : (
          <p className="notice error">
            This package could not be found in the configured registry.
          </p>
        )
      ) : (
        <p className="loading">Reading package information…</p>
      )}
    </Modal>
  )
}
