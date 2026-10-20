import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Icon, type IconName } from './icons.js'
import { useConnectionState } from './sdk.js'

export interface PageHeaderProps {
  eyebrow?: string
  icon?: IconName | string
  title: string
  description?: string
  actions?: ReactNode
}
export function PageHeader({
  eyebrow,
  icon,
  title,
  description,
  actions,
}: PageHeaderProps) {
  return (
    <header className="page-heading">
      <div className="page-title">
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h1>
          {icon ? <Icon name={icon} size={22} /> : null}
          {title}
        </h1>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      {actions ? <div className="toolbar">{actions}</div> : null}
    </header>
  )
}

/** Shared empty state so every page explains itself the same way. */
export function EmptyState({
  icon = 'sparkle',
  title,
  description,
  action,
}: {
  icon?: string
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <section className="panel empty-state">
      <Icon name={icon} size={22} />
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action}
    </section>
  )
}
export interface ActionState {
  busy: boolean
  error: string
  clear: () => void
  run: <T>(action: () => Promise<T>) => Promise<T | undefined>
}
/**
 * Runs one server action at a time, keeps the error for an inline notice, and
 * ignores state updates after unmount.
 */
export function useAction(): ActionState {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const clear = useCallback(() => setError(''), [])
  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
      if (busy) return
      setBusy(true)
      setError('')
      try {
        return await action()
      } catch (caught) {
        if (mounted.current)
          setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        if (mounted.current) setBusy(false)
      }
    },
    [busy],
  )
  return { busy, error, clear, run }
}
export function ActionError({ error }: { error: string }) {
  if (!error) return null
  return (
    <div className="notice error" role="alert">
      <Icon name="alert" />
      <span>{error}</span>
    </div>
  )
}
export function Notice({
  tone,
  icon = 'info',
  children,
}: {
  tone?: 'error' | 'success'
  icon?: string
  children: ReactNode
}) {
  return (
    <div
      className={
        'notice' +
        (tone === 'error' ? ' error' : tone === 'success' ? ' success' : '')
      }
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <Icon name={icon} />
      <span>{children}</span>
    </div>
  )
}
export function Loading({ children }: { children?: ReactNode }) {
  return (
    <div className="loading" role="status">
      <Icon name="refresh" size={18} />
      {children ?? 'Loading…'}
    </div>
  )
}
/** Shows a loading state until the first payload arrives, then keeps the data visible. */
export function LiveContent({
  ready,
  children,
}: {
  ready: boolean
  children: ReactNode
}) {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    if (ready) setLoaded(true)
  }, [ready])
  if (!loaded)
    return (
      <div className="loading" role="status">
        <Icon name="refresh" size={18} />
        Loading live data…
      </div>
    )
  return (
    <div className={'live-content' + (ready ? '' : ' data-stale')}>
      {children}
    </div>
  )
}
export interface ModalProps {
  title: string
  children: ReactNode
  onClose: () => void
  className?: string
}
/**
 * Modal over the page mask. Renders a native `<dialog>` so Escape, focus
 * trapping, and top-layer stacking come from the platform instead of a
 * hand-rolled overlay; the fallback keeps unit-test environments working.
 */
export function Modal({ title, children, onClose, className }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal()
    } else {
      dialog.setAttribute('open', '')
    }
    return () => {
      if (typeof dialog.close === 'function') {
        if (dialog.open) dialog.close()
      }
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className={'modal ' + (className ?? '')}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose()
      }}
    >
      <div className="modal-content">
        <header className="toolbar">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  )
}
export interface ConfirmActionProps {
  label: string
  title: string
  description: ReactNode
  action: () => Promise<void>
  disabled?: boolean
  danger?: boolean
}
export function ConfirmAction({
  label,
  title,
  description,
  action: perform,
  disabled,
  danger,
}: ConfirmActionProps) {
  const [open, setOpen] = useState(false)
  const action = useAction()
  const connection = useConnectionState()
  return (
    <>
      <button
        className={'button ' + (danger ? 'danger' : 'outlined')}
        disabled={disabled || connection.status !== 'connected'}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open ? (
        <Modal
          title={title}
          onClose={() => {
            if (!action.busy) setOpen(false)
          }}
        >
          <p>{description}</p>
          <ActionError error={action.error} />
          <div className="toolbar">
            <button
              className={'button ' + (danger ? 'danger' : 'filled')}
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await perform()
                  setOpen(false)
                })
              }
            >
              {action.busy ? 'Working…' : label}
            </button>
            <button
              className="button outlined"
              disabled={action.busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  )
}
export function JsonView({ value }: { value: unknown }) {
  return (
    <pre className="json-view">
      <code>{JSON.stringify(value, null, 2)}</code>
    </pre>
  )
}
export function useFieldId(prefix = 'field') {
  const id = useId()
  return prefix + id.replaceAll(':', '')
}
export interface AsyncState<T> {
  data: T | undefined
  loading: boolean
  error: unknown
  reload: () => void
  setData: (value: T | undefined) => void
}
/**
 * Minimal data loader replacing Solid's `createResource`. It re-runs when the
 * given deps or `reload()` change, ignores the response of a superseded run,
 * and treats a `undefined` result as "nothing to load" instead of an error.
 */
export function useAsync<T>(
  load: () => Promise<T | undefined> | undefined,
  deps: readonly unknown[],
): AsyncState<T> {
  const [data, setData] = useState<T>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>()
  const [revision, setRevision] = useState(0)
  const latest = useRef(load)
  latest.current = load
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(undefined)
    const task = latest.current()
    if (!task || typeof task.then !== 'function') {
      setLoading(false)
      return
    }
    task
      .then(
        (value) => {
          if (cancelled) return
          setData(value)
          setError(undefined)
        },
        (caught) => {
          if (!cancelled) setError(caught)
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, revision])
  return {
    data,
    loading,
    error,
    reload: () => setRevision((value) => value + 1),
    setData,
  }
}
export function formatBytes(value = 0) {
  if (!Number.isFinite(value)) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let index = 0
  while (value >= 1024 && index < 4) {
    value /= 1024
    index++
  }
  return (
    value.toLocaleString(undefined, { maximumFractionDigits: index ? 1 : 0 }) +
    ' ' +
    units[index]
  )
}
export function formatNumber(value = 0) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 })
}
