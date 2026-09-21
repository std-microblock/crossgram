/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, Show } from 'solid-js'
import { useRpc, type PageProps } from '../sdk.js'
import { LiveContent, PageHeader } from '../components.js'
import { pageSlice } from './admin-model.js'
export interface GraphNode {
  uid: number
  name: string
  state: number
  isRoot?: boolean
  isGroup?: boolean
  services?: string[]
}
export interface GraphEdge {
  type: string
  source: number
  target: number
}
interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}
const NODE_WIDTH = 260
const NODE_HEIGHT = 52
const COLUMN_GAP = 80
const ROW_GAP = 76

export interface PlacedNode extends GraphNode {
  x: number
  y: number
}

export interface PlacedEdge {
  key: string
  path: string
  dashed: boolean
}

/**
 * Deterministic three-column neighbourhood: dependencies on the left, the selection in the
 * middle, owned plugins on the right. Columns collapse when empty so the diagram never
 * wastes half its canvas, and edges stop at the node border instead of crossing it.
 */
export function neighborhood(
  nodes: GraphNode[],
  edges: GraphEdge[],
  selected: number,
) {
  const current = nodes.find((node) => node.uid === selected) ?? nodes[0]
  if (!current)
    return {
      nodes: [] as PlacedNode[],
      edges: [] as PlacedEdge[],
      width: NODE_WIDTH,
      height: 220,
      omitted: 0,
    }
  const related = edges.filter(
    (edge) => edge.source === current.uid || edge.target === current.uid,
  )
  const incoming = [
    ...new Set(
      related
        .filter((edge) => edge.target === current.uid)
        .map((edge) => edge.source),
    ),
  ].filter((id) => id !== current.uid)
  const outgoing = [
    ...new Set(
      related
        .filter((edge) => edge.source === current.uid)
        .map((edge) => edge.target),
    ),
  ].filter((id) => id !== current.uid && !incoming.includes(id))
  const left = incoming.slice(0, 20)
  const right = outgoing.slice(0, 20)
  const lookup = new Map(nodes.map((node) => [node.uid, node]))
  const rows = Math.max(left.length, right.length, 1)
  const height = Math.max(220, rows * ROW_GAP + 40)
  const centreY = height / 2 - NODE_HEIGHT / 2
  const columns = [
    ...(left.length ? [{ x: 0, ids: left }] : []),
    { x: 0, ids: [current.uid], root: true },
    ...(right.length ? [{ x: 0, ids: right }] : []),
  ]
  let x = 0
  for (const column of columns) {
    column.x = x
    x += NODE_WIDTH + COLUMN_GAP
  }
  const width = x - COLUMN_GAP
  const placed: PlacedNode[] = []
  const position = new Map<number, PlacedNode>()
  const add = (id: number, columnX: number, y: number) => {
    const node = lookup.get(id)
    if (!node) return
    const entry = { ...node, x: columnX, y }
    placed.push(entry)
    position.set(id, entry)
  }
  for (const column of columns) {
    if (column.root) {
      add(column.ids[0]!, column.x, centreY)
      continue
    }
    const stack =
      (height -
        column.ids.length * NODE_HEIGHT -
        (column.ids.length - 1) * (ROW_GAP - NODE_HEIGHT)) /
      2
    column.ids.forEach((id, index) =>
      add(id, column.x, stack + index * ROW_GAP),
    )
  }
  const visible = new Set(placed.map((node) => node.uid))
  const drawn: PlacedEdge[] = []
  for (const edge of related) {
    const from = position.get(edge.source)
    const to = position.get(edge.target)
    if (!from || !to || !visible.has(from.uid) || !visible.has(to.uid)) continue
    const start = from.x < to.x ? from.x + NODE_WIDTH : from.x
    const end = from.x < to.x ? to.x : to.x + NODE_WIDTH
    const startY = from.y + NODE_HEIGHT / 2
    const endY = to.y + NODE_HEIGHT / 2
    const mid = (start + end) / 2
    drawn.push({
      key: edge.source + ':' + edge.target + ':' + edge.type,
      dashed: edge.type === 'dashed',
      path:
        'M' +
        start +
        ',' +
        startY +
        ' C' +
        mid +
        ',' +
        startY +
        ' ' +
        mid +
        ',' +
        endY +
        ' ' +
        end +
        ',' +
        endY,
    })
  }
  return {
    nodes: placed,
    edges: drawn,
    width,
    height,
    omitted:
      Math.max(0, incoming.length - left.length) +
      Math.max(0, outgoing.length - right.length),
  }
}

export default function InsightPage(props: PageProps) {
  const rpc = useRpc<GraphData>(props.entryId)
  const [selected, setSelected] = createSignal(0),
    [search, setSearch] = createSignal(''),
    [page, setPage] = createSignal(0)
  const nodes = createMemo(() =>
    (rpc.data.nodes ?? []).filter((node) =>
      (node.name + ' ' + (node.services ?? []).join(' '))
        .toLowerCase()
        .includes(search().toLowerCase()),
    ),
  )
  const graph = createMemo(() =>
    neighborhood(rpc.data.nodes ?? [], rpc.data.edges ?? [], selected()),
  )
  const current = () => rpc.data.nodes?.find((node) => node.uid === selected())
  return (
    <>
      <PageHeader
        title="Service map"
        description="See how your plugins and services fit together."
      />
      <LiveContent ready={rpc.ready}>
        <div class="panel stack">
          <div class="toolbar">
            <label class="field grow">
              <span>Find a plugin or service</span>
              <input
                type="search"
                value={search()}
                onInput={(event) => {
                  setSearch(event.currentTarget.value)
                  setPage(0)
                }}
              />
            </label>
            <span class="chip">{rpc.data.nodes?.length ?? 0} nodes</span>
            <span class="chip">
              {rpc.data.edges?.length ?? 0} relationships
            </span>
          </div>
          <div
            class="graph-scroll"
            tabindex="0"
            aria-label="Service relationship diagram"
          >
            <svg
              viewBox={'0 0 ' + graph().width + ' ' + graph().height}
              style={{
                // Scale the diagram to the available width without distorting the boxes.
                'aspect-ratio': graph().width + ' / ' + graph().height,
                'min-width': graph().width + 'px',
                width: '100%',
              }}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label="Selected plugin and its immediate relationships"
            >
              <For each={graph().edges}>
                {(edge) => (
                  <path
                    d={edge.path}
                    class="graph-edge"
                    stroke-dasharray={edge.dashed ? '6 5' : undefined}
                  />
                )}
              </For>
              <For each={graph().nodes}>
                {(node) => (
                  <g
                    transform={'translate(' + node.x + ' ' + node.y + ')'}
                    class="graph-node"
                    classList={{ selected: node.uid === selected() }}
                    role="button"
                    tabindex="0"
                    aria-label={node.name}
                    onClick={() => setSelected(node.uid)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setSelected(node.uid)
                      }
                    }}
                  >
                    <rect width="260" height="52" rx="14" />
                    <text x="16" y="23">
                      {node.name.slice(0, 32)}
                    </text>
                    <text x="16" y="40" class="graph-service-label">
                      {(node.services ?? []).join(', ').slice(0, 34) ||
                        (node.isGroup ? 'Plugin group' : 'Plugin')}
                    </text>
                  </g>
                )}
              </For>
            </svg>
          </div>
          <p class="muted">
            Solid lines: ownership. Dashed lines: service dependencies. Select a
            node to explore its neighborhood; no continuous physics simulation
            runs.
          </p>
          <Show when={graph().omitted}>
            <p class="notice">
              {graph().omitted} additional neighbors are available in the
              searchable list.
            </p>
          </Show>
          <Show when={current()}>
            <div class="toolbar">
              <h3>{current()!.name}</h3>
              <For each={current()!.services}>
                {(service) => <span class="chip">{service}</span>}
              </For>
            </div>
          </Show>
          <div class="node-grid">
            <For each={pageSlice(nodes(), page(), 40)}>
              {(node) => (
                <button
                  class="node-list-button"
                  classList={{ selected: node.uid === selected() }}
                  onClick={() => setSelected(node.uid)}
                >
                  <strong>{node.name}</strong>
                  <small>
                    {(node.services ?? []).join(' · ') ||
                      (node.state === 2 ? 'Running' : 'State ' + node.state)}
                  </small>
                </button>
              )}
            </For>
          </div>
          <div class="pagination">
            <button
              class="button outlined"
              disabled={page() === 0}
              onClick={() => setPage(page() - 1)}
            >
              Previous page
            </button>
            <span>{nodes().length} matching nodes</span>
            <button
              class="button outlined"
              disabled={(page() + 1) * 40 >= nodes().length}
              onClick={() => setPage(page() + 1)}
            >
              Next page
            </button>
          </div>
        </div>
      </LiveContent>
    </>
  )
}
