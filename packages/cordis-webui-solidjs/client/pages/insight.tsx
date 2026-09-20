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
export function neighborhood(
  nodes: GraphNode[],
  edges: GraphEdge[],
  selected: number,
) {
  const current = nodes.find((node) => node.uid === selected) ?? nodes[0]
  if (!current)
    return {
      nodes: [] as (GraphNode & { x: number; y: number })[],
      edges: [] as GraphEdge[],
      height: 200,
      omitted: 0,
    }
  const related = edges.filter(
    (edge) => edge.source === current.uid || edge.target === current.uid,
  )
  const left = [
    ...new Set(
      related
        .filter((edge) => edge.target === current.uid)
        .map((edge) => edge.source),
    ),
  ].filter((id) => id !== current.uid)
  const right = [
    ...new Set(
      related
        .filter((edge) => edge.source === current.uid)
        .map((edge) => edge.target),
    ),
  ].filter((id) => id !== current.uid && !left.includes(id))
  const lookup = new Map(nodes.map((node) => [node.uid, node]))
  const height = Math.max(
    220,
    Math.min(20, Math.max(left.length, right.length)) * 76 + 40,
  )
  const placed = [
    { ...current, x: 380, y: height / 2 - 26 },
    ...left
      .slice(0, 20)
      .flatMap((id, index) =>
        lookup.has(id)
          ? [{ ...lookup.get(id)!, x: 20, y: 20 + index * 76 }]
          : [],
      ),
    ...right
      .slice(0, 20)
      .flatMap((id, index) =>
        lookup.has(id)
          ? [{ ...lookup.get(id)!, x: 740, y: 20 + index * 76 }]
          : [],
      ),
  ]
  const visible = new Set(placed.map((node) => node.uid))
  return {
    nodes: placed,
    edges: related.filter(
      (edge) => visible.has(edge.source) && visible.has(edge.target),
    ),
    height,
    omitted: Math.max(0, left.length - 20) + Math.max(0, right.length - 20),
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
              viewBox={'0 0 1020 ' + graph().height}
              style={{ height: graph().height + 'px' }}
              role="img"
              aria-label="Selected plugin and its immediate relationships"
            >
              <For each={graph().edges}>
                {(edge) => {
                  const from = () =>
                      graph().nodes.find((node) => node.uid === edge.source)!,
                    to = () =>
                      graph().nodes.find((node) => node.uid === edge.target)!
                  return (
                    <path
                      d={
                        'M' +
                        (from().x + 130) +
                        ',' +
                        (from().y + 26) +
                        ' L' +
                        (to().x + 130) +
                        ',' +
                        (to().y + 26)
                      }
                      class="graph-edge"
                      stroke-dasharray={
                        edge.type === 'dashed' ? '6 5' : undefined
                      }
                    />
                  )
                }}
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
                    <rect width="260" height="52" rx="18" />
                    <text x="16" y="23">
                      {node.name.slice(0, 32)}
                    </text>
                    <text x="16" y="40" class="graph-service-label">
                      {(node.services ?? []).join(', ').slice(0, 40) ||
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
