import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Toaster } from 'sonner'
import { Icon } from './icons.js'
import { PageHeader } from './components.js'
import { listPages, orderOf, PageOutlet } from './registry.js'
import {
  approveNavigation,
  navigate,
  useConnection,
  useConnectionState,
} from './sdk.js'
import { useAppearance } from './use-appearance.js'

const SettingsPage = lazy(() => import('./pages/settings.js'))

const statusLabels: Record<string, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
}
function routeOf(uiPath: string) {
  return location.pathname.slice(uiPath.length) || '/'
}
export function App({ initialNotice: bootNotice }: { initialNotice?: string }) {
  const connection = useConnection()
  const state = useConnectionState()
  const [notice, setNotice] = useState(bootNotice)
  const [path, setPath] = useState(() => routeOf(connection.config.uiPath))
  const [menu, setMenu] = useState(false)
  const [mobile, setMobile] = useState(
    () =>
      typeof matchMedia === 'function' &&
      matchMedia('(max-width: 820px)').matches,
  )
  const navigation = useRef<HTMLElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const appearance = useAppearance()
  useEffect(() => {
    const media = matchMedia('(max-width: 820px)')
    const changed = () => setMobile(media.matches)
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])
  useEffect(() => {
    const updatePath = () => {
      setPath(routeOf(connection.config.uiPath))
      setMenu(false)
    }
    window.addEventListener('popstate', updatePath)
    return () => window.removeEventListener('popstate', updatePath)
  }, [connection.config.uiPath])
  useEffect(() => {
    // The shell owns scrolling: switching pages must start at the top instead
    // of inheriting the previous page's offset.
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [path])
  const wasOpen = useRef(false)
  useEffect(() => {
    if (menu && mobile)
      navigation.current?.querySelector<HTMLElement>('a, button')?.focus()
    // Returning focus after the drawer closes must wait for the commit that
    // restores `inert`; focusing during the click handler would be undone when
    // the focused element's ancestor becomes inert.
    if (!menu && wasOpen.current) menuButton.current?.focus()
    wasOpen.current = menu
  }, [menu, mobile])
  const closeMenu = () => setMenu(false)
  const trapFocus = (event: React.KeyboardEvent) => {
    if (!menu || !mobile) return
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu()
      return
    }
    if (event.key !== 'Tab' || !navigation.current) return
    const elements = Array.from(
      navigation.current.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled)',
      ),
    )
    const first = elements[0]
    const last = elements.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }
  const go = (route: string) => navigate(connection.config.uiPath + route)
  const pages = useMemo(() => listPages(state.entries), [state.entries])
  const groups = useMemo(
    () =>
      [...new Set(pages.map((page) => page.group))].sort(
        (left, right) => orderOf(left) - orderOf(right),
      ),
    [pages],
  )
  const entries = Object.entries(state.entries)
  const status = state.status
  const currentTitle = useMemo(() => {
    if (path === '/') return 'Overview'
    if (path === '/settings') return 'Appearance'
    const page = pages
      .filter((item) => path === item.path || path.startsWith(item.path + '/'))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (page) return page.title
    return path
      .replace(/^\//, '')
      .split(/[/-]/)
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(' ')
  }, [path, pages])
  const isSelected = (target: string) =>
    path === target || (target !== '/' && path.startsWith(target + '/'))
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      {menu ? (
        <button
          className="nav-scrim"
          aria-label="Close navigation"
          onClick={closeMenu}
        />
      ) : null}
      <aside
        ref={navigation}
        inert={mobile && !menu}
        onKeyDown={trapFocus}
        role={mobile && menu ? 'dialog' : undefined}
        aria-modal={mobile && menu ? true : undefined}
        className={'navigation' + (menu ? ' open' : '')}
        aria-label="Primary navigation"
      >
        <a
          className="brand"
          href={connection.config.uiPath + '/'}
          onClick={(event) => {
            event.preventDefault()
            go('/')
          }}
        >
          <span className="brand-mark" aria-hidden="true">
            {connection.config.title.slice(0, 1).toUpperCase()}
          </span>
          <span>
            {connection.config.title}
            <small>Relay console</small>
          </span>
        </a>
        <nav aria-label="Workspace">
          <button
            className={'nav-item' + (isSelected('/') ? ' selected' : '')}
            aria-current={isSelected('/') ? 'page' : undefined}
            onClick={() => go('/')}
          >
            <Icon name="overview" size={18} />
            Overview
          </button>
          {groups.map((group) => (
            <div key={group} className="nav-group">
              <div className="nav-label">{group}</div>
              {pages
                .filter((page) => page.group === group)
                .map((page) => (
                  <button
                    key={page.entryId + ':' + page.path}
                    className={
                      'nav-item' + (isSelected(page.path) ? ' selected' : '')
                    }
                    aria-current={isSelected(page.path) ? 'page' : undefined}
                    onClick={() => go(page.path)}
                  >
                    <Icon name={page.icon} size={18} />
                    {page.title}
                  </button>
                ))}
            </div>
          ))}
        </nav>
        <div className="nav-spacer" />
        <div className="sidebar-footer">
          <button
            className={'nav-item' + (path === '/settings' ? ' selected' : '')}
            onClick={() => go('/settings')}
          >
            <Icon name="settings" size={18} />
            Appearance
          </button>
          <div className="connection-pill" data-status={status} role="status">
            <span
              className={
                'status-dot' + (status === 'connected' ? ' online' : '')
              }
            />
            {statusLabels[status] ?? status}
          </div>
        </div>
      </aside>
      <div className="workspace" inert={mobile && menu}>
        <header className="topbar">
          <button
            ref={menuButton}
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            aria-expanded={menu}
            onClick={() => setMenu(true)}
          >
            <Icon name="menu" />
          </button>
          <div className="breadcrumb">
            <button
              className="crumb-root"
              onClick={() => go('/')}
              aria-label="Go to overview"
            >
              {connection.config.title}
            </button>
            <span aria-hidden="true">/</span>
            <span className="crumb-current">{currentTitle}</span>
          </div>
          <div className="topbar-actions">
            <span
              className="topbar-status"
              data-status={status}
              title="Live connection state"
            >
              <span
                className={
                  'status-dot' + (status === 'connected' ? ' online' : '')
                }
              />
              {statusLabels[status] ?? status}
            </span>
            <button
              className="icon-button"
              aria-label="Appearance settings"
              onClick={() => go('/settings')}
            >
              <Icon name="palette" />
            </button>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {notice ? (
            <div className="notice error" role="alert">
              <Icon name="alert" />
              <span>{notice}</span>
              <button
                className="button outlined"
                onClick={() => setNotice(undefined)}
              >
                Dismiss
              </button>
            </div>
          ) : null}
          {state.updateAvailable ? (
            <div className="notice" role="status">
              <Icon name="info" />
              <span>A new WebUI build is ready to load.</span>
              <button
                className="button filled"
                onClick={() => {
                  if (approveNavigation()) location.reload()
                }}
              >
                Reload
              </button>
            </div>
          ) : null}
          {state.error ? (
            <div className="notice error" role="alert">
              <Icon name="alert" />
              <span>{state.error}</span>
            </div>
          ) : null}
          {status === 'reconnecting' ? (
            <div className="notice" role="status">
              <Icon name="refresh" />
              <span>
                Reconnecting. Your position is saved and actions resume
                automatically.
              </span>
            </div>
          ) : null}
          {path === '/' ? (
            <>
              <PageHeader
                title="Overview"
                description="Everything this relay is running, and every page it exposes."
              />
              <section className="stat-row" aria-label="Workspace summary">
                <article className="panel stat-tile">
                  <Icon name="plug" />
                  <div className="stat-tile-body">
                    <span className="eyebrow">Connection</span>
                    <strong>{statusLabels[status] ?? status}</strong>
                    <span>Live Muon channel</span>
                  </div>
                </article>
                <article className="panel stat-tile">
                  <Icon name="layers" />
                  <div className="stat-tile-body">
                    <span className="eyebrow">Extensions</span>
                    <strong>{entries.length}</strong>
                    <span>
                      {pages.length} {pages.length === 1 ? 'page' : 'pages'}{' '}
                      available
                    </span>
                  </div>
                </article>
                <article className="panel stat-tile">
                  <Icon name="cpu" />
                  <div className="stat-tile-body">
                    <span className="eyebrow">Build</span>
                    <strong>
                      {connection.config.buildId ?? 'development'}
                    </strong>
                    <span>Reload prompt when it changes</span>
                  </div>
                </article>
              </section>
              {pages.length ? (
                groups.map((group) => (
                  <section key={group}>
                    <div className="section-heading">
                      <h2>{group}</h2>
                      <span className="muted">
                        {pages.filter((page) => page.group === group).length}{' '}
                        {pages.filter((page) => page.group === group).length ===
                        1
                          ? 'page'
                          : 'pages'}
                      </span>
                    </div>
                    <div className="page-grid">
                      {pages
                        .filter((page) => page.group === group)
                        .map((page) => (
                          <button
                            key={page.entryId + ':' + page.path}
                            className="page-card"
                            onClick={() => go(page.path)}
                          >
                            <span className="page-card-icon">
                              <Icon name={page.icon} size={18} />
                            </span>
                            <span className="page-card-body">
                              <strong>{page.title}</strong>
                              <small>{page.source}</small>
                            </span>
                            <Icon name="chevronRight" size={16} />
                          </button>
                        ))}
                    </div>
                  </section>
                ))
              ) : (
                <section className="panel empty-state">
                  <Icon name="plugins" size={22} />
                  <h2>No pages yet</h2>
                  <p>
                    Enabled plugins register their pages here automatically.
                  </p>
                  <button
                    className="button filled"
                    onClick={() => go('/plugins')}
                  >
                    Open plugin manager
                  </button>
                </section>
              )}
            </>
          ) : path === '/settings' ? (
            <Suspense
              fallback={<div className="loading">Opening appearance…</div>}
            >
              <SettingsPage />
            </Suspense>
          ) : (
            <PageOutlet path={path} />
          )}
        </main>
        <footer className="footer">
          <span>{connection.config.title}</span>
          <span aria-hidden="true">·</span>
          <span>
            WebUI build{' '}
            <code>{connection.config.buildId ?? 'development'}</code>
          </span>
        </footer>
      </div>
      <Toaster
        position="top-center"
        theme={
          appearance.appearance === 'system' ? 'system' : appearance.appearance
        }
        toastOptions={{ className: 'webui-toast' }}
      />
    </div>
  )
}
