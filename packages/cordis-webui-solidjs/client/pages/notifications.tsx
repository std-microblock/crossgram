/** @jsxImportSource solid-js */
import { createMemo, For, Show } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { useConnection, useRpc, type PageProps } from '../sdk.js'
import {
  ActionError,
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
function RichContent(props: {
  nodes: RichNode[]
  disabled: boolean
  onAction: (id: string) => void
}) {
  return (
    <For each={props.nodes}>
      {(node) =>
        node.text !== undefined ? (
          node.text
        ) : node.tag === 'button' ? (
          <button
            class="button tonal"
            disabled={props.disabled || !node.action}
            onClick={() => node.action && props.onAction(node.action)}
          >
            <RichContent {...props} nodes={node.children ?? []} />
          </button>
        ) : node.tag === 'a' ? (
          <a href={node.href} target="_blank" rel="noopener noreferrer">
            <RichContent {...props} nodes={node.children ?? []} />
          </a>
        ) : (
          <Dynamic component={node.tag as 'span'}>
            <RichContent {...props} nodes={node.children ?? []} />
          </Dynamic>
        )
      }
    </For>
  )
}
export default function NotificationsPage(props: PageProps) {
  const rpc = useRpc<NotificationData>(props.entryId),
    connection = useConnection(),
    action = useAction()
  return (
    <>
      <PageHeader
        title="Notifications"
        description="What needs your attention, all in one place."
      />
      <ActionError error={action.error()} />
      <LiveContent ready={rpc.ready}>
        <div class="stack">
          <For each={rpc.data.notifiers}>
            {(notice) => (
              <NotificationCard
                notice={notice}
                disabled={
                  action.busy() || connection.state.status !== 'connected'
                }
                onAction={(id) => void action.run(() => rpc.data.button(id))}
              />
            )}
          </For>
          <Show when={!rpc.data.notifiers?.length}>
            <section class="panel empty-state">
              <h2>All caught up</h2>
              <p>Your plugins have no active notifications.</p>
            </section>
          </Show>
        </div>
      </LiveContent>
    </>
  )
}
function NotificationCard(props: {
  notice: NotificationData['notifiers'][number]
  disabled: boolean
  onAction: (id: string) => void
}) {
  const nodes = createMemo(() => parseNotice(props.notice.content))
  return (
    <article class="panel notification-card" data-type={props.notice.type}>
      <header class="toolbar">
        <span class="chip">{props.notice.type}</span>
        <span class="muted">{props.notice.entryId ?? 'Workspace'}</span>
      </header>
      <div class="rich-content">
        <RichContent
          nodes={nodes()}
          disabled={props.disabled}
          onAction={props.onAction}
        />
      </div>
    </article>
  )
}
