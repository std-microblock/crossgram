import { useState } from 'react'
import { useRpc, type PageProps } from 'cordis-webui-react/client'
import {
  ActionError,
  EmptyState,
  formatNumber,
  LiveContent,
  PageHeader,
  useAction,
} from 'cordis-webui-react/components'
import type {
  BackfillConversationSnapshot,
  BackfillSessionSnapshot,
  BackfillSnapshot,
  HistoryBackfillData,
} from '../src/types.js'
import {
  conversationProgress,
  formatAge,
  formatDate,
  sessionStatusLabel,
} from './model.js'

export default function HistoryBackfillPage(props: PageProps) {
  const rpc = useRpc<HistoryBackfillData>(props.entryId)
  const toggle = useAction()
  const snapshot = rpc.data.snapshot
  return (
    <>
      <PageHeader
        icon="clock"
        title="History backfill"
        description="While an account is idle, slowly read back older and missing group history into the local store."
        actions={
          snapshot ? (
            <button
              className={`button ${snapshot.enabled ? 'outlined' : 'filled'}`}
              disabled={toggle.busy}
              onClick={() =>
                void toggle.run(() => rpc.data.setEnabled(!snapshot.enabled))
              }
            >
              {snapshot.enabled ? 'Pause backfill' : 'Start backfill'}
            </button>
          ) : null
        }
      />
      <ActionError error={toggle.error} />
      <LiveContent ready={rpc.ready}>
        {snapshot ? (
          <BackfillDashboard snapshot={snapshot} data={rpc.data} />
        ) : null}
      </LiveContent>
    </>
  )
}

export function BackfillDashboard(props: {
  snapshot: BackfillSnapshot
  data: HistoryBackfillData
}) {
  const settings = props.snapshot.settings
  return (
    <div className="stack history-backfill">
      <p className="muted">
        {props.snapshot.enabled ? 'Running' : 'Paused'}
        {' · '}idle after {Math.round(settings.idleAfterMs / 1000)}s{' · '}one
        request every ≥{(settings.intervalMs / 1000).toFixed(1)}s{' · '}
        {settings.pageSize} messages per request
        {' · '}
        {settings.maxAgeDays
          ? `up to ${settings.maxAgeDays} days back`
          : 'no age limit'}
        {' · '}progress is kept in memory and rebuilt from stored messages after
        a restart
      </p>
      {props.snapshot.sessions.length ? (
        props.snapshot.sessions.map((session) => (
          <SessionPanel
            key={session.platformSessionId}
            session={session}
            data={props.data}
          />
        ))
      ) : (
        <EmptyState
          icon="clock"
          title="No active accounts"
          description="Backfill starts once a platform account is online."
        />
      )}
      {props.snapshot.recent.length ? (
        <section className="panel">
          <h3>Recent requests</h3>
          <ol className="timeline" aria-label="Recent backfill requests">
            {props.snapshot.recent.map((event, index) => (
              <li
                key={event.at + ':' + index}
                className={'timeline-item' + (event.error ? ' failed' : '')}
              >
                <span className="timeline-dot" aria-hidden="true" />
                <time dateTime={new Date(event.at).toISOString()}>
                  {formatDate(event.at)}
                </time>
                <div className="timeline-body">
                  <strong>{event.title}</strong>
                  <small>
                    {event.kind === 'gap' ? 'gap' : 'older'} · {event.mode} ·{' '}
                    {event.range} · {formatNumber(event.fetched)} fetched ·{' '}
                    {formatNumber(event.inserted)} new
                  </small>
                  {event.error ? (
                    <small className="timeline-error">{event.error}</small>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  )
}

function SessionPanel(props: {
  session: BackfillSessionSnapshot
  data: HistoryBackfillData
}) {
  const [filter, setFilter] = useState<'pending' | 'all'>('pending')
  const reset = useAction()
  const rows = props.session.conversations.filter(
    (item) => filter === 'all' || !(item.floorReached && item.gapCount === 0),
  )
  const totals = props.session.totals
  const coverage = totals.conversations
    ? Math.round((totals.complete / totals.conversations) * 100)
    : 0
  return (
    <section className="panel">
      <header>
        <h3>
          {props.session.platformId} · {props.session.platformSessionId}
        </h3>
        <span className="muted">
          {sessionStatusLabel(props.session.status)}
        </span>
      </header>
      <div className="backfill-progress">
        <div className="backfill-progress-head">
          <span>Backfill coverage</span>
          <strong>{coverage}%</strong>
        </div>
        <div
          className="progress-track"
          role="progressbar"
          aria-label={'Backfill coverage for ' + props.session.platformSessionId}
          aria-valuenow={coverage}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: coverage + '%' }} />
        </div>
        <p className="muted">
          {formatNumber(totals.complete)} of{' '}
          {formatNumber(totals.conversations)} conversations complete ·{' '}
          {formatNumber(totals.gaps)} gaps ·{' '}
          {formatNumber(totals.missing)} missing sequence numbers
        </p>
      </div>
      <dl className="backfill-stats">
        <div>
          <dt>Conversations</dt>
          <dd>
            {formatNumber(totals.conversations)}
            <small>{formatNumber(totals.complete)} fully backfilled</small>
          </dd>
        </div>
        <div>
          <dt>Known gaps</dt>
          <dd>
            {formatNumber(totals.gaps)}
            <small>
              {formatNumber(totals.missing)} sequence numbers missing
            </small>
          </dd>
        </div>
        <div>
          <dt>Fetched</dt>
          <dd>
            {formatNumber(totals.fetched)}
            <small>{formatNumber(totals.inserted)} new messages stored</small>
          </dd>
        </div>
        <div>
          <dt>Requests today</dt>
          <dd>
            {formatNumber(props.session.requestsToday)}
            <small>
              limit {formatNumber(props.session.dailyRequestCap)} · last client
              activity {formatAge(props.session.lastActivityAt)}
            </small>
          </dd>
        </div>
      </dl>
      <div className="toolbar">
        <div
          className="segmented"
          role="tablist"
          aria-label="Conversation filter"
        >
          <button
            role="tab"
            aria-selected={filter === 'pending'}
            className={filter === 'pending' ? 'selected' : ''}
            onClick={() => setFilter('pending')}
          >
            Pending
          </button>
          <button
            role="tab"
            aria-selected={filter === 'all'}
            className={filter === 'all' ? 'selected' : ''}
            onClick={() => setFilter('all')}
          >
            All
          </button>
        </div>
      </div>
      <ActionError error={reset.error} />
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Conversation</th>
              <th>Mode</th>
              <th>Progress</th>
              <th>Gaps</th>
              <th>Oldest</th>
              <th>Fetched</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <ConversationRow
                key={item.conversationId}
                item={item}
                onReset={() =>
                  void reset.run(() =>
                    props.data.resetConversation(
                      props.session.platformSessionId,
                      item.conversationId,
                    ),
                  )
                }
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ConversationRow(props: {
  item: BackfillConversationSnapshot
  onReset: () => void
}) {
  const item = props.item
  const percent = item.floorReached
    ? 100
    : item.bootstrapped
      ? Math.min(
          99,
          Math.round((item.covered / Math.max(1, item.covered + item.missing)) * 100),
        )
      : 0
  return (
    <tr>
      <td>{item.title}</td>
      <td>{item.mode === 'sequence' ? 'msgSeq' : 'anchor'}</td>
      <td>
        <div className="backfill-cell-progress">
          <div
            className="progress-track small"
            role="progressbar"
            aria-label={'Progress for ' + item.title}
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: percent + '%' }} />
          </div>
          <small>{conversationProgress(item)}</small>
        </div>
      </td>
      <td>
        {item.gapCount
          ? `${formatNumber(item.gapCount)} (${formatNumber(item.missing)})`
          : '—'}
      </td>
      <td>
        {item.oldestTimestamp ? formatDate(item.oldestTimestamp! * 1000) : '—'}
      </td>
      <td>
        {formatNumber(item.fetched)} / {formatNumber(item.inserted)} new
      </td>
      <td>
        {item.lastError
          ? `retry ${formatAge(item.nextAttemptAt)} · ${item.lastError}`
          : item.floorReached
            ? item.floorReason === 'age'
              ? 'reached age limit'
              : 'reached the beginning'
            : 'pending'}
      </td>
      <td>
        {item.failures || item.floorReached ? (
          <button className="button tonal" onClick={() => props.onReset()}>
            Retry
          </button>
        ) : null}
      </td>
    </tr>
  )
}
