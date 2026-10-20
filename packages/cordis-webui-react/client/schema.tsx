import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { Icon } from './icons.js'
import { useNavigationGuard } from './sdk.js'
import {
  clone,
  decodeSchema,
  description,
  initialValue,
  isExpression,
  labelFor,
  safeKey,
  setAt,
  switchUnionValue,
  unionIndex,
  validateSchema,
  type Issue,
  type SchemaNode,
} from './schema-model.js'

interface FieldProps {
  schema: SchemaNode
  value: any
  label: string
  path: (string | number)[]
  issues: Issue[]
  disabled?: boolean
  depth?: number
  onChange: (value: any) => void
  onInvalid: (path: (string | number)[], error: string) => void
}
function useSchemaFieldId() {
  return 'schema:' + useId().replaceAll(':', '')
}
export function SchemaField(props: FieldProps) {
  const id = useSchemaFieldId()
  const schema = props.schema
  const value = props.value === undefined ? schema.meta.default : props.value
  const disabled = !!props.disabled || !!schema.meta.disabled
  const issue = props.issues.find(
    (issue) => JSON.stringify(issue.path) === JSON.stringify(props.path),
  )?.message
  const hint = description(schema)
  const [revealed, setRevealed] = useState(false)
  const [branch, setBranch] = useState(() => unionIndex(schema, value))
  const [limit, setLimit] = useState(20)
  const [key, setKey] = useState('')
  const [keyError, setKeyError] = useState('')
  const [jsonError, setJsonError] = useState('')
  const onInvalid = useRef(props.onInvalid)
  onInvalid.current = props.onInvalid
  useEffect(() => {
    const invalidate = onInvalid.current
    const path = props.path
    return () => invalidate(path, '')
    // The path is stable for one mounted field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (schema.type !== 'union') return
    const index =
      schema.list?.findIndex(
        (child) =>
          child.type === 'object' &&
          Object.entries(child.dict ?? {}).filter(
            ([, field]) => field.type === 'const',
          ).length > 0 &&
          Object.entries(child.dict ?? {})
            .filter(([, field]) => field.type === 'const')
            .every(([key, field]) => Object.is(value?.[key], field.value)),
      ) ?? -1
    if (index >= 0) setBranch(index)
  }, [schema, value])
  /** Structure groups only get a label; leaf values get expression and reset affordances. */
  const leaf = !['object', 'intersect', 'array', 'tuple', 'dict'].includes(
    schema.type,
  )
  const childProps = (child: SchemaNode, key: string | number): FieldProps => ({
    schema: child,
    value: value?.[key],
    label: typeof key === 'number' ? 'Item ' + (key + 1) : labelFor(key),
    path: [...props.path, key],
    issues: props.issues,
    disabled,
    depth: (props.depth ?? 0) + 1,
    onChange: (next) => props.onChange(setAt(value, [key], next)),
    onInvalid: props.onInvalid,
  })
  const setJson = (text: string) => {
    try {
      const next = text.trim() ? JSON.parse(text) : undefined
      setJsonError('')
      props.onInvalid(props.path, '')
      props.onChange(next)
    } catch {
      setJsonError('Enter valid JSON')
      props.onInvalid(props.path, 'Enter valid JSON')
    }
  }
  const addKey = () => {
    const name = key.trim()
    if (!name || !safeKey(name) || Object.hasOwn(value ?? {}, name)) {
      setKeyError('Choose a unique, non-empty key')
      return
    }
    const issues = schema.sKey ? validateSchema(schema.sKey, name) : []
    if (issues.length) {
      setKeyError(issues[0].message)
      return
    }
    props.onChange({
      ...(value ?? {}),
      [name]: initialValue(schema.inner!),
    })
    setKey('')
    setKeyError('')
  }
  const render = (): ReactNode => {
    const node = schema
    if ((props.depth ?? 0) > 20)
      return (
        <p className="muted">
          Nested schema: use the JSON editor for this value.
        </p>
      )
    if (node.meta.hidden) return null
    if (node.type === 'object')
      return (
        <div className="schema-object">
          {Object.entries(node.dict ?? {})
            .filter(([, field]) => !field.meta.hidden)
            .map(([key, child]) => (
              <SchemaField key={key} {...childProps(child, key)} />
            ))}
        </div>
      )
    if (node.type === 'intersect')
      return (
        <div className="schema-object">
          {(node.list ?? []).map((child, index) => (
            <SchemaField
              key={index}
              {...props}
              schema={child}
              label={description(child) || props.label}
              depth={(props.depth ?? 0) + 1}
            />
          ))}
        </div>
      )
    if (node.type === 'transform' && node.inner)
      return (
        <SchemaField
          {...props}
          schema={{ ...node.inner, meta: { ...node.inner.meta, ...node.meta } }}
          depth={(props.depth ?? 0) + 1}
        />
      )
    if (node.type === 'union') {
      const constants = (node.list ?? []).every(
        (child) => child.type === 'const',
      )
      const active = node.list?.[branch] ?? node.list?.[0]
      return (
        <div className="stack schema-union">
          <select
            id={id}
            aria-label={props.label}
            value={String(constants ? unionIndex(node, value) : branch)}
            disabled={disabled}
            onChange={(event) => {
              const index = +event.currentTarget.value
              setBranch(index)
              props.onChange(switchUnionValue(node, value, index))
            }}
          >
            {(node.list ?? []).map((child, index) => (
              <option key={index} value={String(index)}>
                {description(child) ||
                  (child.type === 'const'
                    ? String(child.value ?? 'None')
                    : 'Option ' + (index + 1) + ' · ' + child.type)}
              </option>
            ))}
          </select>
          {!constants && active?.type !== 'const' ? (
            <SchemaField
              {...props}
              schema={active as SchemaNode}
              label={props.label}
              depth={(props.depth ?? 0) + 1}
            />
          ) : null}
        </div>
      )
    }
    if (node.type === 'array' || node.type === 'tuple') {
      const length =
        node.type === 'tuple'
          ? (node.list ?? []).length
          : Math.min(value?.length ?? 0, limit)
      return (
        <div className="schema-list">
          {Array.from({ length }, (_, index) => {
            const child =
              node.type === 'tuple' ? node.list![index] : node.inner!
            return (
              <div className="schema-item" key={index}>
                <SchemaField {...childProps(child, index)} />
                {node.type === 'array' ? (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={
                      'Remove ' + props.label + ' item ' + (index + 1)
                    }
                    disabled={
                      disabled || (value?.length ?? 0) <= (node.meta.min ?? 0)
                    }
                    onClick={() =>
                      props.onChange(
                        value.filter(
                          (_: any, position: number) => position !== index,
                        ),
                      )
                    }
                  >
                    ×
                  </button>
                ) : null}
              </div>
            )
          })}
          {node.type === 'array' ? (
            <div className="toolbar">
              <button
                type="button"
                className="button tonal"
                disabled={
                  disabled ||
                  (value?.length ?? 0) >= (node.meta.max ?? Infinity)
                }
                onClick={() =>
                  props.onChange([...(value ?? []), initialValue(node.inner!)])
                }
              >
                Add item
              </button>
              {(value?.length ?? 0) > limit ? (
                <button
                  type="button"
                  className="button outlined"
                  onClick={() => setLimit(limit + 20)}
                >
                  Show more items ({value.length - limit} remaining)
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      )
    }
    if (node.type === 'dict')
      return (
        <div className="schema-list">
          {Object.keys(value ?? {})
            .slice(0, limit)
            .map((key) => (
              <div className="schema-item" key={key}>
                <SchemaField {...childProps(node.inner!, key)} />
                <button
                  type="button"
                  className="icon-button"
                  disabled={disabled}
                  aria-label={'Remove ' + key}
                  onClick={() => props.onChange(setAt(value, [key], undefined))}
                >
                  ×
                </button>
              </div>
            ))}
          <div className="toolbar">
            <input
              aria-label={props.label + ' new key'}
              placeholder="New key"
              value={key}
              disabled={disabled}
              onChange={(event) => setKey(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addKey()
                }
              }}
            />
            <button
              type="button"
              className="button tonal"
              disabled={disabled}
              onClick={addKey}
            >
              Add entry
            </button>
            {Object.keys(value ?? {}).length > limit ? (
              <button
                type="button"
                className="button outlined"
                onClick={() => setLimit(limit + 20)}
              >
                Show more entries
              </button>
            ) : null}
          </div>
          {keyError ? (
            <small className="field-error" role="alert">
              {keyError}
            </small>
          ) : null}
        </div>
      )
    if (node.type === 'boolean')
      return (
        <label className="switch-field">
          <input
            id={id}
            type="checkbox"
            role="switch"
            checked={!!value}
            disabled={disabled}
            onChange={(event) => props.onChange(event.currentTarget.checked)}
          />
          <span className="switch-track" aria-hidden="true" />
          <span>{value ? 'On' : 'Off'}</span>
        </label>
      )
    if (node.type === 'const')
      return (
        <output id={id} className="schema-constant">
          {JSON.stringify(node.value)}
        </output>
      )
    if (node.type === 'number')
      return (
        <input
          id={id}
          type="number"
          inputMode="decimal"
          value={value ?? ''}
          min={node.meta.min}
          max={node.meta.max}
          step={node.meta.step ?? 'any'}
          disabled={disabled}
          aria-invalid={!!issue}
          aria-describedby={id + '-hint'}
          onChange={(event) =>
            props.onChange(
              event.currentTarget.value === ''
                ? undefined
                : event.currentTarget.valueAsNumber,
            )
          }
        />
      )
    if (node.type === 'bitset')
      return (
        <div className="schema-flags">
          {Object.entries(node.bits ?? {}).map(([key, bit]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={
                  Array.isArray(value) ? value.includes(key) : !!(value & bit)
                }
                disabled={disabled}
                onChange={(event) =>
                  props.onChange(
                    Array.isArray(value)
                      ? event.currentTarget.checked
                        ? [...value, key]
                        : value.filter((item: string) => item !== key)
                      : event.currentTarget.checked
                        ? (value ?? 0) | bit
                        : (value ?? 0) & ~bit,
                  )
                }
              />{' '}
              {labelFor(key)}
            </label>
          ))}
        </div>
      )
    if (node.type === 'string') {
      if (node.meta.role === 'textarea')
        return (
          <textarea
            id={id}
            value={value ?? ''}
            disabled={disabled}
            aria-invalid={!!issue}
            aria-describedby={id + '-hint'}
            onChange={(event) => props.onChange(event.currentTarget.value)}
          />
        )
      return (
        <div className="schema-input-row">
          <input
            id={id}
            type={
              node.meta.role === 'secret' && !revealed
                ? 'password'
                : node.meta.role === 'link'
                  ? 'url'
                  : node.meta.role === 'datetime'
                    ? 'datetime-local'
                    : 'text'
            }
            value={value ?? ''}
            autoComplete={node.meta.role === 'secret' ? 'new-password' : 'off'}
            disabled={disabled}
            aria-invalid={!!issue}
            aria-describedby={id + '-hint'}
            onChange={(event) => props.onChange(event.currentTarget.value)}
          />
          {node.meta.role === 'secret' ? (
            <button
              className="button outlined"
              type="button"
              aria-label={(revealed ? 'Hide ' : 'Reveal ') + props.label}
              aria-pressed={revealed}
              onClick={() => setRevealed(!revealed)}
            >
              {revealed ? 'Hide' : 'Reveal'}
            </button>
          ) : null}
        </div>
      )
    }
    return (
      <div>
        <textarea
          id={id}
          aria-label={props.label + ' JSON'}
          value={JSON.stringify(value, null, 2) ?? ''}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => setJson(event.currentTarget.value)}
        />
        <small>JSON value. Plugin-specific validation runs on save.</small>
        {jsonError ? (
          <small className="field-error" role="alert">
            {jsonError}
          </small>
        ) : null}
      </div>
    )
  }
  if (schema.meta.hidden) return null
  return (
    <div
      className={
        'field schema-field' +
        (['object', 'array', 'dict', 'tuple', 'intersect'].includes(schema.type)
          ? ' schema-group'
          : '') +
        (issue ? ' has-error' : '')
      }
    >
      <div className="schema-label">
        <label htmlFor={id}>
          {props.label}
          {schema.meta.required ? (
            <span className="required" aria-label="required">
              {' '}
              *
            </span>
          ) : null}
        </label>
        {!disabled &&
        leaf &&
        schema.type !== 'const' &&
        schema.type !== 'never' ? (
          <button
            type="button"
            className="field-reset"
            aria-label={
              (isExpression(value)
                ? 'Use literal for '
                : 'Use expression for ') + props.label
            }
            onClick={() =>
              props.onChange(
                isExpression(value)
                  ? initialValue(schema)
                  : { __jsExpr: JSON.stringify(value) ?? 'undefined' },
              )
            }
          >
            {isExpression(value) ? 'Use literal' : 'Expression'}
          </button>
        ) : null}
        {props.value !== undefined &&
        leaf &&
        !schema.meta.required &&
        !disabled ? (
          <button
            type="button"
            className="field-reset"
            aria-label={'Reset ' + props.label}
            onClick={() => props.onChange(undefined)}
          >
            Reset
          </button>
        ) : null}
      </div>
      {hint ? (
        <p id={id + '-hint'} className="field-hint">
          {hint}
        </p>
      ) : null}
      {isExpression(value) ? (
        <>
          <textarea
            id={id}
            aria-label={props.label + ' expression'}
            spellCheck={false}
            disabled={disabled}
            value={value.__jsExpr}
            onChange={(event) =>
              props.onChange({ __jsExpr: event.currentTarget.value })
            }
          />
          <small>
            Evaluated on the server in this plugin's context. Use only code you
            trust; the expression itself is preserved when saved.
          </small>
        </>
      ) : (
        render()
      )}
      {issue ? (
        <small className="field-error" role="alert">
          {issue}
        </small>
      ) : null}
    </div>
  )
}
export interface SchemaFormProps {
  schema: unknown
  value: any
  onSave: (value: any) => Promise<void>
  disabled?: boolean
  label?: string
}
export function SchemaForm(props: SchemaFormProps) {
  const schema = useMemo(() => decodeSchema(props.schema), [props.schema])
  const [draft, setDraft] = useState<any>(
    () => clone(props.value) ?? initialValue(schema),
  )
  const [baseline, setBaseline] = useState(() => JSON.stringify(props.value))
  const [revision, setRevision] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [raw, setRaw] = useState(false)
  const [rawText, setRawText] = useState('')
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({})
  const dirty =
    JSON.stringify(draft) !== baseline ||
    Object.values(inputErrors).some(Boolean)
  const conflict = JSON.stringify(props.value) !== baseline && dirty
  const issues = useMemo(() => validateSchema(schema, draft), [schema, draft])
  const reload = () => {
    setDraft(clone(props.value) ?? initialValue(schema))
    setBaseline(JSON.stringify(props.value))
    setInputErrors({})
    setError('')
    setRawText(
      JSON.stringify(clone(props.value) ?? initialValue(schema), null, 2),
    )
    setRevision((value) => value + 1)
  }
  useEffect(() => {
    const current = JSON.stringify(props.value)
    if (current !== baseline && !dirty) {
      setDraft(clone(props.value) ?? initialValue(schema))
      setBaseline(current)
      setRevision((value) => value + 1)
    }
    // Reload only when the server value changes while the form is clean.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value])
  useNavigationGuard(
    () =>
      !dirty || window.confirm('Discard your unsaved configuration changes?'),
  )
  useEffect(() => {
    const warnUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnUnload)
    return () => window.removeEventListener('beforeunload', warnUnload)
  }, [dirty])
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (
      saving ||
      props.disabled ||
      issues.length ||
      Object.values(inputErrors).some(Boolean) ||
      conflict
    )
      return
    setSaving(true)
    setError('')
    setSaved(false)
    const submitted = clone(draft)
    try {
      await props.onSave(submitted)
      setBaseline(JSON.stringify(submitted))
      setSaved(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }
  const invalid = (path: (string | number)[], error: string) =>
    setInputErrors((value) => ({ ...value, [JSON.stringify(path)]: error }))
  return (
    <form
      className="schema-form stack"
      onSubmit={save}
      noValidate
      aria-label={props.label ?? 'Plugin configuration'}
    >
      {conflict ? (
        <div className="notice error" role="alert">
          Configuration changed on the server. Reload before saving to avoid
          overwriting another change.{' '}
          <button className="button outlined" type="button" onClick={reload}>
            Reload configuration
          </button>
        </div>
      ) : null}
      <div className="toolbar">
        <button
          type="button"
          className="button outlined"
          aria-pressed={raw}
          onClick={() => {
            setRaw(!raw)
            setRawText(JSON.stringify(draft, null, 2))
          }}
        >
          {raw ? 'Use form editor' : 'Edit JSON'}
        </button>
        <span className="muted">
          {dirty ? 'Unsaved changes' : 'Up to date'}
        </span>
      </div>
      {raw ? (
        <label className="field">
          <span>Configuration JSON</span>
          <textarea
            rows={18}
            spellCheck={false}
            value={rawText}
            disabled={props.disabled || saving}
            onChange={(event) => {
              const text = event.currentTarget.value
              setRawText(text)
              try {
                setDraft(JSON.parse(text))
                invalid(['$json'], '')
              } catch {
                invalid(['$json'], 'Enter valid JSON')
              }
            }}
          />
        </label>
      ) : (
        <SchemaField
          key={revision}
          schema={schema}
          value={draft}
          label="Configuration"
          path={[]}
          issues={issues}
          disabled={props.disabled || saving}
          onChange={(value) => {
            setDraft(value === undefined ? initialValue(schema) : value)
            setSaved(false)
          }}
          onInvalid={invalid}
        />
      )}
      {issues.length ? (
        <div className="notice error" role="alert">
          <Icon name="alert" />
          <div>
            <strong>Check your configuration</strong>
            <ul>
              {issues.slice(0, 20).map((issue) => (
                <li key={issue.path.join('.') + issue.message}>
                  <code>{issue.path.join('.') || 'configuration'}</code>{' '}
                  {issue.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      {Object.values(inputErrors).some(Boolean) ? (
        <div className="notice error" role="alert">
          Correct invalid JSON before saving.
        </div>
      ) : null}
      {error ? (
        <div className="notice error" role="alert">
          {error}
        </div>
      ) : null}
      {saved ? (
        <div className="notice" role="status">
          Configuration saved
        </div>
      ) : null}
      <div className="schema-actions">
        <button
          type="submit"
          className="button filled"
          disabled={
            saving ||
            props.disabled ||
            !dirty ||
            issues.length > 0 ||
            Object.values(inputErrors).some(Boolean) ||
            conflict
          }
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          className="button outlined"
          disabled={saving || !dirty}
          onClick={reload}
        >
          Discard changes
        </button>
      </div>
    </form>
  )
}
