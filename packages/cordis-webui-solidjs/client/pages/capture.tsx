/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import type {
  CapturedMtprotoEvent,
  MtprotoDebugData,
} from '../../../mtproto-debug/src/types.js'
import {
  getRpcResultMetrics,
  groupRpcEvents,
  type EventGroup,
} from '../../../mtproto-debug/src/event-groups.js'
import { useRpc, type PageProps } from '../sdk.js'
import {
  ActionError,
  ConfirmAction,
  LiveContent,
  PageHeader,
  useAction,
} from '../components.js'
import { useCapturePages, type CaptureFilters } from '../capture.js'
import { copyText, sameOriginPath } from './bridge-model.js'
import { formatMs } from './statistics-model.js'
export default function CapturePage(props: PageProps) {
  const rpc = useRpc<MtprotoDebugData>(props.entryId),
    action = useAction()
  const [filters, setFilters] = createSignal<CaptureFilters>({}),
    [expanded, setExpanded] = createSignal<number>()
  const capture = useCapturePages(
    () => rpc.data.apiPath,
    filters,
    () => rpc.ready,
  )
  const groups = createMemo(
    () =>
      new Map(
        groupRpcEvents(capture.events()).map((group) => [
          group.event.id,
          group,
        ]),
      ),
  )
  const ids = createMemo(() => [...groups().keys()].reverse())
  createEffect(() => {
    if (expanded() !== undefined && !groups().has(expanded()!)) {
      setExpanded(undefined)
      capture.keepDetails([])
    }
  })
  const setFilter = (key: keyof CaptureFilters, value: string) =>
    setFilters((previous) => ({ ...previous, [key]: value }))
  const toggle = (id: number) => {
    if (expanded() === id) {
      setExpanded(undefined)
      capture.keepDetails([])
      return
    }
    const group = groups().get(id)!
    setExpanded(id)
    capture.keepDetails([id, ...(group.result ? [group.result.id] : [])])
    void capture.loadDetails(group.event)
    if (group.result) void capture.loadDetails(group.result)
  }
  const rawLink = (id: number) => {
    const url = new URL(sameOriginPath(rpc.data.apiPath))
    url.searchParams.set('id', String(id))
    url.searchParams.set('limit', '1')
    return url.href
  }
  return (
    <>
      <PageHeader
        title="MTProto capture"
        description="Follow the conversation between your clients and the relay."
        actions={
          <>
            <button
              class="button filled"
              disabled={action.busy() || !rpc.ready}
              onClick={() =>
                void action.run(async () => {
                  await (rpc.data.capturing
                    ? rpc.data.pause()
                    : rpc.data.start())
                  await capture.load('latest')
                })
              }
            >
              {rpc.data.capturing ? 'Pause capture' : 'Start capture'}
            </button>
            <ConfirmAction
              label="Clear capture"
              title="Clear all captured events?"
              description="The in-memory capture buffer will be cleared. This does not disconnect clients."
              action={async () => {
                await rpc.data.clear()
                setExpanded(undefined)
                capture.keepDetails([])
                await capture.load('latest')
              }}
            />
          </>
        }
      />
      <ActionError error={action.error() || capture.error()} />
      <LiveContent ready={rpc.ready}>
        <section class="panel stack capture-controls">
          <div class="toolbar">
            <label class="field grow">
              <span>Search captured events</span>
              <input
                type="search"
                value={filters().grep ?? ''}
                placeholder="Method, payload text, connection…"
                onInput={(event) =>
                  setFilter('grep', event.currentTarget.value)
                }
              />
            </label>
            <button
              class="button tonal"
              aria-pressed={capture.live()}
              onClick={() => capture.setLive(!capture.live())}
            >
              {capture.live() ? 'Pause live view' : 'Follow latest'}
            </button>
          </div>
          <details>
            <summary>Advanced filters</summary>
            <div class="capture-filter-grid">
              <label class="field">
                <span>Direction</span>
                <select
                  aria-label="Direction"
                  value={filters().direction ?? ''}
                  onChange={(event) =>
                    setFilter('direction', event.currentTarget.value)
                  }
                >
                  <option value="">Both directions</option>
                  <option value="client->server">Client to server</option>
                  <option value="server->client">Server to client</option>
                </select>
              </label>
              <label class="field">
                <span>Phase</span>
                <select
                  aria-label="Phase"
                  value={filters().phase ?? ''}
                  onChange={(event) =>
                    setFilter('phase', event.currentTarget.value)
                  }
                >
                  <option value="">All phases</option>
                  <option>handshake</option>
                  <option>message</option>
                  <option>connection</option>
                </select>
              </label>
              <label class="field">
                <span>Connection ID</span>
                <input
                  value={filters().connectionId ?? ''}
                  onInput={(event) =>
                    setFilter('connectionId', event.currentTarget.value)
                  }
                />
              </label>
              <label class="field">
                <span>Since</span>
                <input
                  placeholder="5m, 1h, or a timestamp"
                  value={filters().since ?? ''}
                  onInput={(event) =>
                    setFilter('since', event.currentTarget.value)
                  }
                />
              </label>
              <label class="field">
                <span>Exact payload field</span>
                <input
                  placeholder="payload.userId=123"
                  value={filters().field ?? ''}
                  onInput={(event) =>
                    setFilter('field', event.currentTarget.value)
                  }
                />
              </label>
            </div>
          </details>
          <Show when={filters().typeName || filters().excludeName}>
            <button
              class="button outlined type-filter"
              onClick={() =>
                setFilters((value) => ({
                  ...value,
                  typeName: '',
                  excludeName: '',
                }))
              }
            >
              {filters().typeName
                ? 'Only: ' + filters().typeName
                : 'Exclude: ' + filters().excludeName}{' '}
              · clear
            </button>
          </Show>
          <div class="toolbar">
            <span class="chip">
              {rpc.data.capturing ? 'Capturing' : 'Capture paused'}
            </span>
            <span class="muted">
              {capture.events().length} shown / {capture.snapshot()?.total ?? 0}{' '}
              retained · {capture.snapshot()?.dropped ?? 0} dropped
            </span>
            <Show when={capture.loading()}>
              <span class="muted" role="status">
                Updating…
              </span>
            </Show>
          </div>
        </section>
        <section class="capture-list" aria-label="Captured MTProto events">
          <For each={ids()}>
            {(id) => {
              const group = () => groups().get(id)!,
                event = () => capture.details().get(id) ?? group().event,
                result = () =>
                  group().result
                    ? (capture.details().get(group().result!.id) ??
                      group().result)
                    : undefined
              return (
                <CaptureRow
                  event={event()}
                  result={result()}
                  expanded={expanded() === id}
                  toggle={() => toggle(id)}
                  filter={(mode, name) =>
                    setFilters((value) => ({
                      ...value,
                      typeName: mode === 'include' ? name : '',
                      excludeName: mode === 'exclude' ? name : '',
                    }))
                  }
                  rawLink={rawLink}
                />
              )
            }}
          </For>
          <Show when={!ids().length && !capture.loading()}>
            <div class="panel empty-state">
              <h2>No matching events</h2>
              <p>
                Start capture or adjust your filters. Payloads are fetched only
                when you expand an event.
              </p>
            </div>
          </Show>
        </section>
        <div class="panel pagination capture-pagination">
          <button
            class="button outlined"
            disabled={
              !rpc.ready || capture.loading() || !capture.snapshot()?.hasOlder
            }
            aria-label="Load older events"
            onClick={() => void capture.load('older')}
          >
            Older
          </button>
          <button
            class="button tonal"
            disabled={!rpc.ready || capture.loading()}
            aria-label="Show latest events"
            onClick={() => void capture.load('latest')}
          >
            Latest
          </button>
          <button
            class="button outlined"
            disabled={
              !rpc.ready || capture.loading() || !capture.snapshot()?.hasNewer
            }
            aria-label="Load newer events"
            onClick={() => void capture.load('newer')}
          >
            Newer
          </button>
        </div>
      </LiveContent>
    </>
  )
}
function CaptureRow(props: {
  event: CapturedMtprotoEvent
  result?: CapturedMtprotoEvent
  expanded: boolean
  toggle: () => void
  filter: (mode: 'include' | 'exclude', name: string) => void
  rawLink: (id: number) => string
}) {
  const metrics = () => getRpcResultMetrics(props.event, props.result)
  return (
    <article
      class="capture-row"
      classList={{
        'rpc-error': metrics()?.state === 'error',
        expanded: props.expanded,
      }}
    >
      <button
        class="capture-row-header"
        aria-expanded={props.expanded}
        onClick={props.toggle}
      >
        <span class="capture-direction" aria-hidden="true">
          {props.event.direction === 'client->server' ? '↗' : '↙'}
        </span>
        <div class="capture-row-title">
          <strong>{props.event.name}</strong>
          <small>
            {props.event.connectionId} ·{' '}
            {props.event.direction === 'client->server'
              ? 'Client → server'
              : 'Server → client'}{' '}
            · {props.event.phase}
          </small>
        </div>
        <div class="capture-row-meta">
          <time datetime={new Date(props.event.timestamp).toISOString()}>
            {new Date(props.event.timestamp).toLocaleTimeString()}
          </time>
          <Show when={metrics()}>
            <span
              class={'chip ' + (metrics()?.state === 'error' ? 'error' : '')}
            >
              {formatMs(metrics()!.durationMs)} · {metrics()!.state}
            </span>
          </Show>
        </div>
        <span aria-hidden="true">{props.expanded ? '−' : '+'}</span>
      </button>
      <Show when={props.result}>
        <p class="capture-result">
          Result: <code>{props.result!.name}</code>
        </p>
      </Show>
      <Show when={props.expanded}>
        <div class="capture-detail">
          <EventDetail
            event={props.event}
            filter={props.filter}
            rawLink={props.rawLink}
          />
          <Show when={props.result}>
            {(result) => (
              <EventDetail
                event={result()}
                filter={props.filter}
                rawLink={props.rawLink}
              />
            )}
          </Show>
        </div>
      </Show>
    </article>
  )
}
function EventDetail(props: {
  event: CapturedMtprotoEvent
  filter: (mode: 'include' | 'exclude', name: string) => void
  rawLink: (id: number) => string
}) {
  const action = useAction()
  return (
    <section class="stack event-detail">
      <div class="toolbar">
        <strong class="grow">{props.event.name}</strong>
        <button
          class="button outlined"
          onClick={() => props.filter('include', props.event.name)}
        >
          Only this type
        </button>
        <button
          class="button outlined"
          onClick={() => props.filter('exclude', props.event.name)}
        >
          Exclude this type
        </button>
        <a
          class="button outlined"
          href={props.rawLink(props.event.id)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Raw event
        </a>
        <button
          class="button tonal"
          disabled={props.event.payloadOmitted}
          onClick={() =>
            void action.run(() =>
              copyText(JSON.stringify(props.event.payload, null, 2)),
            )
          }
        >
          Copy payload
        </button>
      </div>
      <dl class="event-metadata">
        <For
          each={Object.entries({
            'Event ID': props.event.id,
            'Message ID': props.event.messageId,
            'Request ID': props.event.requestMessageId,
            Sequence: props.event.seqNo,
            'Auth key': props.event.authKeyId,
            Session: props.event.sessionId,
          })}
        >
          {([key, value]) => (
            <div>
              <dt>{key}</dt>
              <dd>
                <code>{value ?? '—'}</code>
              </dd>
            </div>
          )}
        </For>
      </dl>
      <ActionError error={action.error() || props.event.error || ''} />
      <Show
        when={!props.event.payloadOmitted}
        fallback={
          <p class="muted" role="status">
            Loading payload…
          </p>
        }
      >
        <div class="json-tree">
          <JsonTree value={props.event.payload} />
        </div>
      </Show>
    </section>
  )
}
export function JsonTree(props: {
  value: unknown
  name?: string
  depth?: number
}) {
  const data = createMemo(() => props.value)
  const [expanded, setExpanded] = createSignal(!props.depth),
    [limit, setLimit] = createSignal(30),
    [stringLimit, setStringLimit] = createSignal(800)
  const object = () => data() !== null && typeof data() === 'object'
  const keys = createMemo(() => {
    const value = data()
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value)
      : []
  })
  const count = () => {
    const value = data()
    return Array.isArray(value) ? value.length : keys().length
  }
  const entries = createMemo(() => {
    const value = data()
    if (!object()) return []
    if (Array.isArray(value))
      return value
        .slice(0, limit())
        .map((item, index) => [String(index), item] as const)
    return keys()
      .slice(0, limit())
      .map((key) => [key, (value as Record<string, unknown>)[key]] as const)
  })
  const rawText = createMemo(() => String(data()))
  const text = createMemo(() =>
    typeof data() === 'string'
      ? JSON.stringify(rawText().slice(0, stringLimit()))
      : rawText().slice(0, stringLimit()),
  )
  return (
    <Show
      when={object()}
      fallback={
        <div class="json-leaf">
          <Show when={props.name}>
            <strong>{props.name}: </strong>
          </Show>
          <span>{text()}</span>
          <Show when={rawText().length > stringLimit()}>
            <Show
              when={stringLimit() < 16000}
              fallback={
                <span class="muted">
                  {' '}
                  Preview limited to 16,000 characters; use the raw event link
                  for the full value.
                </span>
              }
            >
              <button
                class="field-reset"
                onClick={() =>
                  setStringLimit(Math.min(16000, stringLimit() + 2000))
                }
              >
                Show more ({rawText().length} characters total)
              </button>
            </Show>
          </Show>
        </div>
      }
    >
      <div class="json-branch">
        <button
          class="json-toggle"
          aria-expanded={expanded()}
          disabled={(props.depth ?? 0) > 20}
          onClick={() => setExpanded(!expanded())}
        >
          <span aria-hidden="true">{expanded() ? '−' : '+'}</span>
          <strong>{props.name ?? 'Payload'}</strong>
          <span class="muted">
            {count()} {Array.isArray(data()) ? 'items' : 'keys'}
          </span>
        </button>
        <Show when={expanded() && (props.depth ?? 0) <= 20}>
          <div class="json-children">
            <For each={entries()}>
              {([key, value]) => (
                <JsonTree
                  name={key}
                  value={value}
                  depth={(props.depth ?? 0) + 1}
                />
              )}
            </For>
            <Show when={count() > limit()}>
              <button
                class="button outlined"
                onClick={() => setLimit(limit() + 30)}
              >
                Show 30 more ({count() - limit()} remaining)
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  )
}
