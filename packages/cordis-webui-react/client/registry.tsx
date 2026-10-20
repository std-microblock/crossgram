import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react'
import type { EntryMeta } from '../src/protocol.js'
import {
  useConnection,
  useConnectionState,
  type ClientModule,
  type PageProps,
} from './sdk.js'

interface PageMeta {
  path: string
  title: string
  icon: string
  group: string
}
export interface RegisteredPage extends PageMeta {
  entryId: string
  module: string
  /** Human label for the plugin that contributes the page. */
  source: string
}
const known: Record<string, PageMeta[]> = {
  loader: [
    { path: '/plugins', title: 'Plugins', icon: 'plugins', group: 'Manage' },
  ],
  database: [
    { path: '/database', title: 'Database', icon: 'database', group: 'Manage' },
  ],
  market: [
    {
      path: '/market',
      title: 'Plugin library',
      icon: 'market',
      group: 'Manage',
    },
    {
      path: '/dependencies',
      title: 'Dependencies',
      icon: 'layers',
      group: 'Manage',
    },
  ],
  logs: [{ path: '/logs', title: 'Logs', icon: 'logs', group: 'Observe' }],
  notifications: [
    {
      path: '/notifications',
      title: 'Notifications',
      icon: 'notifications',
      group: 'Workspace',
    },
  ],
  server: [
    {
      path: '/server/routes',
      title: 'Server routes',
      icon: 'server',
      group: 'Observe',
    },
    {
      path: '/server/requests',
      title: 'Incoming requests',
      icon: 'arrowDownLeft',
      group: 'Observe',
    },
  ],
  http: [
    {
      path: '/http/compose',
      title: 'Request studio',
      icon: 'send',
      group: 'Tools',
    },
    {
      path: '/http/history',
      title: 'Outbound traffic',
      icon: 'arrowUpRight',
      group: 'Observe',
    },
  ],
  insight: [
    { path: '/graph', title: 'Service map', icon: 'network', group: 'Observe' },
  ],
  sso: [
    { path: '/sso', title: 'Your account', icon: 'account', group: 'Accounts' },
  ],
}
const builtins: Record<string, ComponentType<PageProps>> = {
  sso: lazy(() => import('./pages/sso.js')),
  market: lazy(() => import('./pages/market.js')),
  insight: lazy(() => import('./pages/insight.js')),
  server: lazy(() => import('./pages/server.js')),
  http: lazy(() => import('./pages/http.js')),
  notifications: lazy(() => import('./pages/notifications.js')),
  logs: lazy(() => import('./pages/logs.js')),
  database: lazy(() => import('./pages/database.js')),
  loader: lazy(() => import('./pages/loader.js')),
}
/** Preferred navigation order; unknown groups follow in discovery order. */
export const groupOrder = [
  'Workspace',
  'Accounts',
  'Manage',
  'Observe',
  'Tools',
  'Extensions',
]

export function orderOf(group: string): number {
  const index = groupOrder.indexOf(group)
  return index < 0 ? groupOrder.length : index
}

export function listPages(
  entries: Record<string, EntryMeta>,
): RegisteredPage[] {
  const seen = new Set<string>()
  const pages: RegisteredPage[] = []
  for (const [entryId, entry] of Object.entries(entries)) {
    const declared = known[entry.module]
    const candidates =
      entry.pages ??
      declared ??
      entry.routes.map((path) => ({
        path: path.replace(/\{.*$/, ''),
        title: path.split('/').filter(Boolean).join(' · '),
        icon: 'extension',
        group: 'Extensions',
      }))
    for (const page of candidates) {
      // Two entries can expose the same route (a plugin bundled twice, or a page that is
      // also registered elsewhere); the first registration wins so navigation has no
      // duplicates and every path stays unique as a component key.
      if (seen.has(page.path)) continue
      seen.add(page.path)
      pages.push({
        ...page,
        icon: page.icon,
        group: page.group ?? 'Extensions',
        entryId,
        module: entry.module,
        source: declared ? 'Built-in' : entry.module.replace(/^@[^/]+\//, ''),
      })
    }
  }
  return pages.sort((left, right) => orderOf(left.group) - orderOf(right.group))
}

const extensions = new Map<
  string,
  {
    component: ComponentType<PageProps>
    entryId: string
    links: HTMLLinkElement[]
  }
>()
export function reconcileExtensions(entries: Record<string, EntryMeta>) {
  const signatures = Object.fromEntries(
    Object.entries(entries).map(([id, entry]) => [
      id,
      entry.files.join(',') + ':',
    ]),
  )
  for (const [key, value] of extensions)
    if (
      !signatures[value.entryId] ||
      !key.startsWith(signatures[value.entryId])
    ) {
      for (const link of value.links) link.remove()
      extensions.delete(key)
    }
}
function extensionPage(
  entry: EntryMeta | undefined,
  route: string,
  entryId: string,
): ComponentType<PageProps> | undefined {
  if (!entry?.files.some((file) => /\.m?js$/.test(file))) return
  const key = entry.files.join(',') + ':' + route
  if (!extensions.has(key)) {
    const links: HTMLLinkElement[] = []
    const component = lazy(async () => {
      // Explicit third-party manifests are trusted plugin code, just like server plugins.
      for (const href of entry.files.filter((file) => file.endsWith('.css'))) {
        if (
          !Array.from(document.querySelectorAll('link[rel=stylesheet]')).some(
            (link) =>
              (link as HTMLLinkElement).href ===
              new URL(href, location.href).href,
          )
        ) {
          const link = document.createElement('link')
          link.rel = 'stylesheet'
          link.href = href
          document.head.append(link)
          links.push(link)
        }
      }
      const modules: ClientModule[] = await Promise.all(
        entry.files
          .filter((file) => /\.m?js$/.test(file))
          .map(async (file) => {
            const loaded = await import(/* @vite-ignore */ file)
            return loaded.default ?? loaded
          }),
      )
      const page = modules
        .flatMap((module) => module.pages ?? [])
        .find((page) => page.path === route)
      if (!page)
        throw new Error('The React extension did not register this page')
      return { default: page.component }
    })
    extensions.set(key, { component, entryId, links })
  }
  return extensions.get(key)?.component
}

class PageErrorBoundary extends Component<
  { children: ReactNode; onReset: () => void; resetKey: string },
  { error: Error | undefined }
> {
  state = { error: undefined as Error | undefined }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidUpdate(previous: { resetKey: string }) {
    if (previous.resetKey !== this.props.resetKey && this.state.error)
      this.setState({ error: undefined })
  }
  render() {
    if (this.state.error)
      return (
        <div className="panel empty-state" role="alert">
          <h2>This page could not load</h2>
          <p>{String(this.state.error)}</p>
          <button
            className="button tonal"
            onClick={() => {
              this.setState({ error: undefined })
              this.props.onReset()
            }}
          >
            Try again
          </button>
        </div>
      )
    return this.props.children
  }
}

export function PageOutlet({ path }: { path: string }) {
  const connection = useConnection()
  const { entries } = useConnectionState()
  const [attempt, setAttempt] = useState(0)
  const selected = useMemo(
    () =>
      listPages(entries)
        .filter(
          (page) => path === page.path || path.startsWith(page.path + '/'),
        )
        .sort((a, b) => b.path.length - a.path.length)[0],
    [entries, path],
  )
  const Page = useMemo(() => {
    if (!selected) return
    return (
      builtins[selected.module] ??
      extensionPage(entries[selected.entryId], selected.path, selected.entryId)
    )
  }, [selected?.entryId, selected?.path, entries])
  useEffect(() => reconcileExtensions(entries), [entries])
  const resetKey = (selected?.entryId ?? '') + ':' + (selected?.path ?? '')
  return (
    <PageErrorBoundary
      resetKey={resetKey}
      onReset={() => setAttempt(attempt + 1)}
    >
      <Suspense
        fallback={
          <div className="loading" role="status">
            Opening your workspace…
          </div>
        }
      >
        {Page && selected ? (
          <Page key={resetKey} entryId={selected.entryId} path={path} />
        ) : (
          <section className="panel empty-state">
            <h1>Page not available</h1>
            <p>This extension has not registered a React page.</p>
          </section>
        )}
      </Suspense>
    </PageErrorBoundary>
  )
}
