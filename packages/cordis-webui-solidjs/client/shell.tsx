/** @jsxImportSource solid-js */
import { createSignal, onCleanup, For, Show } from 'solid-js'
import { navigate, useConnection } from './sdk.js'

export function App() {
  const connection = useConnection()
  const [path, setPath] = createSignal(location.pathname.slice(connection.config.uiPath.length) || '/')
  const [menu, setMenu] = createSignal(false)
  const updatePath = () => { setPath(location.pathname.slice(connection.config.uiPath.length) || '/'); setMenu(false) }
  window.addEventListener('popstate', updatePath)
  onCleanup(() => window.removeEventListener('popstate', updatePath))
  const go = (route: string) => navigate(connection.config.uiPath + route)
  const entries = () => Object.entries(connection.state.entries)
  return <div class="app-shell">
    <a class="skip-link" href="#main">Skip to content</a>
    <Show when={menu()}><button class="nav-scrim" aria-label="Close navigation" onClick={() => setMenu(false)} /></Show>
    <aside class="navigation" classList={{ open: menu() }} aria-label="Primary navigation">
      <a class="brand" href={connection.config.uiPath + '/'} onClick={event => { event.preventDefault(); go('/') }}><span class="brand-mark">C</span><span>{connection.config.title}<small>YOUR CONNECTED SPACE</small></span></a>
      <div class="nav-label">Workspace</div>
      <button class="nav-item" classList={{ selected: path() === '/' }} onClick={() => go('/')}><span class="nav-icon">◈</span>Overview</button>
      <div class="nav-label">Extensions</div>
      <For each={entries()}>{([id, entry]) => <For each={entry.routes.filter(route => !route.includes('{') && !route.includes(':'))}>{route =>
        <button class="nav-item" classList={{ selected: path() === route }} onClick={() => go(route)}><span class="nav-icon">◇</span>{route.split('/').filter(Boolean).join(' · ')}</button>
      }</For>}</For>
      <div class="nav-spacer" />
      <button class="nav-item" onClick={() => go('/settings')}><span class="nav-icon">☷</span>Appearance</button>
      <div class="connection-pill" role="status"><span class="status-dot" classList={{ online: connection.state.status === 'connected' }} />{connection.state.status}</div>
    </aside>
    <div class="workspace">
      <header class="topbar"><button class="icon-button mobile-menu" aria-label="Open navigation" aria-expanded={menu()} onClick={() => setMenu(true)}>☰</button><span class="breadcrumb">Workspace <span>/</span> {path() === '/' ? 'Overview' : path().slice(1)}</span><span class="topbar-end">SOLID EDITION</span></header>
      <main id="main" tabindex="-1">
        <Show when={connection.state.error}><div class="notice error" role="alert">{connection.state.error}</div></Show>
        <Show when={connection.state.status === 'reconnecting'}><div class="notice" role="status">Reconnecting… Your place is saved. Actions will return when connected.</div></Show>
        <Show when={path() === '/'} fallback={<section class="panel empty-state"><span class="eyebrow">WORKSPACE</span><h1>{path() === '/settings' ? 'Make yourself at home' : 'Page not available'}</h1><p>{path() === '/settings' ? 'The interface follows your device’s light and dark appearance.' : 'This extension has not registered a Solid page yet.'}</p><button class="button tonal" onClick={() => go('/')}>Back to overview</button></section>}>
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
