/** @jsxImportSource solid-js */
import { createMemo, ErrorBoundary, lazy, Show, Suspense, type Component } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import type { EntryMeta } from '../src/protocol.js'
import { useConnection, type ClientModule, type PageProps } from './sdk.js'

interface PageMeta { path: string; title: string; icon: string; group: string }
export interface RegisteredPage extends PageMeta { entryId: string; module: string }
const known: Record<string, PageMeta[]> = {
  loader: [{ path: '/plugins', title: 'Plugins', icon: '◫', group: 'Manage' }],
}
const builtins: Record<string, Component<PageProps>> = {
  loader: lazy(() => import('./pages/loader.js')),
}
export function listPages(entries: Record<string, EntryMeta>): RegisteredPage[] {
  return Object.entries(entries).flatMap(([entryId, entry]) => (known[entry.module] ?? entry.routes.map(path => ({ path: path.replace(/\{.*$/, ''), title: path.split('/').filter(Boolean).join(' · '), icon: '◇', group: 'Extensions' }))).map(page => ({ ...page, entryId, module: entry.module })))
}
const extensions = new Map<string, Component<PageProps>>()
function extensionPage(entry: EntryMeta, route: string): Component<PageProps> | undefined {
  if (!entry.files.some(file => /\.m?js$/.test(file))) return
  const key = entry.files.join(',') + ':' + route
  if (!extensions.has(key)) extensions.set(key, lazy(async () => {
    // Explicit third-party manifests are trusted plugin code, just like server plugins.
    for (const href of entry.files.filter(file => file.endsWith('.css'))) {
      if (!Array.from(document.querySelectorAll('link[rel=stylesheet]')).some(link => (link as HTMLLinkElement).href === new URL(href, location.href).href)) {
        const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href; document.head.append(link)
      }
    }
    const modules: ClientModule[] = await Promise.all(entry.files.filter(file => /\.m?js$/.test(file)).map(async file => {
      const module = await import(/* @vite-ignore */ file); return module.default ?? module
    }))
    const page = modules.flatMap(module => module.pages ?? []).find(page => page.path === route)
    if (!page) throw new Error('The Solid extension did not register this page')
    return { default: page.component }
  }))
  return extensions.get(key)
}
export function PageOutlet(props: { path: string }) {
  const connection = useConnection()
  const selected = createMemo(() => listPages(connection.state.entries).filter(page => props.path === page.path || props.path.startsWith(page.path + '/')).sort((a, b) => b.path.length - a.path.length)[0])
  const component = createMemo(() => {
    const page = selected()
    if (!page) return
    return builtins[page.module] ?? extensionPage(connection.state.entries[page.entryId], page.path)
  })
  return <Show when={selected()?.entryId + ':' + selected()?.path} keyed>{_key => <ErrorBoundary fallback={(error, reset) => <div class="panel empty-state" role="alert"><h2>This page could not load</h2><p>{String(error)}</p><button class="button tonal" onClick={reset}>Try again</button></div>}><Suspense fallback={<div class="loading" role="status">Opening your workspace…</div>}><Show when={component()} fallback={<section class="panel empty-state"><h1>Page not available</h1><p>This extension has not registered a Solid page.</p></section>}>{Page => <Dynamic component={Page()} entryId={selected()!.entryId} path={props.path} />}</Show></Suspense></ErrorBoundary>}</Show>
}
