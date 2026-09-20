/** @jsxImportSource solid-js */
import {
  createMemo,
  ErrorBoundary,
  lazy,
  Show,
  Suspense,
  type Component,
} from 'solid-js'
import { Dynamic } from 'solid-js/web'
import type { EntryMeta } from '../src/protocol.js'
import { useConnection, type ClientModule, type PageProps } from './sdk.js'

interface PageMeta {
  path: string
  title: string
  icon: string
  group: string
}
export interface RegisteredPage extends PageMeta {
  entryId: string
  module: string
}
const known: Record<string, PageMeta[]> = {
  bridge: [
    {
      path: '/platform-accounts',
      title: 'Platform accounts',
      icon: '○',
      group: 'Workspace',
    },
    {
      path: '/sticker-packs',
      title: 'Sticker collections',
      icon: '✦',
      group: 'Workspace',
    },
    { path: '/bots', title: 'Your bots', icon: '◇', group: 'Workspace' },
  ],
  statistics: [
    {
      path: '/mtproto-statistics',
      title: 'MTProto statistics',
      icon: '▥',
      group: 'Observe',
    },
  ],
  debug: [
    {
      path: '/mtproto-debug',
      title: 'MTProto capture',
      icon: '⇄',
      group: 'Observe',
    },
  ],
  sso: [{ path: '/sso', title: 'Your account', icon: '○', group: 'Workspace' }],
  market: [
    { path: '/market', title: 'Plugin library', icon: '◈', group: 'Manage' },
    {
      path: '/dependencies',
      title: 'Dependencies',
      icon: '◫',
      group: 'Manage',
    },
  ],
  insight: [
    { path: '/graph', title: 'Service map', icon: '⌬', group: 'Observe' },
  ],
  server: [
    {
      path: '/server/routes',
      title: 'Server routes',
      icon: '⌘',
      group: 'Observe',
    },
    {
      path: '/server/requests',
      title: 'Incoming requests',
      icon: '↙',
      group: 'Observe',
    },
  ],
  http: [
    {
      path: '/http/compose',
      title: 'Request studio',
      icon: '↗',
      group: 'Tools',
    },
    {
      path: '/http/history',
      title: 'Outbound traffic',
      icon: '⇄',
      group: 'Observe',
    },
  ],
  notifications: [
    {
      path: '/notifications',
      title: 'Notifications',
      icon: '♧',
      group: 'Workspace',
    },
  ],
  logs: [{ path: '/logs', title: 'Logs', icon: '≡', group: 'Observe' }],
  database: [
    { path: '/database', title: 'Database', icon: '▤', group: 'Manage' },
  ],
  loader: [{ path: '/plugins', title: 'Plugins', icon: '◫', group: 'Manage' }],
}
const bridgePages: Record<string, Component<PageProps>> = {
  '/platform-accounts': lazy(() => import('./pages/accounts.js')),
  '/sticker-packs': lazy(() => import('./pages/stickers.js')),
  '/bots': lazy(() => import('./pages/bots.js')),
}
const builtins: Record<string, Component<PageProps>> = {
  statistics: lazy(() => import('./pages/statistics.js')),
  debug: lazy(() => import('./pages/capture.js')),
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
export function listPages(
  entries: Record<string, EntryMeta>,
): RegisteredPage[] {
  return Object.entries(entries).flatMap(([entryId, entry]) =>
    (
      known[entry.module] ??
      entry.routes.map((path) => ({
        path: path.replace(/\{.*$/, ''),
        title: path.split('/').filter(Boolean).join(' · '),
        icon: '◇',
        group: 'Extensions',
      }))
    ).map((page) => ({ ...page, entryId, module: entry.module })),
  )
}
const extensions = new Map<
  string,
  { component: Component<PageProps>; entryId: string; links: HTMLLinkElement[] }
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
  entry: EntryMeta,
  route: string,
  entryId: string,
): Component<PageProps> | undefined {
  if (!entry.files.some((file) => /\.m?js$/.test(file))) return
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
            const module = await import(/* @vite-ignore */ file)
            return module.default ?? module
          }),
      )
      const page = modules
        .flatMap((module) => module.pages ?? [])
        .find((page) => page.path === route)
      if (!page)
        throw new Error('The Solid extension did not register this page')
      return { default: page.component }
    })
    extensions.set(key, { component, entryId, links })
  }
  return extensions.get(key)?.component
}
export function PageOutlet(props: { path: string }) {
  const connection = useConnection()
  const selected = createMemo(
    () =>
      listPages(connection.state.entries)
        .filter(
          (page) =>
            props.path === page.path || props.path.startsWith(page.path + '/'),
        )
        .sort((a, b) => b.path.length - a.path.length)[0],
  )
  const component = createMemo(() => {
    const page = selected()
    if (!page) return
    return (
      (page.module === 'bridge'
        ? bridgePages[page.path]
        : builtins[page.module]) ??
      extensionPage(
        connection.state.entries[page.entryId],
        page.path,
        page.entryId,
      )
    )
  })
  return (
    <Show when={selected()?.entryId + ':' + selected()?.path} keyed>
      {(_key) => (
        <ErrorBoundary
          fallback={(error, reset) => (
            <div class="panel empty-state" role="alert">
              <h2>This page could not load</h2>
              <p>{String(error)}</p>
              <button class="button tonal" onClick={reset}>
                Try again
              </button>
            </div>
          )}
        >
          <Suspense
            fallback={
              <div class="loading" role="status">
                Opening your workspace…
              </div>
            }
          >
            <Show
              when={component()}
              fallback={
                <section class="panel empty-state">
                  <h1>Page not available</h1>
                  <p>This extension has not registered a Solid page.</p>
                </section>
              }
            >
              {(Page) => (
                <Dynamic
                  component={Page()}
                  entryId={selected()!.entryId}
                  path={props.path}
                />
              )}
            </Show>
          </Suspense>
        </ErrorBoundary>
      )}
    </Show>
  )
}
