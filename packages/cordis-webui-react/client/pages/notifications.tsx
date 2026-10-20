import { createElement, useMemo } from 'react'
import { useConnectionState, useRpc, type PageProps } from '../sdk.js'
import {
  ActionError,
  EmptyState,
  LiveContent,
  PageHeader,
  useAction,
} from '../components.js'
export interface NotificationData {
  notifiers: { type: string; content: string; entryId?: string }[]
  button(id: string): Promise<unknown>
}
export interface RichNode {
  text?: string
  tag?: string
  href?: string
  action?: string
  children?: RichNode[]
}
/**
 * Notifications arrive as HTML fragments produced by plugins. Instead of
 * injecting the markup (which would let any plugin run script in the shell), it
 * is parsed into a small allowlisted tree: unknown tags become `span`, unsafe
 * elements are dropped, links are limited to http(s), and buttons only keep a
 * plain action identifier.
 */
export function parseNotice(content: string): RichNode[] {
  const document = new DOMParser().parseFromString(
    content.slice(0, 100_000),
    'text/html',
  )
  const allowed = new Set([
    'p',
    'strong',
    'b',
    'em',
    'i',
    'code',
    'pre',
    'br',
    'ul',
    'ol',
    'li',
    'span',
    'a',
    'button',
  ])
  let count = 0
  const visit = (node: Node, depth: number): RichNode | undefined => {
    if (++count > 2000 || depth > 20) return
    if (node.nodeType === 3) return { text: node.textContent ?? '' }
    if (node.nodeType !== 1) return
    const element = node as Element,
      tag = element.tagName.toLowerCase()
    if (
      [
        'script',
        'style',
        'iframe',
        'object',
        'svg',
        'img',
        'video',
        'audio',
        'form',
        'input',
      ].includes(tag)
    )
      return
    const result: RichNode = {
      tag: allowed.has(tag) ? tag : 'span',
      children: Array.from(element.childNodes)
        .map((node) => visit(node, depth + 1))
        .filter((node): node is RichNode => !!node),
    }
    if (tag === 'a') {
      const href = element.getAttribute('href') ?? ''
      try {
        const url = new URL(href, location.href)
        if (['http:', 'https:'].includes(url.protocol)) result.href = url.href
      } catch {
        /* Unsafe or malformed URL: render text only. */
      }
    }
    if (tag === 'button') {
      const action =
        element.getAttribute('on-click') ?? element.getAttribute('onclick')
      if (action && /^[\w-]{1,128}$/.test(action)) result.action = action
    }
    return result
  }
  return Array.from(document.body.childNodes)
    .map((node) => visit(node, 0))
    .filter((node): node is RichNode => !!node)
}
function RichContent({
  nodes,
  disabled,
  onAction,
}: {
  nodes: RichNode[]
  disabled: boolean
  onAction: (id: string) => void
}) {
  return (
    <>
      {nodes.map((node, index) =>
        node.text !== undefined ? (
          node.text
        ) : node.tag === 'button' ? (
          <button
            key={index}
            className="button tonal"
            disabled={disabled || !node.action}
            onClick={() => node.action && onAction(node.action)}
          >
            <RichContent
              nodes={node.children ?? []}
              disabled={disabled}
              onAction={onAction}
            />
          </button>
        ) : node.tag === 'a' ? (
          <a
            key={index}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            <RichContent
              nodes={node.children ?? []}
              disabled={disabled}
              onAction={onAction}
            />
          </a>
        ) : (
          createElement(
            node.tag ?? 'span',
            { key: index },
            <RichContent
              nodes={node.children ?? []}
              disabled={disabled}
              onAction={onAction}
            />,
          )
        ),
      )}
    </>
  )
}
export default function NotificationsPage({ entryId }: PageProps) {
  const rpc = useRpc<NotificationData>(entryId),
    connection = useConnectionState(),
    action = useAction()
  const notifiers = rpc.data.notifiers ?? []
  return (
    <>
      <PageHeader
        title="Notifications"
        description="What needs your attention, all in one place."
      />
      <ActionError error={action.error} />
      <LiveContent ready={rpc.ready}>
        <div className="stack">
          {notifiers.map((notice, index) => (
            <NotificationCard
              key={index}
              notice={notice}
              disabled={action.busy || connection.status !== 'connected'}
              onAction={(id) => void action.run(() => rpc.data.button(id))}
            />
          ))}
          {!notifiers.length ? (
            <EmptyState
              icon="notifications"
              title="All caught up"
              description="Your plugins have no active notifications."
            />
          ) : null}
        </div>
      </LiveContent>
    </>
  )
}
function NotificationCard({
  notice,
  disabled,
  onAction,
}: {
  notice: NotificationData['notifiers'][number]
  disabled: boolean
  onAction: (id: string) => void
}) {
  const nodes = useMemo(() => parseNotice(notice.content), [notice.content])
  return (
    <article className="panel notification-card" data-type={notice.type}>
      <header className="toolbar">
        <span className="chip">{notice.type}</span>
        <span className="muted">{notice.entryId ?? 'Workspace'}</span>
      </header>
      <div className="rich-content">
        <RichContent nodes={nodes} disabled={disabled} onAction={onAction} />
      </div>
    </article>
  )
}
