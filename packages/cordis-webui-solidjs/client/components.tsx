/** @jsxImportSource solid-js */
import { createEffect, createSignal, onCleanup, Show, type JSX } from 'solid-js'
import { useConnection } from './sdk.js'
export function PageHeader(props: {
  eyebrow?: string
  title: string
  description?: string
  actions?: JSX.Element
}) {
  return (
    <header class="page-heading toolbar">
      <div class="page-title">
        <span class="eyebrow">{props.eyebrow ?? 'YOUR WORKSPACE'}</span>
        <h1>{props.title}</h1>
        <Show when={props.description}>
          <p>{props.description}</p>
        </Show>
      </div>
      <div class="toolbar">{props.actions}</div>
    </header>
  )
}
export function useAction() {
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal('')
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  return {
    busy,
    error,
    clear: () => setError(''),
    run: async <T,>(action: () => Promise<T>) => {
      if (busy()) return
      setBusy(true)
      setError('')
      try {
        return await action()
      } catch (error) {
        if (!disposed)
          setError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!disposed) setBusy(false)
      }
    },
  }
}
export function ActionError(props: { error: string }) {
  return (
    <Show when={props.error}>
      <div class="notice error" role="alert">
        {props.error}
      </div>
    </Show>
  )
}
export function LiveContent(props: { ready: boolean; children: JSX.Element }) {
  const [loaded, setLoaded] = createSignal(false)
  createEffect(() => {
    if (props.ready) setLoaded(true)
  })
  return (
    <Show
      when={loaded()}
      fallback={
        <div class="loading" role="status">
          Loading live data…
        </div>
      }
    >
      <div classList={{ 'data-stale': !props.ready }}>{props.children}</div>
    </Show>
  )
}
export function Modal(props: {
  title: string
  children: JSX.Element
  onClose: () => void
}) {
  let dialog!: HTMLDialogElement
  createEffect(() => {
    dialog.showModal()
  })
  onCleanup(() => dialog.close())
  return (
    <dialog
      ref={dialog}
      class="modal"
      aria-label={props.title}
      onCancel={(event) => {
        event.preventDefault()
        props.onClose()
      }}
      onClick={(event) => {
        if (event.target === dialog) props.onClose()
      }}
    >
      <div class="modal-content">
        <header class="toolbar">
          <h2>{props.title}</h2>
          <button
            type="button"
            class="icon-button"
            aria-label="Close dialog"
            onClick={props.onClose}
          >
            ×
          </button>
        </header>
        {props.children}
      </div>
    </dialog>
  )
}
export function ConfirmAction(props: {
  label: string
  title: string
  description: string
  action: () => Promise<void>
  disabled?: boolean
  danger?: boolean
}) {
  const [open, setOpen] = createSignal(false)
  const action = useAction()
  const connection = useConnection()
  return (
    <>
      <button
        class={'button ' + (props.danger ? 'danger' : 'outlined')}
        disabled={props.disabled || connection.state.status !== 'connected'}
        onClick={() => setOpen(true)}
      >
        {props.label}
      </button>
      <Show when={open()}>
        <Modal
          title={props.title}
          onClose={() => {
            if (!action.busy()) setOpen(false)
          }}
        >
          <p>{props.description}</p>
          <ActionError error={action.error()} />
          <div class="toolbar">
            <button
              class={'button ' + (props.danger ? 'danger' : 'filled')}
              disabled={action.busy()}
              onClick={() =>
                void action.run(async () => {
                  await props.action()
                  setOpen(false)
                })
              }
            >
              {action.busy() ? 'Working…' : props.label}
            </button>
            <button
              class="button outlined"
              disabled={action.busy()}
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </Modal>
      </Show>
    </>
  )
}
export function JsonView(props: { value: unknown }) {
  return (
    <pre>
      <code>{JSON.stringify(props.value, null, 2)}</code>
    </pre>
  )
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
