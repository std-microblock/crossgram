/** @jsxImportSource solid-js */
import { createEffect, createSignal, lazy, Suspense, onCleanup, For, Show } from 'solid-js'
import { listPages, PageOutlet } from './registry.js'
import { navigate, useConnection } from './sdk.js'

const SettingsPage = lazy(() => import('./pages/settings.js'))

export function App() {
  const connection = useConnection()
  const [path, setPath] = createSignal(location.pathname.slice(connection.config.uiPath.length) || '/')
  const [menu, setMenu] = createSignal(false)
  const media = matchMedia('(max-width: 760px)')
  const [mobile, setMobile] = createSignal(media.matches)
  let navigation!: HTMLElement, menuButton!: HTMLButtonElement
  const mediaChanged = () => setMobile(media.matches)
  media.addEventListener('change', mediaChanged)
  onCleanup(() => media.removeEventListener('change', mediaChanged))
  createEffect(() => { if (menu() && mobile()) navigation.querySelector<HTMLElement>('a, button')?.focus() })
  const closeMenu = () => { setMenu(false); menuButton?.focus() }
  const trapFocus = (event: KeyboardEvent) => {
    if (!menu() || !mobile()) return
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return }
    if (event.key !== 'Tab') return
    const elements = Array.from(navigation.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)'))
    const first = elements[0], last = elements.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  const updatePath = () => { setPath(location.pathname.slice(connection.config.uiPath.length) || '/'); setMenu(false) }
  window.addEventListener('popstate', updatePath)
  onCleanup(() => window.removeEventListener('popstate', updatePath))
  const go = (route: string) => navigate(connection.config.uiPath + route)
  const pages = () => listPages(connection.state.entries)
  const entries = () => Object.entries(connection.state.entries)
  return <div class="app-shell">
    <a class="skip-link" href="#main">Skip to content</a>
    <Show when={menu()}><button class="nav-scrim" aria-label="Close navigation" onClick={closeMenu} /></Show>
    <aside ref={navigation} inert={mobile() && !menu()} onKeyDown={trapFocus} role={mobile() && menu() ? 'dialog' : undefined} aria-modal={mobile() && menu() ? true : undefined} class="navigation" classList={{ open: menu() }} aria-label="Primary navigation">
      <a class="brand" href={connection.config.uiPath + '/'} onClick={event => { event.preventDefault(); go('/') }}><span class="brand-mark">C</span><span>{connection.config.title}<small>YOUR CONNECTED SPACE</small></span></a>
      <div class="nav-label">Workspace</div>
      <button class="nav-item" classList={{ selected: path() === '/' }} onClick={() => go('/')}><span class="nav-icon">◈</span>Overview</button>
      <div class="nav-label">Extensions</div>
      <For each={pages()}>{page => <button class="nav-item" classList={{ selected: path() === page.path || path().startsWith(page.path + '/') }} onClick={() => go(page.path)}><span class="nav-icon">{page.icon}</span>{page.title}</button>}</For>
      <div class="nav-spacer" />
      <button class="nav-item" onClick={() => go('/settings')}><span class="nav-icon">☷</span>Appearance</button>
      <div class="connection-pill" role="status"><span class="status-dot" classList={{ online: connection.state.status === 'connected' }} />{connection.state.status}</div>
    </aside>
    <div class="workspace" inert={mobile() && menu()}>
      <header class="topbar"><button ref={menuButton} class="icon-button mobile-menu" aria-label="Open navigation" aria-expanded={menu()} onClick={() => setMenu(true)}>☰</button><span class="breadcrumb">Workspace <span>/</span> {path() === '/' ? 'Overview' : path().slice(1)}</span><span class="topbar-end">SOLID EDITION</span></header>
      <main id="main" tabindex="-1">
        <Show when={connection.state.error}><div class="notice error" role="alert">{connection.state.error}</div></Show>
        <Show when={connection.state.status === 'reconnecting'}><div class="notice" role="status">Reconnecting… Your place is saved. Actions will return when connected.</div></Show>
        <Show when={path() === '/'} fallback={<Show when={path() === '/settings'} fallback={<PageOutlet path={path()} />}><Suspense fallback={<div class="loading">Opening appearance…</div>}><SettingsPage /></Suspense></Show>}>
          <section class="hero"><div><span class="eyebrow">A LITTLE MORE CONNECTED</span><h1>Your space.<br /><em>In sync.</em></h1><p>A calmer place to manage your bridges, watch your services, and keep conversations flowing.</p><button class="button filled" onClick={() => go('/plugins')}>Manage plugins <span aria-hidden="true">↗</span></button></div><div class="hero-art" aria-hidden="true"><div class="orbit orbit-one" /><div class="orbit orbit-two" /><div class="orbit-core">C</div><span class="orbit-satellite one">↗</span><span class="orbit-satellite two">✦</span></div></section>
          <section class="metric-grid" aria-label="Workspace summary"><article class="panel metric"><span class="eyebrow">CONNECTION</span><strong class="metric-text">{connection.state.status === 'connected' ? 'All connected' : 'Getting ready'}</strong><p>One lightweight, live connection</p></article><article class="panel metric"><span class="eyebrow">EXTENSIONS</span><strong>{entries().length}</strong><p>Available in your workspace</p></article><article class="panel metric"><span class="eyebrow">DESIGNED TO BREATHE</span><strong class="metric-text">Less work.<br />More flow.</strong><p>Pages load only when you need them</p></article></section>
          <div class="section-heading"><div><span class="eyebrow">AT YOUR FINGERTIPS</span><h2>Your workspace</h2></div><span class="muted">Live, without the noise</span></div>
          <div class="quick-grid"><For each={entries()}>{([id, entry]) => <button class="panel quick-card" onClick={() => go(entry.routes[0]?.replace(/\{.*$/, '') || '/notifications')}><span class="quick-icon">◇</span><h3>{entry.module}</h3><p>{entry.methods.length} available actions</p><span class="quick-arrow" aria-hidden="true">↗</span></button>}</For><Show when={!entries().length}><div class="panel empty-state"><h3>Your workspace is getting ready</h3><p>Enabled plugin pages will appear here automatically.</p></div></Show></div>
        </Show>
      </main>
      <footer>Crossgram <span>•</span> Less friction. More connection.</footer>
    </div>
  </div>
}
