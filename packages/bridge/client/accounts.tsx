/** @jsxImportSource solid-js */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  onCleanup,
  Show,
  untrack,
} from 'solid-js'
import type {
  PlatformAccountDashboardData,
  PlatformAccountDuplicateGroup,
  PlatformAccountRemovalPreview,
  PlatformAccountServerEndpoint,
  PlatformAccountView,
} from '../src/dashboard-types.js'
import { useRpc, type PageProps } from 'cordis-webui-solidjs/client'
import {
  ActionError,
  EmptyState,
  LiveContent,
  Modal,
  PageHeader,
  useAction,
} from 'cordis-webui-solidjs/components'
import { sessionToken } from 'cordis-webui-solidjs/session'
import {
  copyText,
  describeDuplicateGroup,
  duplicateOwners,
  duplicatePlatformIds,
  formatEndpoint,
  formatPhone,
  parseTelegramLoginUrl,
  remainingSeconds,
  safeImageURL,
  sameOriginPath,
  withServerEndpoint,
} from './bridge-model.js'
export default function AccountsPage(props: PageProps) {
  const rpc = useRpc<PlatformAccountDashboardData>(props.entryId),
    action = useAction()
  const [now, setNow] = createSignal(Date.now()),
    [qr, setQr] = createSignal(false),
    [copied, setCopied] = createSignal(false),
    [endpointKey, setEndpointKey] = createSignal(''),
    [selected, setSelected] = createSignal<string[]>([]),
    [deleting, setDeleting] = createSignal<string[] | null>(null),
    [duplicates, setDuplicates] = createSignal<PlatformAccountDuplicateGroup[]>([])
  const tick = () => {
      if (!document.hidden) setNow(Date.now())
    },
    timer = setInterval(tick, 1000)
  document.addEventListener('visibilitychange', tick)
  onCleanup(() => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', tick)
  })
  const accounts = createMemo(
    () =>
      new Map(
        (rpc.data.accounts ?? []).map((account) => [
          account.platformId,
          account,
        ]),
      ),
  )
  const ids = createMemo(() => [...accounts().keys()])
  // Duplicate detection is a durable backend answer, so it is fetched once per
  // connection instead of riding the per-second account snapshot.
  const duplicateScan = useAction()
  const scanDuplicates = async () => {
    await duplicateScan.run(async () => {
      setDuplicates((await rpc.data.findDuplicateAccounts()) ?? [])
    })
  }
  createEffect(() => {
    if (!rpc.ready) return
    untrack(() => void scanDuplicates())
  })
  const duplicateOf = createMemo(() => duplicateOwners(duplicates()))
  // Copying for another endpoint must not silently change the default: nothing is
  // selected until the reader picks an endpoint, and the primary entry wins then.
  const endpoints = createMemo<PlatformAccountServerEndpoint[]>(
    () => rpc.data.serverEndpoints ?? [],
  )
  const endpoint = createMemo(() => {
    const list = endpoints(),
      key = endpointKey()
    return (
      list.find((item) => formatEndpoint(item) === key) ??
      list.find((item) => item.primary) ??
      list[0]
    )
  })
  // The page displays and copies the same document, for the selected endpoint.
  const configuredEndpoint = createMemo(() => {
    const config = rpc.data.serverConfig,
      target = endpoint()
    // Without an advertised endpoint list the document stays exactly as configured.
    return config && target ? withServerEndpoint(config, target) : config
  })
  const configuration = createMemo(() =>
    JSON.stringify(configuredEndpoint(), null, 2),
  )
  const [search, setSearch] = createSignal(''),
    [limit, setLimit] = createSignal(24)
  const filtered = createMemo(() =>
    ids().filter((id) => {
      const account = accounts().get(id)!
      return (account.displayName + ' ' + id + ' ' + account.username)
        .toLowerCase()
        .includes(search().toLowerCase())
    }),
  )
  const duplicateIds = createMemo(() => duplicatePlatformIds(duplicates()))
  const toggle = (id: string, on: boolean) =>
    setSelected((current) =>
      on
        ? current.includes(id)
          ? current
          : [...current, id]
        : current.filter((value) => value !== id),
    )
  const afterRemoval = async () => {
    setSelected([])
    setDeleting(null)
    await scanDuplicates()
  }
  return (
    <>
      <PageHeader
        title="Platform accounts"
        description="Your connected identities. Ready for Telegram."
        actions={
          <>
            <button
              class="button outlined"
              disabled={action.busy() || !rpc.ready}
              onClick={() =>
                void action.run(async () => {
                  await rpc.data.refresh()
                  await scanDuplicates()
                })
              }
            >
              Refresh accounts
            </button>
            <button
              class="button filled"
              disabled={!rpc.ready}
              onClick={() => setQr(true)}
            >
              Approve QR login
            </button>
          </>
        }
      />
      <ActionError error={action.error()} />
      <LiveContent ready={rpc.ready}>
        <section class="panel connection-config">
          <div>
            <span class="eyebrow">CONNECT YOUR CLIENT</span>
            <h2>One configuration. Your whole workspace.</h2>
            <p>
              Import this server configuration into a patched Crossgram client.
            </p>
          </div>
          <div class="connection-config-actions">
            <Show when={endpoints().length > 1}>
              <label class="field endpoint-picker">
                <span>Endpoint</span>
                <select
                  aria-label="Copy endpoint"
                  value={endpoint() ? formatEndpoint(endpoint()!) : ''}
                  onChange={(event) => setEndpointKey(event.currentTarget.value)}
                >
                  <For each={endpoints()}>
                    {(item) => (
                      <option value={formatEndpoint(item)}>
                        {formatEndpoint(item)}
                        {item.primary ? ' (main)' : ''}
                      </option>
                    )}
                  </For>
                </select>
              </label>
            </Show>
            <button
              class="button tonal"
              disabled={!rpc.ready || !rpc.data.serverConfig}
              onClick={() =>
                void action.run(async () => {
                  await copyText(configuration()!)
                  setCopied(true)
                })
              }
            >
              {copied() ? 'Configuration copied' : 'Copy server configuration'}
            </button>
          </div>
          <details>
            <summary>View server configuration</summary>
            <pre aria-label="Server configuration">{configuration()}</pre>
          </details>
        </section>
        <div class="section-heading">
          <h2>Your identities</h2>
          <span class="muted">{ids().length} accounts</span>
        </div>
        <Show when={duplicateIds().length}>
          <section class="panel account-duplicates" data-duplicates>
            <div>
              <strong>
                {duplicateIds().length} duplicate account
                {duplicateIds().length > 1 ? 's' : ''}
              </strong>
              <p>
                Entries that resolve to the same platform user, or that lost
                their virtual phone to another entry. Nothing is deleted until
                you confirm the list.
              </p>
              <ul class="muted">
                <For each={duplicates()}>
                  {(group) => <li>{describeDuplicateGroup(group)}</li>}
                </For>
              </ul>
            </div>
            <button
              class="button outlined"
              onClick={() =>
                setSelected((current) => [
                  ...new Set([...current, ...duplicateIds()]),
                ])
              }
            >
              Select duplicates
            </button>
          </section>
        </Show>
        <label class="field account-search">
          <span class="sr-only">Find an account</span>
          <input
            type="search"
            placeholder="Find an account…"
            value={search()}
            onInput={(event) => {
              setSearch(event.currentTarget.value)
              setLimit(24)
            }}
          />
        </label>
        <Show when={selected().length}>
          <div
            class="toolbar account-selection"
            role="group"
            aria-label="Selected accounts"
          >
            <span class="muted">{selected().length} selected</span>
            <button class="button outlined" onClick={() => setSelected([])}>
              Clear selection
            </button>
            <button
              class="button danger"
              disabled={!rpc.ready}
              onClick={() => setDeleting(selected())}
            >
              Delete selected
            </button>
          </div>
        </Show>
        <div class="platform-account-grid">
          <For each={filtered().slice(0, limit())}>
            {(id) => (
              <AccountCard
                account={accounts().get(id)!}
                now={now()}
                connected={rpc.ready}
                selected={selected().includes(id)}
                duplicateOf={duplicateOf().get(id)}
                onSelect={(on) => toggle(id, on)}
                onDelete={() => setDeleting([id])}
                setPassword={(password) => rpc.data.setLoginPassword(id, password)}
              />
            )}
          </For>
        </div>
        <Show when={!filtered().length}>
          <section class="panel empty-state">
            <h2>
              {ids().length
                ? 'No matching accounts'
                : 'No platform accounts yet'}
            </h2>
            <p>
              Enable a platform plugin that provides account information to get
              started.
            </p>
          </section>
        </Show>
        <Show when={filtered().length > limit()}>
          <button
            class="button outlined"
            onClick={() => setLimit(limit() + 24)}
          >
            Show more accounts
          </button>
        </Show>
      </LiveContent>
      <Show when={qr()}>
        <QrLogin
          data={rpc.data}
          connected={rpc.ready}
          onClose={() => setQr(false)}
        />
      </Show>
      <Show when={deleting()}>
        <DeleteAccounts
          data={rpc.data}
          platformIds={deleting()!}
          onClose={() => setDeleting(null)}
          onDeleted={afterRemoval}
        />
      </Show>
    </>
  )
}
export function AccountCard(props: {
  account: PlatformAccountView
  now: number
  connected: boolean
  selected: boolean
  /** Entry this account duplicates, when the backend proved it is a duplicate. */
  duplicateOf?: string
  onSelect: (selected: boolean) => void
  onDelete: () => void
  setPassword: (password: string | null) => Promise<void>
}) {
  const [failedAvatar, setFailedAvatar] = createSignal(false),
    [copied, setCopied] = createSignal(''),
    [passwordOpen, setPasswordOpen] = createSignal(false),
    action = useAction()
  const avatar = createMemo(() => safeImageURL(props.account.avatarUrl))
  createEffect(() => {
    avatar()
    setFailedAvatar(false)
  })
  const remaining = () => remainingSeconds(props.account.validUntil, props.now)
  const initials = () =>
    (props.account.displayName || props.account.platformId)
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('')
  const code = () =>
    props.connected && remaining() > 0 ? (props.account.loginCode ?? '') : ''
  const copy = (kind: string, value: string) =>
    void action.run(async () => {
      await copyText(value)
      setCopied(kind)
    })
  return (
    <article
      class="panel identity-card"
      classList={{ selected: props.selected }}
      data-platform={props.account.platformId}
    >
      <header>
        <label class="account-select">
          <input
            type="checkbox"
            checked={props.selected}
            aria-label={'Select ' + props.account.platformId}
            onChange={(event) => props.onSelect(event.currentTarget.checked)}
          />
        </label>
        <div class="identity-avatar">
          <Show
            when={avatar() && !failedAvatar()}
            fallback={<span>{initials()}</span>}
          >
            <img
              src={avatar()}
              alt=""
              loading="lazy"
              referrerpolicy="no-referrer"
              onError={() => setFailedAvatar(true)}
            />
          </Show>
        </div>
        <div class="identity-heading">
          <h2>{props.account.displayName || props.account.platformId}</h2>
          <p>
            {props.account.username
              ? '@' + props.account.username
              : props.account.platformKind}
          </p>
        </div>
        <span class="chip">{props.account.platformKind}</span>
      </header>
      <Show when={props.duplicateOf}>
        <div class="identity-duplicate" data-duplicate-of={props.duplicateOf}>
          <span class="chip duplicate">
            Duplicate of {props.duplicateOf}
          </span>
        </div>
      </Show>
      <dl class="identity-meta">
        <div>
          <dt>Platform</dt>
          <dd>{props.account.platformId}</dd>
        </div>
        <div>
          <dt>User ID</dt>
          <dd>{props.account.userId ?? '—'}</dd>
        </div>
      </dl>
      <Show
        when={props.account.status === 'ready'}
        fallback={
          <div class="identity-status" role="status">
            <strong>
              {props.account.status === 'loading'
                ? 'Connecting to your platform'
                : props.account.status === 'unsupported'
                  ? 'Account information unavailable'
                  : 'Account needs attention'}
            </strong>
            <p>
              {props.account.error ||
                'Details will update when the platform becomes available.'}
            </p>
          </div>
        }
      >
        <div class="phone-row">
          <div>
            <span class="eyebrow">VIRTUAL PHONE</span>
            <code>{formatPhone(props.account.virtualPhone)}</code>
          </div>
          <button
            class="button outlined"
            aria-label={'Copy phone for ' + props.account.platformId}
            disabled={!props.account.virtualPhone}
            onClick={() => copy('phone', props.account.virtualPhone!)}
          >
            {copied() === 'phone' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div class="otp-panel">
          <div class="toolbar">
            <span class="eyebrow">TELEGRAM LOGIN CODE</span>
            <span class="otp-expiry">
              {code()
                ? remaining() + 's remaining'
                : props.connected
                  ? 'Waiting for a fresh code'
                  : 'Reconnecting…'}
            </span>
          </div>
          <button
            class="otp-digits"
            aria-label={'Copy login code for ' + props.account.platformId}
            disabled={!code()}
            onClick={() => copy('code', code())}
          >
            <Index each={[...(code() || '------')]}>
              {(digit) => <span>{digit()}</span>}
            </Index>
          </button>
          <div
            class="otp-progress"
            role="progressbar"
            aria-label="Login code validity"
            aria-valuenow={remaining()}
            aria-valuemin={0}
            aria-valuemax={30}
          >
            <span
              style={{ width: Math.min(100, (remaining() / 30) * 100) + '%' }}
            />
          </div>
          <small>
            {copied() === 'code'
              ? 'Code copied'
              : 'Enter this phone number and code in your Telegram client.'}
          </small>
        </div>
        <div class="phone-row">
          <div>
            <span class="eyebrow">TWO-STEP VERIFICATION</span>
            <code>
              {props.account.hasPassword
                ? 'Password enabled (all-zero code)'
                : 'Disabled'}
            </code>
          </div>
          <button
            class="button outlined"
            disabled={!props.connected}
            onClick={() => setPasswordOpen(true)}
          >
            {props.account.hasPassword ? 'Change' : 'Set password'}
          </button>
        </div>
        <Show when={props.account.hasPassword}>
          <button
            class="button outlined"
            disabled={!props.connected}
            onClick={() =>
              void action.run(async () => {
                await props.setPassword(null)
                setPasswordOpen(false)
              })
            }
          >
            Remove password
          </button>
        </Show>
      </Show>
      <Show when={passwordOpen()}>
        <PasswordModal
          hasPassword={props.account.hasPassword ?? false}
          onClose={() => setPasswordOpen(false)}
          onSubmit={async (password) => {
            await props.setPassword(password)
            setPasswordOpen(false)
          }}
        />
      </Show>
      <div class="toolbar identity-actions">
        <button
          class="button danger"
          aria-label={'Delete ' + props.account.platformId}
          disabled={!props.connected}
          onClick={props.onDelete}
        >
          Delete account
        </button>
      </div>
      <ActionError error={action.error()} />
    </article>
  )
}

/**
 * Confirmation for one or more platform entries. The description comes from the
 * backend, so the dialog names the exact entries and how many Telegram clients
 * are signed in through them before anything is removed.
 */
function DeleteAccounts(props: {
  data: PlatformAccountDashboardData
  platformIds: string[]
  onClose: () => void
  onDeleted: () => Promise<void>
}) {
  const [preview, setPreview] =
    createSignal<PlatformAccountRemovalPreview>()
  const load = useAction(),
    remove = useAction()
  void load.run(async () => {
    setPreview(await props.data.describeAccountRemoval(props.platformIds))
  })
  const unmanaged = () =>
    (preview()?.targets ?? []).filter((target) => !target.managed)
  const accounts = () => preview()?.targets ?? []
  return (
    <Modal title="Delete platform accounts" onClose={props.onClose}>
      <p>
        The platform entries below are removed from the configuration, together
        with their virtual phone, login code and two-step verification password.
        Their message history stays in the database.
      </p>
      <Show when={load.busy() && !preview()}>
        <p role="status">Checking what will be removed…</p>
      </Show>
      <ul class="removal-targets">
        <For each={accounts()}>
          {(target) => (
            <li>
              <strong>{target.displayName || target.platformId}</strong>
              <span class="muted">
                {' '}
                {target.displayName ? target.platformId + ' · ' : ''}
                {target.platformKind}
              </span>
            </li>
          )}
        </For>
      </ul>
      <Show when={preview()?.clientAuthorizations}>
        <p class="notice error" role="alert">
          {preview()!.clientAuthorizations} Telegram client
          {preview()!.clientAuthorizations > 1 ? 's' : ''} signed in through
          the selected entries will be signed out.
        </p>
      </Show>
      <Show when={unmanaged().length}>
        <p class="notice error" role="alert">
          {unmanaged()
            .map((target) => target.platformId)
            .join(', ')}{' '}
          {unmanaged().length > 1 ? 'are' : 'is'} not managed by the
          configuration file. Disable the plugin entry instead.
        </p>
      </Show>
      <ActionError error={load.error() || remove.error()} />
      <div class="toolbar">
        <button
          class="button danger"
          disabled={
            remove.busy() || load.busy() || !preview() || unmanaged().length > 0
          }
          onClick={() =>
            void remove.run(async () => {
              await props.data.deleteAccounts(props.platformIds)
              await props.onDeleted()
            })
          }
        >
          {remove.busy() ? 'Deleting…' : 'Delete accounts'}
        </button>
        <button
          class="button outlined"
          disabled={remove.busy()}
          onClick={props.onClose}
        >
          Cancel
        </button>
      </div>
    </Modal>
  )
}

function PasswordModal(props: {
  hasPassword: boolean
  onClose: () => void
  onSubmit: (password: string) => Promise<void>
}) {
  const [password, setPassword] = createSignal(''),
    [confirm, setConfirm] = createSignal(''),
    action = useAction()
  const mismatch = () =>
    password() !== confirm() ? 'Passwords do not match.' : undefined
  const weak = () =>
    password().length < 1 ? 'Password must not be empty.' : undefined
  const problem = () => mismatch() ?? weak()
  return (
    <Modal
      title={props.hasPassword ? 'Change login password' : 'Set login password'}
      onClose={props.onClose}
    >
      <p>
        With a password set, entering an all-zero code (<code>000000</code>, or{' '}
        <code>00000</code> when the client asks for five digits) switches to
        password login; any other valid login code signs in directly.
      </p>
      <label class="field">
        <span>Password</span>
        <input
          type="password"
          autocomplete="new-password"
          value={password()}
          disabled={action.busy()}
          onInput={(event) => setPassword(event.currentTarget.value)}
        />
      </label>
      <label class="field">
        <span>Confirm password</span>
        <input
          type="password"
          autocomplete="new-password"
          value={confirm()}
          disabled={action.busy()}
          onInput={(event) => setConfirm(event.currentTarget.value)}
        />
      </label>
      <Show when={problem()}>
        <p class="notice error" role="alert">{problem()}</p>
      </Show>
      <ActionError error={action.error()} />
      <button
        class="button filled"
        disabled={action.busy() || Boolean(problem())}
        onClick={() => void action.run(() => props.onSubmit(password()))}
      >
        {action.busy() ? 'Saving…' : 'Save password'}
      </button>
    </Modal>
  )
}
function QrLogin(props: {
  data: PlatformAccountDashboardData
  connected: boolean
  onClose: () => void
}) {
  const [input, setInput] = createSignal(''),
    [account, setAccount] = createSignal(''),
    [approved, setApproved] = createSignal(false)
  const scan = useAction(),
    approve = useAction(),
    controller = new AbortController()
  const token = createMemo(() => parseTelegramLoginUrl(input().trim()))
  const readyAccounts = () =>
    (props.data.accounts ?? []).filter((account) => account.status === 'ready')
  createEffect(() => {
    if (!readyAccounts().some((value) => value.platformId === account()))
      setAccount(readyAccounts()[0]?.platformId ?? '')
  })
  const decode = (file?: File) => {
    if (!file) return
    void scan.run(async () => {
      setApproved(false)
      const { decodeQrImage } = await import('./qr.js')
      const result = await decodeQrImage(file, controller.signal)
      if (!parseTelegramLoginUrl(result))
        throw new Error('This is not a valid Telegram login QR code')
      setInput(result)
    })
  }
  const paste = (event: ClipboardEvent) => {
    const file = Array.from(event.clipboardData?.items ?? [])
      .find((item) => item.type.startsWith('image/'))
      ?.getAsFile()
    if (file) {
      event.preventDefault()
      decode(file)
    }
  }
  window.addEventListener('paste', paste)
  onCleanup(() => {
    controller.abort()
    window.removeEventListener('paste', paste)
  })
  return (
    <Modal title="Approve Telegram QR login" onClose={props.onClose}>
      <p>
        Upload or paste a QR image from your Telegram login screen, or paste its
        login link. Nothing is approved until you confirm below.
      </p>
      <label class="field">
        <span>QR image</span>
        <input
          type="file"
          accept="image/*"
          disabled={scan.busy() || approve.busy()}
          onChange={(event) => decode(event.currentTarget.files?.[0])}
        />
      </label>
      <Show when={scan.busy()}>
        <p role="status">Scanning the QR code…</p>
      </Show>
      <label class="field">
        <span>Telegram login link</span>
        <textarea
          value={input()}
          placeholder="tg://login?token=…"
          disabled={approve.busy()}
          onInput={(event) => {
            setInput(event.currentTarget.value)
            setApproved(false)
          }}
        />
      </label>
      <label class="field">
        <span>Sign in as</span>
        <select
          aria-label="Sign in as"
          value={account()}
          disabled={approve.busy()}
          onChange={(event) => setAccount(event.currentTarget.value)}
        >
          <For each={readyAccounts()}>
            {(value) => (
              <option value={value.platformId}>
                {value.displayName || value.platformId} · {value.platformKind}
              </option>
            )}
          </For>
        </select>
      </label>
      <Show when={input() && !token()}>
        <p class="notice error" role="alert">
          Enter a valid Telegram login link containing a 32-byte token.
        </p>
      </Show>
      <ActionError error={scan.error() || approve.error()} />
      <Show when={approved()}>
        <p class="notice" role="status">
          Login approved. Continue in your Telegram client.
        </p>
      </Show>
      <button
        class="button filled"
        disabled={
          !token() ||
          !account() ||
          !props.connected ||
          scan.busy() ||
          approve.busy() ||
          approved()
        }
        onClick={() =>
          void approve.run(async () => {
            const address = sameOriginPath(
              props.data.loginTokenApprovalUrl.replace(/\/$/, '') +
                '/' +
                encodeURIComponent(account()) +
                '/approve',
            )
            const headers = new Headers({ 'content-type': 'application/json' })
            if (sessionToken())
              headers.set('authorization', 'Bearer ' + sessionToken())
            const response = await fetch(address, {
              method: 'POST',
              headers,
              body: JSON.stringify({ token: token() }),
              credentials: 'same-origin',
              signal: controller.signal,
            })
            if (!response.ok) {
              let message = 'Login approval failed: HTTP ' + response.status
              try {
                message = (await response.json()).error ?? message
              } catch {}
              throw new Error(message)
            }
            setApproved(true)
          })
        }
      >
        {approve.busy() ? 'Approving…' : 'Approve login'}
      </button>
      <small class="muted">
        Approving grants the requesting Telegram client access to the selected
        platform account.
      </small>
    </Modal>
  )
}
