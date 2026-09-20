/** @jsxImportSource solid-js */
import { createMemo, createResource, createSignal, For, Show } from 'solid-js'
import { approveNavigation, navigate, useConnection, useRpc, type PageProps } from '../sdk.js'
import { ActionError, ConfirmAction, JsonView, LiveContent, Modal, PageHeader, useAction } from '../components.js'
import { SchemaForm } from '../schema.js'

export interface ConfigEntry { id: string; name: string; label?: string; config?: any; disabled?: boolean; isGroup?: boolean; parent?: string; position?: number; state?: number; isolate?: any; intercept?: any; effects?: unknown[] }
export interface LoaderData {
  entries: ConfigEntry[]; packages: Record<string, any>; services: Record<string, any>; prefix: string
  createConfig(options: any): Promise<string>; updateConfig(options: any): Promise<void>; removeConfig(options: { id: string }): Promise<void>
  getPackageRuntime(options: { name: string }): Promise<{ schema?: any; usage?: string; inject?: any } | null>
  getPackageReadme(options: { name: string; locale: string }): Promise<string | null>
  evalConfig(options: { id: string; expr: string; schema: any }): Promise<{ error?: string; value?: any }>
}
const statuses = ['Waiting', 'Starting', 'Running', 'Failed', 'Disposed', 'Stopping']
export default function LoaderPage(props: PageProps) {
  const rpc = useRpc<LoaderData>(props.entryId), connection = useConnection(), action = useAction()
  const [browse, setBrowse] = createSignal(false)
  const [search, setSearch] = createSignal(''), [limit, setLimit] = createSignal(100), [adding, setAdding] = createSignal(false)
  const selected = createMemo(() => rpc.data.entries?.find(entry => entry.id === decodeURIComponent(props.path.slice('/plugins/'.length))))
  const go = (id?: string) => navigate(connection.config.uiPath + '/plugins' + (id ? '/' + encodeURIComponent(id) : ''))
  const filtered = createMemo(() => (rpc.data.entries ?? []).filter(entry => (entry.label + ' ' + entry.name + ' ' + entry.id).toLowerCase().includes(search().toLowerCase())))
  const depth = (entry: ConfigEntry) => { let depth = 0, current = entry; const seen = new Set([entry.id]); while (current.parent && depth < 8) { const parent = rpc.data.entries.find(item => item.id === current.parent); if (!parent || seen.has(parent.id)) break; seen.add(parent.id); current = parent; depth++ } return depth }
  return <><PageHeader title="Plugins" description="A home for every part of your workspace." actions={<button class="button filled" disabled={connection.state.status !== 'connected'} onClick={() => setAdding(true)}>Add plugin</button>} /><ActionError error={action.error()} />
    <LiveContent ready={rpc.ready}><div class="plugin-layout"><aside class="panel plugin-list" classList={{ collapsed: !!selected() && !browse() }} aria-label="Plugins"><button class="plugin-browser-toggle" aria-expanded={!selected() || browse()} onClick={() => setBrowse(!browse())}>Choose a plugin <span>{rpc.data.entries?.length ?? 0}</span></button><div class="plugin-browser-content"><label class="field"><span class="sr-only">Search plugins</span><input type="search" placeholder="Find a plugin…" value={search()} onInput={event => { setSearch(event.currentTarget.value); setLimit(100) }} /></label><div class="plugin-list-items"><For each={filtered().slice(0, limit())}>{entry => <button class="plugin-list-item" classList={{ selected: selected()?.id === entry.id }} style={{ '--depth': depth(entry) }} onClick={() => { go(entry.id); setBrowse(false) }}><span class="plugin-status" classList={{ running: entry.state === 2, failed: entry.state === 3, disabled: entry.disabled }} /><span><strong>{entry.label || entry.name.replace('@cordisjs/plugin-', '')}</strong><small>{entry.disabled ? 'Disabled' : statuses[entry.state ?? 0]}</small></span></button>}</For></div><Show when={filtered().length > limit()}><button class="button outlined" onClick={() => setLimit(limit() + 100)}>Show more plugins</button></Show></div></aside>
    <section class="panel plugin-detail"><Show when={selected()?.id} keyed fallback={<div class="empty-state"><h2>Everything in its right place</h2><p>Choose a plugin to edit configuration, inspect its services, or manage its lifecycle.</p><div class="toolbar"><span class="chip">{rpc.data.entries?.length ?? 0} configured</span><span class="chip">{rpc.data.entries?.filter(entry => entry.state === 2).length ?? 0} running</span></div></div>}>{id => <PluginDetail entry={selected()!} data={rpc.data} onRemoved={() => go()} />}</Show></section></div></LiveContent>
    <Show when={adding()}><AddPlugin data={rpc.data} parent={selected()?.isGroup ? selected()?.id : selected()?.parent} onClose={() => setAdding(false)} onCreated={id => { setAdding(false); go(id) }} /></Show>
  </>
}
function PluginDetail(props: { entry: ConfigEntry; data: LoaderData; onRemoved: () => void }) {
  const connection = useConnection(), action = useAction()
  const [runtime] = createResource(() => props.entry.name, name => props.data.getPackageRuntime({ name }))
  const [tab, setTab] = createSignal('configuration')
  const [label, setLabel] = createSignal(props.entry.label ?? '')
  const [parent, setParent] = createSignal(props.entry.parent ?? '')
  const [position, setPosition] = createSignal(props.entry.position ?? 0)
  const save = async (config: any) => {
    if (runtime()?.schema) {
      const result = await props.data.evalConfig({ id: props.entry.id, expr: '(' + JSON.stringify(config) + ')', schema: runtime()!.schema })
      if (result.error) throw new Error('Plugin configuration failed ' + result.error + ' validation')
    }
    await props.data.updateConfig({ id: props.entry.id, config })
  }
  return <div class="stack"><header><span class="eyebrow">{props.entry.id}</span><h2>{props.entry.label || props.entry.name}</h2><p class="muted">{props.entry.name}</p></header><div class="toolbar"><span class="chip">{props.entry.disabled ? 'Disabled' : statuses[props.entry.state ?? 0]}</span><ConfirmAction label={props.entry.disabled ? 'Enable plugin' : 'Disable plugin'} title={props.entry.disabled ? 'Enable this plugin?' : 'Disable this plugin?'} description="Dependent services may restart when this plugin changes." action={() => props.data.updateConfig({ id: props.entry.id, disabled: !props.entry.disabled })} /><ConfirmAction label="Remove plugin" title="Remove this plugin?" description="This removes the saved configuration. Group removal also removes its children." danger action={async () => { await props.data.removeConfig({ id: props.entry.id }); props.onRemoved() }} /></div>
    <div class="segmented" role="tablist" aria-label="Plugin details"><For each={['configuration', 'organization', 'services', 'usage']}>{name => <button role="tab" aria-selected={tab() === name} classList={{ selected: tab() === name }} onClick={() => { if (name === tab() || approveNavigation()) setTab(name) }}>{name}</button>}</For></div>
    <ActionError error={action.error() || (runtime.error ? String(runtime.error) : '')} />
    <Show when={tab() === 'configuration'}><Show when={!runtime.loading} fallback={<p class="loading">Loading configuration schema…</p>}><Show when={!props.entry.isGroup} fallback={<p class="muted">This is a plugin group. Select a child to edit its configuration.</p>}><SchemaForm schema={runtime()?.schema ?? { type: 'any', meta: {} }} value={props.entry.config ?? {}} onSave={save} disabled={connection.state.status !== 'connected'} /></Show></Show></Show>
    <Show when={tab() === 'organization'}><form class="stack" onSubmit={event => { event.preventDefault(); void action.run(() => props.data.updateConfig({ id: props.entry.id, label: label() || null, parent: parent() || null, position: position() })) }}><label class="field"><span>Display name</span><input value={label()} onInput={event => setLabel(event.currentTarget.value)} /></label><label class="field"><span>Parent group</span><select value={parent()} onChange={event => setParent(event.currentTarget.value)}><option value="">Workspace root</option><For each={props.data.entries.filter(entry => entry.isGroup && entry.id !== props.entry.id && !isDescendant(entry, props.entry.id, props.data.entries))}>{entry => <option value={entry.id}>{entry.label || entry.name}</option>}</For></select></label><label class="field"><span>Position in group</span><input type="number" min="0" step="1" value={position()} onInput={event => setPosition(Math.max(0, event.currentTarget.valueAsNumber || 0))} /></label><button class="button filled" disabled={action.busy() || connection.state.status !== 'connected'}>Save organization</button></form></Show>
    <Show when={tab() === 'services'}><h3>Service scopes and interception</h3><SchemaForm schema={{ type: 'object', meta: {}, dict: { isolate: { type: 'dict', meta: { description: 'Service names mapped to local (true) or named global scopes.' }, inner: { type: 'union', meta: {}, list: [{ type: 'boolean', meta: {} }, { type: 'string', meta: {} }] } }, intercept: { type: 'dict', meta: {}, inner: { type: 'any', meta: {} } } } }} value={{ isolate: props.entry.isolate ?? {}, intercept: props.entry.intercept ?? {} }} onSave={value => props.data.updateConfig({ id: props.entry.id, ...value })} disabled={connection.state.status !== 'connected'} /><details><summary>Runtime services</summary><JsonView value={props.data.services} /></details><details><summary>Registered effects</summary><JsonView value={props.entry.effects} /></details></Show>
    <Show when={tab() === 'usage'}><p class="usage-text">{runtime()?.usage || 'This plugin has not provided usage documentation.'}</p><p class="muted">Required services</p><JsonView value={runtime()?.inject ?? {}} /></Show>
  </div>
}
function isDescendant(entry: ConfigEntry, ancestor: string, entries: ConfigEntry[]) {
  const seen = new Set<string>()
  while (entry.parent && !seen.has(entry.id)) { seen.add(entry.id); if (entry.parent === ancestor) return true; const parent = entries.find(item => item.id === entry.parent); if (!parent) break; entry = parent }
  return false
}
function AddPlugin(props: { data: LoaderData; parent?: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = createSignal(''), [label, setLabel] = createSignal('')
  const action = useAction()
  return <Modal title="Add a plugin" onClose={props.onClose}><form class="stack" onSubmit={event => { event.preventDefault(); void action.run(async () => { const id = await props.data.createConfig({ name: name().trim(), label: label() || null, parent: props.parent ?? null, disabled: true }); props.onCreated(props.data.prefix && id.startsWith(props.data.prefix) ? id.slice(props.data.prefix.length) : id) }) }}><label class="field"><span>Installed plugin package</span><input required list="installed-plugin-packages" value={name()} onInput={event => setName(event.currentTarget.value)} placeholder="@cordisjs/plugin-…" /><datalist id="installed-plugin-packages"><For each={Object.keys(props.data.packages ?? {})}>{name => <option value={name} />}</For></datalist></label><label class="field"><span>Display name (optional)</span><input value={label()} onInput={event => setLabel(event.currentTarget.value)} /></label><p class="muted">The plugin starts disabled so you can configure it before enabling it.</p><ActionError error={action.error()} /><button class="button filled" disabled={action.busy() || !name().trim()}>Create plugin</button></form></Modal>
}
