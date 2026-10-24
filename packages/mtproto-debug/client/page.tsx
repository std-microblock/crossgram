import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { CapturedMtprotoEvent, MtprotoDebugData } from '../src/types.js'
import {
  completeEventGroup,
  getRpcResultMetrics,
  groupRpcEvents,
} from '../src/event-groups.js'
import { useRpc, type PageProps } from 'cordis-webui-react/client'
import { Icon } from 'cordis-webui-react/icons'
import {
  ActionError,
  ConfirmAction,
  LiveContent,
  Modal,
  Notice,
  formatBytes,
  useAction,
} from 'cordis-webui-react/components'
import { useCapturePages, type CaptureFilters } from './capture.js'
import {
  currentLogDownloadUrl,
  deleteRecording,
  listRecordings,
  recordingDownloadUrl,
  saveRecording,
  type SavedLogs,
} from './recordings.js'
import { copyText, formatMs, sameOriginPath } from 'cordis-webui-react/utils'

/** Distance from the bottom that still counts as "tailing the newest event". */
const TAIL_BOTTOM_SLACK_PX = 24
/** Distance from the top that starts loading the previous page of events. */
const OLDER_TRIGGER_PX = 80

type SaveMenu = { id: number, x: number, y: number }

export default function CapturePage(props: PageProps) {
  const rpc = useRpc<MtprotoDebugData>(props.entryId)
  const action = useAction()
  const save = useAction()
  const logs = useAction()
  const [filters, setFilters] = useState<CaptureFilters>({})
  const [expanded, setExpanded] = useState<number | undefined>(undefined)
  const [pane, setPane] = useState<'event' | 'result'>('event')
  const [showFilters, setShowFilters] = useState(false)
  const [flash, setFlash] = useState('')
  const [menu, setMenu] = useState<SaveMenu>()
  const [moreOpen, setMoreOpen] = useState(false)
  const [clearArmed, setClearArmed] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [logName, setLogName] = useState('')
  const [savedLogs, setSavedLogs] = useState<SavedLogs>()
  const [follow, setFollow] = useState(true)
  const [newCount, setNewCount] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const clearRef = useRef<HTMLButtonElement>(null)
  const capture = useCapturePages(
    rpc.data.apiPath,
    filters,
    rpc.ready,
    rpc.data.revision,
  )
  const groups = useMemo(
    () =>
      new Map(
        groupRpcEvents(capture.events).map((group) => [group.event.id, group]),
      ),
    [capture.events],
  )
  // The list tails the buffer: oldest event on top, newest at the bottom, so an
  // arriving event never pushes what the operator is reading out of place.
  const ids = useMemo(() => [...groups.keys()], [groups])
  const newestId = ids.at(-1)
  const followRef = useRef(follow)
  const newestSeen = useRef<number | undefined>(undefined)
  followRef.current = follow
  useEffect(() => {
    if (expanded !== undefined && !groups.has(expanded)) {
      setExpanded(undefined)
      capture.keepDetails([])
    }
    // `capture` reads through refs, so only the window identity matters here.
  }, [expanded, groups])
  const setFilter = (key: keyof CaptureFilters, value: string) =>
    setFilters((previous) => ({ ...previous, [key]: value }))
  const filterType = (mode: 'include' | 'exclude', name: string) =>
    setFilters((value) => ({
      ...value,
      typeName: mode === 'include' ? name : '',
      excludeName: mode === 'exclude' ? name : '',
    }))
  const select = (id: number | undefined) => {
    setPane('event')
    if (id === undefined) {
      setExpanded(undefined)
      capture.keepDetails([])
      return
    }
    const group = groups.get(id)
    if (!group) return
    setExpanded(id)
    // A row that is itself an RPC result opens on its own payload; the request
    // stays one tab away once the counterpart is available.
    setPane(group.event.requestMessageId ? 'result' : 'event')
    capture.keepDetails([id, ...(group.result ? [group.result.id] : [])])
    void capture.loadDetails(group.event)
    if (group.result) void capture.loadDetails(group.result)
    // Without a result in the window the other half is missing, not absent:
    // fetch it so the inspector can still switch between request and result.
    else void capture.loadPair(group.event)
  }
  const rawLink = (id: number) => {
    const url = new URL(sameOriginPath(rpc.data.apiPath))
    url.searchParams.set('id', String(id))
    url.searchParams.set('limit', '1')
    return url.href
  }
  const filtersKey = JSON.stringify(filters)
  useEffect(() => {
    // A new filter starts a new window at the newest event.
    setExpanded(undefined)
    capture.keepDetails([])
    setFollow(true)
    setNewCount(0)
    requestAnimationFrame(() => {
      if (list.current) list.current.scrollTop = list.current.scrollHeight
    })
    // `capture` is a stable imperative handle; only the filter identity matters.
  }, [filtersKey])
  const tailToLatest = useCallback(() => {
    setFollow(true)
    setNewCount(0)
    requestAnimationFrame(() => {
      const element = list.current
      if (element) element.scrollTop = element.scrollHeight
    })
  }, [])
  const onScroll = () => {
    const element = list.current
    if (!element) return
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <=
      TAIL_BOTTOM_SLACK_PX
    if (atBottom !== followRef.current) {
      followRef.current = atBottom
      setFollow(atBottom)
      if (atBottom) {
        setNewCount(0)
        newestSeen.current = newestId
      } else newestSeen.current ??= newestId
    }
    if (element.scrollTop <= OLDER_TRIGGER_PX)
      if (capture.snapshot?.hasOlder && !capture.loading) void capture.load('older')
  }
  useEffect(() => {
    const element = list.current
    if (!element || newestId === undefined) return
    if (followRef.current) {
      element.scrollTop = element.scrollHeight
      newestSeen.current = newestId
    } else if (newestSeen.current !== undefined) {
      setNewCount(ids.filter((id) => id > newestSeen.current!).length)
    }
    // `ids` changes identity on every page, so scroll only when the tail moved.
  }, [newestId])
  useEffect(() => {
    // A filtered window can be shorter than the viewport; keep paging so the
    // scroll handler has somewhere to go.
    const element = list.current
    if (!element || capture.loading || !capture.snapshot?.hasOlder) return
    if (element.scrollHeight <= element.clientHeight + 1) void capture.load('older')
  }, [capture.events.length, capture.loading, capture.snapshot?.hasOlder])
  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(''), 2200)
    return () => clearTimeout(timer)
  }, [flash])
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(undefined)
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    // Opening the menu selects the event, which can resize the list and emit a
    // scroll as the browser keeps the selected row in view. Ignore scrolls from
    // that first layout, and only react to the list itself: scrolling inside the
    // menu (a keyboard focus or a long menu) must not dismiss it.
    const opened = performance.now()
    const scrolled = () => {
      if (performance.now() - opened > 150) close()
    }
    const target = list.current
    window.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', key)
    window.addEventListener('resize', close)
    target?.addEventListener('scroll', scrolled)
    requestAnimationFrame(() =>
      menuRef.current
        ?.querySelector<HTMLButtonElement>(
          '.capture-menu-item:not(:disabled)',
        )
        ?.focus(),
    )
    return () => {
      window.removeEventListener('pointerdown', outside)
      window.removeEventListener('keydown', key)
      window.removeEventListener('resize', close)
      target?.removeEventListener('scroll', scrolled)
    }
  }, [menu])
  useEffect(() => {
    if (!moreOpen) return
    const outside = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false)
    }
    window.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', outside)
      window.removeEventListener('keydown', key)
    }
  }, [moreOpen])
  useEffect(() => {
    if (!clearArmed) return
    // The clear button is always on screen, so its armed state is deliberately
    // short-lived: it drops on a timer, on Escape and as soon as the operator
    // reaches for anything else.
    const timer = setTimeout(() => setClearArmed(false), 5000)
    const outside = (event: PointerEvent) => {
      if (!clearRef.current?.contains(event.target as Node)) {
        setClearArmed(false)
      }
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setClearArmed(false)
    }
    window.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', key)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointerdown', outside)
      window.removeEventListener('keydown', key)
    }
  }, [clearArmed])
  const copy = async (label: string, value: string) => {
    try {
      await copyText(value)
      setFlash('Copied ' + label)
    } catch {
      setFlash('Copy failed')
    }
    setMenu(undefined)
  }
  const refreshLogs = async () => {
    const loaded = await logs.run(() =>
      listRecordings(rpc.data.recordingsApiPath),
    )
    if (loaded) setSavedLogs(loaded)
  }
  useEffect(() => {
    if (!rpc.ready) return
    void refreshLogs()
    // Load the saved-log index once per page, mostly for the header count.
  }, [rpc.ready])
  const openSave = (name?: string) => {
    save.clear()
    setLogName(name ?? '')
    setSaveOpen(true)
    if (!savedLogs) void refreshLogs()
  }
  const openMenuFor = (id: number, x: number, y: number) => {
    if (expanded !== id) select(id)
    setMoreOpen(false)
    setMenu({ id, x, y })
  }
  const submitLog = () =>
    void save.run(async () => {
      const recording = await saveRecording(
        rpc.data.recordingsApiPath,
        logName,
      )
      setSaveOpen(false)
      setLogName('')
      setFlash('Saved log ' + (recording.label ?? recording.fileName))
      setLogsOpen(true)
      await refreshLogs()
    })
  const openLogs = () => {
    logs.clear()
    setLogsOpen(true)
    void refreshLogs()
  }
  // Clearing is destructive but frequent while debugging, so it lives on the
  // toolbar with the confirmation in the button itself: the first click arms
  // it, the second one drops the buffer.
  const clearBuffer = () => {
    if (!clearArmed) {
      setClearArmed(true)
      return
    }
    setClearArmed(false)
    void action.run(async () => {
      await rpc.data.clear()
      select(undefined)
      setNewCount(0)
      await capture.load('latest')
    })
  }
  const total = capture.snapshot?.total ?? 0
  const shown = capture.events.length
  const maxEvents = rpc.data.maxEvents ?? 0
  const dropped = rpc.data.dropped ?? 0
  const recordingCount = savedLogs?.recordings.length ?? 0
  const chips: { key: keyof CaptureFilters, label: string }[] = []
  if (filters.typeName)
    chips.push({ key: 'typeName', label: 'Only: ' + filters.typeName })
  if (filters.excludeName)
    chips.push({ key: 'excludeName', label: 'Exclude: ' + filters.excludeName })
  if (filters.connectionId)
    chips.push({ key: 'connectionId', label: 'Connection: ' + filters.connectionId })
  if (filters.since)
    chips.push({ key: 'since', label: 'Since: ' + filters.since })
  if (filters.field)
    chips.push({ key: 'field', label: 'Field: ' + filters.field })
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (expanded !== undefined) {
        event.preventDefault()
        select(undefined)
      }
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (!ids.length) return
    event.preventDefault()
    const current = expanded === undefined ? -1 : ids.indexOf(expanded)
    const next =
      event.key === 'ArrowDown'
        ? Math.min(ids.length - 1, current + 1)
        : Math.max(0, current - 1)
    if (ids[next] !== undefined && ids[next] !== expanded) {
      select(ids[next])
      requestAnimationFrame(() =>
        list.current
          ?.querySelector('tr[aria-selected="true"]')
          ?.scrollIntoView({ block: 'nearest' }),
      )
    }
  }
  const menuGroup = menu ? groups.get(menu.id) : undefined
  const menuEvent = menu
    ? (capture.details.get(menu.id) ?? menuGroup?.event)
    : undefined
  const menuResult =
    menuGroup?.result &&
    (capture.details.get(menuGroup.result.id) ?? menuGroup.result)
  const selected = expanded === undefined ? undefined : groups.get(expanded)
  // The pair can live outside the window: a direction/grep filter or a page
  // boundary hides one half of the RPC, so `capture.pairs` supplies it.
  const selectedGroup = selected
    ? completeEventGroup(selected, capture.pairs.get(selected.event.id))
    : undefined
  const result = selectedGroup?.result
  const detail =
    pane === 'result' && result
      ? (capture.details.get(result.id) ?? result)
      : selectedGroup
        ? (capture.details.get(selectedGroup.event.id) ?? selectedGroup.event)
        : undefined
  const filtered = !!chips.length || !!filters.direction || !!filters.phase || !!filters.grep
  return (
    <>
      <ActionError error={action.error} />
      <LiveContent ready={rpc.ready}>
        <div className="workbench capture-workbench">
          <header className="workbench-header capture-header">
            <div className="capture-heading">
              <h1>MTProto capture</h1>
              <span
                className={
                  'capture-state ' + (rpc.data.capturing ? 'live' : 'paused')
                }
              >
                <span className="capture-state-dot" aria-hidden="true" />
                {rpc.data.capturing ? 'Capturing' : 'Capture paused'}
              </span>
            </div>
            <span className="workbench-sub capture-metrics">
              {total.toLocaleString()} retained
              <span className="capture-dot" aria-hidden="true">·</span>
              {maxEvents.toLocaleString()} max
              <span className="capture-dot" aria-hidden="true">·</span>
              {dropped.toLocaleString()} dropped
            </span>
            <div className="workbench-actions capture-actions">
              <button
                className="button filled"
                disabled={action.busy || !rpc.ready}
                aria-label={
                  rpc.data.capturing ? 'Pause capture' : 'Resume capture'
                }
                title={
                  rpc.data.capturing
                    ? 'Stop recording new events into the buffer'
                    : 'Start recording events into the buffer'
                }
                onClick={() =>
                  void action.run(async () => {
                    await (rpc.data.capturing
                      ? rpc.data.pause()
                      : rpc.data.start())
                    await capture.load('latest')
                    tailToLatest()
                  })
                }
              >
                <Icon
                name={rpc.data.capturing ? 'pause' : 'play'}
                size={12}
              />
                <span className="capture-label">
                  {rpc.data.capturing ? 'Pause capture' : 'Resume capture'}
                </span>
              </button>
              <button
                className="button tonal"
                disabled={!rpc.ready || !total}
                aria-label="Save log"
                title={
                  total
                    ? 'Save the buffered events as a log on the server'
                    : 'Nothing to save yet'
                }
                onClick={() => openSave()}
              >
                <Icon name="save" size={13} />
                <span className="capture-label">Save log</span>
              </button>
              <button
                className="button outlined"
                disabled={!rpc.ready}
                aria-label="Saved logs"
                title="Browse logs saved on the server"
                onClick={openLogs}
              >
                <Icon name="logs" size={13} />
                <span className="capture-label">Saved logs</span>
                {recordingCount ? (
                  <span className="capture-count" aria-hidden="true">
                    {recordingCount}
                  </span>
                ) : null}
              </button>
              <button
                ref={clearRef}
                className={
                  'button ' + (clearArmed ? 'danger capture-clear-armed' : 'outlined')
                }
                disabled={!rpc.ready || !total || action.busy}
                aria-label={clearArmed ? 'Confirm clear buffer' : 'Clear buffer'}
                title={
                  total
                    ? clearArmed
                      ? 'Click again to drop all ' +
                        total.toLocaleString() +
                        ' buffered events'
                      : 'Drop all ' +
                        total.toLocaleString() +
                        ' buffered events'
                    : 'Nothing to clear yet'
                }
                onClick={clearBuffer}
              >
                <Icon name="trash" size={13} />
                <span className="capture-label">
                  {clearArmed ? 'Confirm clear' : 'Clear'}
                </span>
              </button>
              <div className="capture-more" ref={moreRef}>
                <button
                  className="icon-button"
                  aria-label="More capture actions"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen(!moreOpen)}
                >
                  <Icon name="ellipsis" size={15} />
                </button>
                {moreOpen ? (
                  <div className="capture-menu capture-menu-right" role="menu">
                    <button
                      className="capture-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setMoreOpen(false)
                        void capture.load('latest')
                      }}
                    >
                      Reload newest events
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </header>
          <div className="workbench-toolbar capture-toolbar">
            <label className="field capture-search">
              <Icon name="search" size={13} className="capture-search-icon" />
              <input
                type="search"
                aria-label="Filter captured events"
                value={filters.grep ?? ''}
                placeholder="Filter by method, payload, connection…"
                onChange={(event) =>
                  setFilter('grep', event.currentTarget.value)
                }
              />
            </label>
            <select
              className="capture-select"
              aria-label="Direction"
              value={filters.direction ?? ''}
              onChange={(event) =>
                setFilter('direction', event.currentTarget.value)
              }
            >
              <option value="">All directions</option>
              <option value="client->server">Client → server</option>
              <option value="server->client">Server → client</option>
            </select>
            <select
              className="capture-select"
              aria-label="Phase"
              value={filters.phase ?? ''}
              onChange={(event) => setFilter('phase', event.currentTarget.value)}
            >
              <option value="">All phases</option>
              <option value="handshake">Handshake</option>
              <option value="message">Message</option>
              <option value="connection">Connection</option>
            </select>
            <button
              className={'button ' + (showFilters ? 'tonal' : 'outlined')}
              aria-expanded={showFilters}
              aria-label="Filters"
              onClick={() => setShowFilters(!showFilters)}
            >
              <Icon name="filter" size={13} />
              <span className="capture-label">
                Filters{chips.length ? ' · ' + chips.length : ''}
              </span>
            </button>
          </div>
          {showFilters ? (
            <div className="workbench-toolbar capture-filter-panel">
              <label className="field">
                <input
                  aria-label="Connection ID"
                  placeholder="Connection ID"
                  value={filters.connectionId ?? ''}
                  onChange={(event) =>
                    setFilter('connectionId', event.currentTarget.value)
                  }
                />
              </label>
              <label className="field">
                <input
                  aria-label="Since"
                  placeholder="Since (5m, 1h, timestamp)"
                  value={filters.since ?? ''}
                  onChange={(event) =>
                    setFilter('since', event.currentTarget.value)
                  }
                />
              </label>
              <label className="field">
                <input
                  aria-label="Payload field"
                  placeholder="Field (payload.userId=123)"
                  value={filters.field ?? ''}
                  onChange={(event) =>
                    setFilter('field', event.currentTarget.value)
                  }
                />
              </label>
              <span className="muted capture-filter-hint">
                Filters apply live. Right-click an event to filter by its
                method or connection.
              </span>
            </div>
          ) : null}
          {chips.length ? (
            <div className="workbench-toolbar capture-chip-row">
              {chips.map((chip) => (
                <button
                  key={chip.key}
                  className="chip filter-chip"
                  title={'Remove filter: ' + chip.label}
                  aria-label={'Remove filter: ' + chip.label}
                  onClick={() => setFilter(chip.key, '')}
                >
                  {chip.label}
                  <Icon name="close" size={11} />
                </button>
              ))}
              <button
                className="button outlined capture-chip-clear"
                onClick={() => setFilters({})}
              >
                Clear filters
              </button>
            </div>
          ) : null}
          <div className="workbench-body capture-body">
            <div
              ref={list}
              className="workbench-scroll capture-list"
              role="list"
              aria-label="Captured MTProto events"
              tabIndex={0}
              onScroll={onScroll}
              onKeyDown={onListKeyDown}
            >
              <table className="workbench-table capture-table">
                <thead>
                  <tr>
                    <th className="capture-col-time">Time</th>
                    <th>Method</th>
                    <th className="capture-col-conn">Connection</th>
                    <th className="cell-right capture-col-duration">
                      Duration
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ids.map((id) => {
                    const group = groups.get(id)!
                    const event = capture.details.get(id) ?? group.event
                    const groupResult = group.result
                      ? (capture.details.get(group.result.id) ?? group.result)
                      : undefined
                    const metrics = getRpcResultMetrics(event, groupResult)
                    return (
                      <tr
                        key={id}
                        className={
                          'capture-row' +
                          (metrics?.state === 'error' ? ' rpc-error' : '')
                        }
                        aria-selected={expanded === id}
                        onClick={(click) => {
                          if ((click.target as HTMLElement).closest('button'))
                            return
                          select(expanded === id ? undefined : id)
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          openMenuFor(id, event.clientX, event.clientY)
                        }}
                      >
                        <td className="capture-time">
                          <time
                            dateTime={new Date(event.timestamp).toISOString()}
                          >
                            {formatClock(event.timestamp)}
                          </time>
                        </td>
                        <td className="cell-grow capture-name">
                          <button
                            className="capture-row-header"
                            aria-expanded={expanded === id}
                            onClick={() =>
                              select(expanded === id ? undefined : id)
                            }
                          >
                            <span
                              className={
                                'capture-direction ' +
                                (event.direction === 'client->server'
                                  ? 'outgoing'
                                  : 'incoming')
                              }
                              aria-hidden="true"
                              title={
                                event.direction === 'client->server'
                                  ? 'Client → server'
                                  : 'Server → client'
                              }
                            >
                              <Icon
                                name={
                                  event.direction === 'client->server'
                                    ? 'arrowUpRight'
                                    : 'arrowDownLeft'
                                }
                                size={12}
                              />
                            </span>
                            <strong>{event.name}</strong>
                            {event.phase === 'message' ? null : (
                              <span className="chip capture-phase">
                                {event.phase}
                              </span>
                            )}
                            {metrics?.state === 'error' ? (
                              <span className="chip capture-badge-error">
                                error
                              </span>
                            ) : null}
                            {metrics?.state === 'slow' ? (
                              <span className="chip capture-badge-slow">
                                slow
                              </span>
                            ) : null}
                          </button>
                        </td>
                        <td className="capture-col-conn capture-conn">
                          {event.connectionId}
                        </td>
                        <td className="cell-right capture-duration">
                          {metrics ? (
                            <span
                              className={
                                metrics.state === 'error'
                                  ? 'capture-error'
                                  : metrics.state === 'slow'
                                    ? 'capture-slow'
                                    : undefined
                              }
                            >
                              {formatMs(metrics.durationMs)}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {!ids.length && !capture.loading ? (
                <div className="capture-empty">
                  <Icon
                    name={total ? 'search' : 'terminal'}
                    size={20}
                    className="capture-empty-icon"
                  />
                  <h3>{total ? 'No events match' : 'Nothing captured yet'}</h3>
                  <p className="muted">
                    {total
                      ? 'No event in the retained buffer matches the current filters.'
                      : rpc.data.capturing
                        ? 'Events show up here as soon as a client talks to the relay.'
                        : 'Capture is paused, so nothing new is being recorded.'}
                  </p>
                  {total && filtered ? (
                    <button
                      className="button outlined"
                      onClick={() => setFilters({})}
                    >
                      Clear filters
                    </button>
                  ) : null}
                  {!total && !rpc.data.capturing ? (
                    <button
                      className="button filled"
                      onClick={() =>
                        void action.run(async () => {
                          await rpc.data.start()
                          await capture.load('latest')
                        })
                      }
                    >
                      Resume capture
                    </button>
                  ) : null}
                </div>
              ) : null}
              {capture.loading && ids.length ? (
                <p className="capture-list-note muted" role="status">
                  Loading events…
                </p>
              ) : null}
              {!capture.snapshot?.hasOlder && ids.length ? (
                <p className="capture-list-note muted">
                  Start of retained capture
                </p>
              ) : null}
              {!follow ? (
                <button
                  className="capture-jump"
                  onClick={tailToLatest}
                  aria-label={
                    newCount
                      ? newCount + ' new events, jump to latest'
                      : 'Jump to latest events'
                  }
                >
                  <Icon name="arrowDownLeft" size={13} />
                  {newCount
                    ? newCount + (newCount === 1 ? ' new event' : ' new events')
                    : 'Jump to latest'}
                </button>
              ) : null}
            </div>
            {selectedGroup && detail ? (
              <section
                className="capture-inspector"
                aria-label="Captured event details"
              >
                <header className="capture-inspector-header">
                  <a
                    className="capture-inspector-name"
                    href={rawLink(detail.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open the raw event JSON"
                  >
                    {detail.name}
                    <Icon name="external" size={11} />
                  </a>
                  <div className="capture-inspector-meta">
                    <span>#{detail.id}</span>
                    <span>{formatClock(detail.timestamp)}</span>
                    <span className="capture-conn">
                      {detail.connectionId || 'no connection'}
                    </span>
                    {getRpcResultMetrics(
                      selectedGroup.event,
                      selectedGroup.result,
                    ) ? (
                      <span>
                        {formatMs(
                          getRpcResultMetrics(
                            selectedGroup.event,
                            selectedGroup.result,
                          )!.durationMs,
                        )}
                      </span>
                    ) : null}
                  </div>
                  {selectedGroup.result ? (
                    <div
                      className="segmented capture-panes"
                      role="tablist"
                      aria-label="Captured event sections"
                    >
                      <button
                        role="tab"
                        aria-selected={pane === 'event'}
                        className={pane === 'event' ? 'selected' : undefined}
                        onClick={() => setPane('event')}
                      >
                        Request
                      </button>
                      <button
                        role="tab"
                        aria-selected={pane === 'result'}
                        className={pane === 'result' ? 'selected' : undefined}
                        onClick={() => {
                          setPane('result')
                          if (selectedGroup.result)
                            void capture.loadDetails(selectedGroup.result)
                        }}
                      >
                        Result
                      </button>
                    </div>
                  ) : null}
                  <button
                    className="icon-button"
                    aria-label="Close details"
                    onClick={() => select(undefined)}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </header>
                <div className="capture-inspector-body">
                  <EventDetail
                    event={detail}
                    onCopy={(label, value) => void copy(label, value)}
                    onMenu={(rect) =>
                      openMenuFor(detail.id, rect.left, rect.bottom)
                    }
                    rawLink={rawLink}
                  />
                </div>
              </section>
            ) : null}
          </div>
          <div className="workbench-footer capture-footer">
            <span className="capture-footer-left">
              {shown.toLocaleString()} of {total.toLocaleString()} events
              {filtered ? ' (filtered)' : ''}
            </span>
            <span className="capture-footer-tail">
              {capture.loading
                ? 'Loading…'
                : follow
                  ? 'Tailing newest events'
                  : 'Scrolled back · new events are kept'}
            </span>
          </div>
          {saveOpen ? (
            <Modal
              title="Save log"
              onClose={() => {
                if (!save.busy) setSaveOpen(false)
              }}
            >
              <p className="muted">
                Writes all {total.toLocaleString()} buffered events to a JSON
                log on the server. Capture keeps running while the log is
                written.
              </p>
              <label className="field">
                <span>Log name (optional)</span>
                <input
                  aria-label="Log name"
                  value={logName}
                  maxLength={120}
                  placeholder="dialogs-bug"
                  disabled={save.busy}
                  onChange={(event) => setLogName(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') submitLog()
                  }}
                />
                <small className="field-hint">
                  Used in the file name; a timestamp keeps names unique.
                </small>
              </label>
              <dl className="capture-facts">
                <div>
                  <dt>Events</dt>
                  <dd>{total.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Server folder</dt>
                  <dd>
                    <code>{savedLogs?.directory ?? 'Loading…'}</code>
                  </dd>
                </div>
              </dl>
              <ActionError error={save.error} />
              <div className="toolbar">
                <button
                  className="button filled"
                  disabled={save.busy || !total}
                  onClick={submitLog}
                >
                  {save.busy ? 'Saving…' : 'Save on server'}
                </button>
                <a
                  className="button tonal"
                  href={currentLogDownloadUrl(
                    rpc.data.recordingsApiPath,
                    logName,
                  )}
                >
                  <Icon name="download" size={13} />
                  Download
                </a>
                <button
                  className="button outlined"
                  disabled={save.busy}
                  onClick={() => setSaveOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </Modal>
          ) : null}
          {logsOpen ? (
            <Modal
              title="Saved logs"
              onClose={() => setLogsOpen(false)}
              className="capture-logs-modal"
            >
              <p className="muted capture-logs-note">
                {savedLogs?.directory
                  ? 'Stored on the server in '
                  : 'Saved capture logs live on the server'}
                {savedLogs?.directory ? (
                  <code>{savedLogs.directory}</code>
                ) : null}
              </p>
              <ActionError error={logs.error} />
              {logs.busy && !savedLogs ? (
                <p className="muted">Loading saved logs…</p>
              ) : savedLogs?.recordings.length ? (
                <div className="recording-list">
                  {savedLogs.recordings.map((recording) => {
                    const name = recording.label ?? recording.fileName
                    return (
                      <div className="recording-row" key={recording.id}>
                        <div className="recording-info">
                          <strong className="recording-label" title={recording.id}>
                            {name}
                          </strong>
                          <span className="recording-meta">
                            {recording.label ? (
                              <>
                                <code>{recording.fileName}</code>
                                <span aria-hidden="true"> · </span>
                              </>
                            ) : null}
                            {recording.eventCount.toLocaleString()} events
                            <span aria-hidden="true"> · </span>
                            {formatBytes(recording.bytes)}
                            <span aria-hidden="true"> · </span>
                            <time
                              dateTime={new Date(
                                recording.createdAt,
                              ).toISOString()}
                            >
                              {formatLogTime(recording.createdAt)}
                            </time>
                          </span>
                        </div>
                        <div className="recording-actions">
                          <button
                            className="icon-button"
                            aria-label={'Copy file path for ' + name}
                            title="Copy file path"
                            onClick={() =>
                              void copy(
                                'file path',
                                joinPath(
                                  savedLogs.directory,
                                  recording.fileName,
                                ),
                              )
                            }
                          >
                            <Icon name="copy" size={13} />
                          </button>
                          <a
                            className="button outlined recording-download"
                            href={recordingDownloadUrl(
                              rpc.data.recordingsApiPath,
                              recording.id,
                            )}
                            download={recording.fileName}
                            aria-label={'Download ' + name}
                          >
                            Download
                          </a>
                          <ConfirmAction
                            label="Delete"
                            title="Delete this log?"
                            description={
                              'This removes ' +
                              recording.fileName +
                              ' from the server. Saved logs cannot be recovered.'
                            }
                            action={async () => {
                              await deleteRecording(
                                rpc.data.recordingsApiPath,
                                recording.id,
                              )
                              await refreshLogs()
                            }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="capture-empty capture-empty-inline">
                  <Icon name="save" size={18} className="capture-empty-icon" />
                  <h3>No saved logs yet</h3>
                  <p className="muted">
                    Save the capture buffer to keep it after the in-memory
                    window is cleared or the relay restarts.
                  </p>
                </div>
              )}
              <div className="toolbar">
                <button
                  className="button outlined"
                  disabled={logs.busy}
                  onClick={() => void refreshLogs()}
                >
                  <Icon name="refresh" size={13} />
                  Refresh
                </button>
                <button
                  className="button filled"
                  disabled={!total}
                  onClick={() => {
                    setLogsOpen(false)
                    openSave()
                  }}
                >
                  Save current buffer
                </button>
              </div>
            </Modal>
          ) : null}
        </div>
        {capture.error ? (
          <div className="capture-error-toast">
            <Notice tone="error">{capture.error}</Notice>
          </div>
        ) : null}
        {menuGroup && menuEvent ? (
          <div
            ref={menuRef}
            className="capture-menu"
            role="menu"
            aria-label="Event actions"
            style={{
              left: Math.min(menu!.x, globalThis.innerWidth - 248),
              top: Math.min(menu!.y, globalThis.innerHeight - 340),
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
              const items = [
                ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
                  '.capture-menu-item:not(:disabled)',
                ) ?? []),
              ]
              if (!items.length) return
              event.preventDefault()
              const index = items.indexOf(
                document.activeElement as HTMLButtonElement,
              )
              const next =
                event.key === 'ArrowDown'
                  ? (index + 1) % items.length
                  : (index - 1 + items.length) % items.length
              items[next]?.focus()
            }}
          >
            <button
              className="capture-menu-item"
              role="menuitem"
              onClick={() => void copy('method name', menuEvent.name)}
            >
              Copy method name
            </button>
            <button
              className="capture-menu-item"
              role="menuitem"
              disabled={!menuEvent.connectionId}
              onClick={() => void copy('connection ID', menuEvent.connectionId)}
            >
              Copy connection ID
            </button>
            <button
              className="capture-menu-item"
              role="menuitem"
              disabled={menuEvent.payloadOmitted}
              onClick={() =>
                void copy(
                  'payload',
                  JSON.stringify(menuEvent.payload ?? null, null, 2),
                )
              }
            >
              Copy payload
            </button>
            <button
              className="capture-menu-item"
              role="menuitem"
              onClick={() =>
                void copy('event JSON', JSON.stringify(menuEvent, null, 2))
              }
            >
              Copy event JSON
            </button>
            {menuResult ? (
              <button
                className="capture-menu-item"
                role="menuitem"
                onClick={() =>
                  void copy(
                    'result JSON',
                    JSON.stringify(menuResult.payload ?? null, null, 2),
                  )
                }
              >
                Copy result JSON
              </button>
            ) : null}
            <div className="capture-menu-sep" role="separator" />
            <button
              className="capture-menu-item"
              role="menuitem"
              onClick={() => {
                filterType('include', menuEvent.name)
                setMenu(undefined)
              }}
            >
              Only this method
            </button>
            <button
              className="capture-menu-item"
              role="menuitem"
              onClick={() => {
                filterType('exclude', menuEvent.name)
                setMenu(undefined)
              }}
            >
              Exclude this method
            </button>
            <button
              className="capture-menu-item"
              role="menuitem"
              disabled={!menuEvent.connectionId}
              onClick={() => {
                setFilter('connectionId', menuEvent.connectionId)
                setMenu(undefined)
              }}
            >
              Only this connection
            </button>
            {filtered ? (
              <button
                className="capture-menu-item"
                role="menuitem"
                onClick={() => {
                  setFilters({})
                  setMenu(undefined)
                }}
              >
                Clear all filters
              </button>
            ) : null}
            <div className="capture-menu-sep" role="separator" />
            <button
              className="capture-menu-item"
              role="menuitem"
              onClick={() => {
                window.open(rawLink(menu!.id), '_blank', 'noopener')
                setMenu(undefined)
              }}
            >
              Open raw event
            </button>
          </div>
        ) : null}
        {flash ? (
          <div className="capture-flash" role="status">
            {flash}
          </div>
        ) : null}
      </LiveContent>
    </>
  )
}

export function joinPath(directory: string, fileName: string): string {
  const separator = directory.includes('\\') ? '\\' : '/'
  return directory.replace(/[\\/]+$/, '') + separator + fileName
}

export function formatClock(timestamp: number, withMillis = true): string {
  const date = new Date(timestamp)
  const pad = (value: number, length = 2) =>
    String(value).padStart(length, '0')
  const base =
    pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
  return withMillis ? base + '.' + pad(date.getMilliseconds(), 3) : base
}

export function formatLogTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    date.getFullYear() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    ' ' +
    formatClock(timestamp, false)
  )
}

function EventDetail(props: {
  event: CapturedMtprotoEvent
  onCopy: (label: string, value: string) => void
  onMenu: (rect: { left: number, bottom: number }) => void
  rawLink: (id: number) => string
}) {
  const fields = [
    ['Event', props.event.id],
    ['Message', props.event.messageId],
    ['Request', props.event.requestMessageId],
    ['Sequence', props.event.seqNo],
    ['Session', props.event.sessionId],
    ['Auth key', props.event.authKeyId],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '')
  return (
    <section className="event-detail">
      <div className="event-detail-toolbar">
        <button
          className="icon-button"
          aria-label="Copy payload"
          title="Copy payload JSON"
          disabled={props.event.payloadOmitted}
          onClick={() =>
            props.onCopy(
              'payload',
              JSON.stringify(props.event.payload ?? null, null, 2),
            )
          }
        >
          <Icon name="copy" size={13} />
        </button>
        <button
          className="icon-button"
          aria-label="Copy event JSON"
          title="Copy the whole event as JSON"
          onClick={() =>
            props.onCopy('event JSON', JSON.stringify(props.event, null, 2))
          }
        >
          <Icon name="code" size={13} />
        </button>
        <a
          className="icon-button"
          aria-label="Open raw event"
          title="Open the raw event JSON"
          href={props.rawLink(props.event.id)}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Icon name="external" size={13} />
        </a>
        <span className="capture-toolbar-sep" aria-hidden="true" />
        <button
          className="icon-button"
          aria-label="Event actions"
          title="Filters, copy actions"
          aria-haspopup="menu"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            props.onMenu({ left: rect.left, bottom: rect.bottom + 4 })
          }}
        >
          <Icon name="ellipsis" size={14} />
        </button>
        <span
          className={
            'chip capture-direction-chip ' +
            (props.event.direction === 'client->server'
              ? 'outgoing'
              : 'incoming')
          }
        >
          {props.event.direction === 'client->server' ? 'request' : 'response'}
        </span>
        <span className="chip">{props.event.phase}</span>
      </div>
      {fields.length ? (
        <dl className="event-metadata">
          {fields.map(([key, value]) => (
            <div key={String(key)}>
              <dt>{key}</dt>
              <dd>
                <code>{String(value)}</code>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {props.event.error ? (
        <ActionError error={props.event.error} />
      ) : null}
      {props.event.payloadOmitted ? (
        <p className="muted event-detail-loading" role="status">
          <Icon name="refresh" size={15} /> Loading payload…
        </p>
      ) : (
        <JsonTree value={props.event.payload} />
      )}
    </section>
  )
}

type JsonKind =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'other'

function kindOf(value: unknown): JsonKind {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'object':
      return 'object'
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return 'other'
  }
}

function previewOf(value: unknown): string {
  const kind = kindOf(value)
  if (kind === 'array') return 'Array(' + (value as unknown[]).length + ')'
  if (kind === 'object') return '{…}'
  if (kind === 'string') {
    const text = value as string
    return text.length > 200
      ? JSON.stringify(text.slice(0, 200) + '…')
      : JSON.stringify(text)
  }
  if (kind === 'null') return 'null'
  if (kind === 'other') return String(value)
  return String(value)
}

function primitiveClass(kind: JsonKind): string {
  return 'json-value json-' + kind
}

function JsonNode(props: {
  name?: string
  value: unknown
  depth: number
  defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(props.defaultExpanded ?? false)
  const [showFull, setShowFull] = useState(false)
  const [limit, setLimit] = useState(100)
  const kind = kindOf(props.value)
  const expandable = kind === 'object' || kind === 'array'
  const entries = useMemo(() => {
    if (kind === 'array')
      return (props.value as unknown[]).map(
        (item, index) => [String(index), item] as const,
      )
    if (kind === 'object')
      return Object.entries(props.value as Record<string, unknown>)
    return []
  }, [kind, props.value])
  const indent = { paddingLeft: 12 + props.depth * 14 }
  if (!expandable) {
    const text = props.value as string
    const longText = kind === 'string' && text.length > 200
    const shown =
      longText && !showFull
        ? JSON.stringify(text.slice(0, 200) + '…')
        : kind === 'string'
          ? JSON.stringify(
              text.length > 2000 ? text.slice(0, 2000) + '…' : text,
            )
          : previewOf(props.value)
    return (
      <div className="json-row" style={indent}>
        <span className="json-caret" />
        {props.name !== undefined ? (
          <>
            <span className="json-key">{props.name}</span>
            <span className="json-punct">:&nbsp;</span>
          </>
        ) : null}
        <span className={primitiveClass(kind)}>{shown}</span>
        {longText ? (
          <button
            className="json-string-toggle"
            onClick={(event) => {
              event.stopPropagation()
              setShowFull(!showFull)
            }}
          >
            {showFull ? 'collapse' : 'show all'}
          </button>
        ) : null}
      </div>
    )
  }
  return (
    <>
      <div
        className={'json-row json-toggle' + (expandable ? ' expandable' : '')}
        style={indent}
        role="treeitem"
        aria-expanded={expanded}
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setExpanded(!expanded)
          }
        }}
      >
        <span className="json-caret">{expanded ? '▾' : '▸'}</span>
        {props.name !== undefined ? (
          <>
            <span className="json-key">{props.name}</span>
            <span className="json-punct">:&nbsp;</span>
          </>
        ) : null}
        <span className="json-punct">
          {expanded ? (kind === 'array' ? '[' : '{') : previewOf(props.value)}
        </span>
      </div>
      {expanded ? (
        <>
          {entries.slice(0, limit).map(([key, value]) => (
            <JsonNode key={key} name={key} value={value} depth={props.depth + 1} />
          ))}
          {entries.length > limit ? (
            <div className="json-row" style={indent}>
              <span className="json-caret" />
              <button
                className="json-string-toggle json-more"
                onClick={(event) => {
                  event.stopPropagation()
                  setLimit(limit + 100)
                }}
              >
                Show 100 more ({entries.length - limit} remaining)
              </button>
            </div>
          ) : null}
          <div className="json-row" style={indent}>
            <span className="json-caret" />
            <span className="json-punct">
              {kind === 'array' ? ']' : '}'}
            </span>
          </div>
        </>
      ) : null}
    </>
  )
}

export function JsonTree({ value }: { value: unknown }) {
  return (
    <div className="json-tree" role="tree" aria-label="Payload">
      <JsonNode value={value} depth={0} defaultExpanded />
    </div>
  )
}


