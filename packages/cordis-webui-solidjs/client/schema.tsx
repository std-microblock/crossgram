/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, createUniqueId, For, Index, onCleanup, Show, untrack } from 'solid-js'
import { guardNavigation } from './sdk.js'
import { clone, decodeSchema, description, getAt, initialValue, labelFor, safeKey, setAt, switchUnionValue, unionIndex, validateSchema, type Issue, type SchemaNode } from './schema-model.js'

interface FieldProps {
  schema: SchemaNode; value: any; label: string; path: (string | number)[]; issues: Issue[]; disabled?: boolean; depth?: number
  onChange: (value: any) => void
  onInvalid: (path: (string | number)[], error: string) => void
}
export function SchemaField(props: FieldProps) {
  const id = createUniqueId()
  const schema = () => props.schema
  const value = () => props.value === undefined ? schema().meta.default : props.value
  const disabled = () => props.disabled || schema().meta.disabled
  const issue = () => props.issues.find(issue => JSON.stringify(issue.path) === JSON.stringify(props.path))?.message
  const hint = () => description(schema())
  const [revealed, setRevealed] = createSignal(false)
  const [branch, setBranch] = createSignal(unionIndex(schema(), value()))
  createEffect(() => {
    if (schema().type !== 'union') return
    const current = value()
    const index = schema().list?.findIndex(child => child.type === 'object' && Object.entries(child.dict ?? {}).filter(([, field]) => field.type === 'const').length > 0 && Object.entries(child.dict ?? {}).filter(([, field]) => field.type === 'const').every(([key, field]) => Object.is(current?.[key], field.value))) ?? -1
    if (index >= 0) setBranch(index)
  })
  const [limit, setLimit] = createSignal(20)
  const [key, setKey] = createSignal('')
  const [keyError, setKeyError] = createSignal('')
  const [jsonError, setJsonError] = createSignal('')
  onCleanup(() => props.onInvalid(props.path, ''))
  const childProps = (child: SchemaNode, key: string | number): FieldProps => ({
    schema: child, get value() { return value()?.[key] }, label: typeof key === 'number' ? 'Item ' + (key + 1) : labelFor(key),
    path: [...props.path, key], get issues() { return props.issues }, get disabled() { return disabled() }, depth: (props.depth ?? 0) + 1,
    onChange: next => props.onChange(setAt(value(), [key], next)), onInvalid: props.onInvalid,
  })
  const setJson = (text: string) => {
    try { const next = text.trim() ? JSON.parse(text) : undefined; setJsonError(''); props.onInvalid(props.path, ''); props.onChange(next) }
    catch { setJsonError('Enter valid JSON'); props.onInvalid(props.path, 'Enter valid JSON') }
  }
  const addKey = () => {
    const name = key().trim()
    if (!name || !safeKey(name) || Object.hasOwn(value() ?? {}, name)) { setKeyError('Choose a unique, non-empty key'); return }
    const issues = schema().sKey ? validateSchema(schema().sKey!, name) : []
    if (issues.length) { setKeyError(issues[0].message); return }
    props.onChange({ ...(value() ?? {}), [name]: initialValue(schema().inner!) }); setKey(''); setKeyError('')
  }
  const render = () => {
    const node = schema()
    if ((props.depth ?? 0) > 20) return <p class="muted">Nested schema: use the JSON editor for this value.</p>
    if (node.meta.hidden) return null
    if (node.type === 'object') return <div class="schema-object"><For each={Object.entries(node.dict ?? {}).filter(([, field]) => !field.meta.hidden)}>{([key, child]) => <SchemaField {...childProps(child, key)} />}</For></div>
    if (node.type === 'intersect') return <div class="schema-object"><For each={node.list}>{child => <SchemaField {...props} schema={child} label={description(child) || props.label} depth={(props.depth ?? 0) + 1} />}</For></div>
    if (node.type === 'transform' && node.inner) return <SchemaField {...props} schema={{ ...node.inner, meta: { ...node.inner.meta, ...node.meta } }} depth={(props.depth ?? 0) + 1} />
    if (node.type === 'union') {
      const constants = node.list?.every(child => child.type === 'const')
      const active = () => node.list?.[branch()] ?? node.list?.[0]
      return <div class="stack schema-union"><select id={id} aria-label={props.label} value={String(constants ? unionIndex(node, value()) : branch())} disabled={disabled()} onChange={event => {
        const index = +event.currentTarget.value; setBranch(index); props.onChange(switchUnionValue(node, value(), index))
      }}><For each={node.list}>{(child, index) => <option value={String(index())}>{description(child) || (child.type === 'const' ? String(child.value ?? 'None') : 'Option ' + (index() + 1) + ' · ' + child.type)}</option>}</For></select>
        <Show when={!constants && active()} keyed>{child => <SchemaField {...props} schema={child as SchemaNode} label={props.label + ' value'} depth={(props.depth ?? 0) + 1} />}</Show>
      </div>
    }
    if (node.type === 'array' || node.type === 'tuple') {
      const items = () => node.type === 'tuple' ? node.list ?? [] : Array.from({ length: Math.min(value()?.length ?? 0, limit()) }, () => node.inner!)
      return <div class="schema-list"><Index each={items()}>{(child, index) => <div class="schema-item"><SchemaField {...childProps(child(), index)} /><Show when={node.type === 'array'}><button type="button" class="icon-button" aria-label={'Remove ' + props.label + ' item ' + (index + 1)} disabled={disabled() || (value()?.length ?? 0) <= (node.meta.min ?? 0)} onClick={() => props.onChange(value().filter((_: any, position: number) => position !== index))}>×</button></Show></div>}</Index>
        <Show when={node.type === 'array'}><div class="toolbar"><button type="button" class="button tonal" disabled={disabled() || (value()?.length ?? 0) >= (node.meta.max ?? Infinity)} onClick={() => props.onChange([...(value() ?? []), initialValue(node.inner!)])}>Add item</button><Show when={(value()?.length ?? 0) > limit()}><button type="button" class="button outlined" onClick={() => setLimit(limit() + 20)}>Show more items ({value().length - limit()} remaining)</button></Show></div></Show>
      </div>
    }
    if (node.type === 'dict') return <div class="schema-list"><For each={Object.keys(value() ?? {}).slice(0, limit())}>{key => <div class="schema-item"><SchemaField {...childProps(node.inner!, key)} /><button type="button" class="icon-button" disabled={disabled()} aria-label={'Remove ' + key} onClick={() => props.onChange(setAt(value(), [key], undefined))}>×</button></div>}</For><div class="toolbar"><input aria-label={props.label + ' new key'} placeholder="New key" value={key()} disabled={disabled()} onInput={event => setKey(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addKey() } }} /><button type="button" class="button tonal" disabled={disabled()} onClick={addKey}>Add entry</button><Show when={Object.keys(value() ?? {}).length > limit()}><button type="button" class="button outlined" onClick={() => setLimit(limit() + 20)}>Show more entries</button></Show></div><Show when={keyError()}><small class="field-error" role="alert">{keyError()}</small></Show></div>
    if (node.type === 'boolean') return <label class="switch-field"><input id={id} type="checkbox" role="switch" checked={!!value()} disabled={disabled()} onChange={event => props.onChange(event.currentTarget.checked)} /><span class="switch-track" aria-hidden="true" /><span>{value() ? 'On' : 'Off'}</span></label>
    if (node.type === 'const') return <output id={id} class="schema-constant">{JSON.stringify(node.value)}</output>
    if (node.type === 'number') return <input id={id} type="number" inputmode="decimal" value={value() ?? ''} min={node.meta.min} max={node.meta.max} step={node.meta.step ?? 'any'} disabled={disabled()} aria-invalid={!!issue()} aria-describedby={id + '-hint'} onInput={event => props.onChange(event.currentTarget.value === '' ? undefined : event.currentTarget.valueAsNumber)} />
    if (node.type === 'bitset') return <div class="schema-flags"><For each={Object.entries(node.bits ?? {})}>{([key, bit]) => <label><input type="checkbox" checked={Array.isArray(value()) ? value().includes(key) : !!(value() & bit)} disabled={disabled()} onChange={event => props.onChange(Array.isArray(value()) ? event.currentTarget.checked ? [...value(), key] : value().filter((item: string) => item !== key) : event.currentTarget.checked ? (value() ?? 0) | bit : (value() ?? 0) & ~bit)} /> {labelFor(key)}</label>}</For></div>
    if (node.type === 'string') {
      if (node.meta.role === 'textarea') return <textarea id={id} value={value() ?? ''} disabled={disabled()} aria-invalid={!!issue()} aria-describedby={id + '-hint'} onInput={event => props.onChange(event.currentTarget.value)} />
      return <div class="schema-input-row"><input id={id} type={node.meta.role === 'secret' && !revealed() ? 'password' : node.meta.role === 'link' ? 'url' : node.meta.role === 'datetime' ? 'datetime-local' : 'text'} value={value() ?? ''} autocomplete={node.meta.role === 'secret' ? 'new-password' : 'off'} disabled={disabled()} aria-invalid={!!issue()} aria-describedby={id + '-hint'} onInput={event => props.onChange(event.currentTarget.value)} /><Show when={node.meta.role === 'secret'}><button class="button outlined" type="button" aria-label={(revealed() ? 'Hide ' : 'Reveal ') + props.label} aria-pressed={revealed()} onClick={() => setRevealed(!revealed())}>{revealed() ? 'Hide' : 'Reveal'}</button></Show></div>
    }
    return <div><textarea id={id} aria-label={props.label + ' JSON'} value={JSON.stringify(value(), null, 2) ?? ''} disabled={disabled()} spellcheck={false} onInput={event => setJson(event.currentTarget.value)} /><small>JSON value. Plugin-specific validation runs on save.</small><Show when={jsonError()}><small class="field-error" role="alert">{jsonError()}</small></Show></div>
  }
  return <Show when={!schema().meta.hidden}><div class="field schema-field" classList={{ 'schema-group': ['object', 'array', 'dict', 'tuple', 'intersect'].includes(schema().type), 'has-error': !!issue() }}>
    <div class="schema-label"><label for={id}>{props.label}<Show when={schema().meta.required}><span class="required" aria-label="required"> *</span></Show></label><Show when={props.value !== undefined && !schema().meta.required && !disabled()}><button type="button" class="field-reset" aria-label={'Reset ' + props.label} onClick={() => props.onChange(undefined)}>Reset</button></Show></div>
    <Show when={hint()}><p id={id + '-hint'} class="field-hint">{hint()}</p></Show>
    {render()}
    <Show when={issue()}><small class="field-error" role="alert">{issue()}</small></Show>
  </div></Show>
}
export interface SchemaFormProps {
  schema: unknown; value: any; onSave: (value: any) => Promise<void>; disabled?: boolean; label?: string
}
export function SchemaForm(props: SchemaFormProps) {
  const schema = createMemo(() => decodeSchema(props.schema))
  const [draft, setDraft] = createSignal(clone(props.value) ?? initialValue(schema()))
  const [baseline, setBaseline] = createSignal(JSON.stringify(props.value))
  const [revision, setRevision] = createSignal(0)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal('')
  const [saved, setSaved] = createSignal(false)
  const [raw, setRaw] = createSignal(false)
  const [rawText, setRawText] = createSignal('')
  const [inputErrors, setInputErrors] = createSignal<Record<string, string>>({})
  const dirty = () => JSON.stringify(draft()) !== baseline() || Object.values(inputErrors()).some(Boolean)
  const conflict = () => JSON.stringify(props.value) !== baseline() && dirty()
  const issues = createMemo(() => validateSchema(schema(), draft()))
  const reload = () => { setDraft(clone(props.value) ?? initialValue(schema())); setBaseline(JSON.stringify(props.value)); setInputErrors({}); setError(''); setRawText(JSON.stringify(draft(), null, 2)); setRevision(value => value + 1) }
  createEffect(() => { const current = JSON.stringify(props.value); untrack(() => { if (current !== baseline() && !dirty()) reload() }) })
  guardNavigation(() => !dirty() || window.confirm('Discard your unsaved configuration changes?'))
  const warnUnload = (event: BeforeUnloadEvent) => { if (dirty()) { event.preventDefault(); event.returnValue = '' } }
  window.addEventListener('beforeunload', warnUnload)
  onCleanup(() => window.removeEventListener('beforeunload', warnUnload))
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (saving() || props.disabled || issues().length || Object.values(inputErrors()).some(Boolean) || conflict()) return
    setSaving(true); setError(''); setSaved(false)
    const submitted = clone(draft())
    try { await props.onSave(submitted); setBaseline(JSON.stringify(submitted)); setSaved(true) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  const invalid = (path: (string | number)[], error: string) => setInputErrors(value => ({ ...value, [JSON.stringify(path)]: error }))
  return <form class="schema-form stack" onSubmit={save} novalidate aria-label={props.label ?? 'Plugin configuration'}>
    <Show when={conflict()}><div class="notice error" role="alert">Configuration changed on the server. Reload before saving to avoid overwriting another change. <button class="button outlined" type="button" onClick={reload}>Reload configuration</button></div></Show>
    <div class="toolbar"><button type="button" class="button outlined" aria-pressed={raw()} onClick={() => { setRaw(!raw()); setRawText(JSON.stringify(draft(), null, 2)) }}>{raw() ? 'Use form editor' : 'Edit JSON'}</button><span class="muted">{dirty() ? 'Unsaved changes' : 'Up to date'}</span></div>
    <Show when={raw()} fallback={<Show when={{ schema: schema(), revision: revision() }} keyed>{({ schema }) => <SchemaField schema={schema} value={draft()} label="Configuration" path={[]} issues={issues()} disabled={props.disabled || saving()} onChange={value => { setDraft(() => value === undefined ? initialValue(schema) : value); setSaved(false) }} onInvalid={invalid} />}</Show>}>
      <label class="field"><span>Configuration JSON</span><textarea rows={18} spellcheck={false} value={rawText()} disabled={props.disabled || saving()} onInput={event => {
        setRawText(event.currentTarget.value)
        try { setDraft(JSON.parse(event.currentTarget.value)); invalid(['$json'], '') } catch { invalid(['$json'], 'Enter valid JSON') }
      }} /></label>
    </Show>
    <Show when={issues().length}><div class="notice error" role="alert"><strong>Check your configuration</strong><ul><For each={issues().slice(0, 20)}>{issue => <li>{issue.path.join(' › ') || 'Configuration'}: {issue.message}</li>}</For></ul></div></Show>
    <Show when={Object.values(inputErrors()).some(Boolean)}><div class="notice error" role="alert">Correct invalid JSON before saving.</div></Show>
    <Show when={error()}><div class="notice error" role="alert">{error()}</div></Show>
    <Show when={saved()}><div class="notice" role="status">Configuration saved</div></Show>
    <div class="schema-actions"><button type="submit" class="button filled" disabled={saving() || props.disabled || !dirty() || issues().length > 0 || Object.values(inputErrors()).some(Boolean) || conflict()}>{saving() ? 'Saving…' : 'Save changes'}</button><button type="button" class="button outlined" disabled={saving() || !dirty()} onClick={reload}>Discard changes</button></div>
  </form>
}
