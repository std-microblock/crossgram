/** @jsxImportSource solid-js */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  onCleanup,
  Show,
} from 'solid-js'
import type {
  PlatformAccountDashboardData,
  PlatformAccountView,
} from '../src/dashboard-types.js'
import { useRpc, type PageProps } from 'cordis-webui-solidjs/client'
import {
  ActionError,
  LiveContent,
  Modal,
  PageHeader,
  useAction,
} from 'cordis-webui-solidjs/components'
import { sessionToken } from 'cordis-webui-solidjs/session'
import {
  copyText,
  formatPhone,
  parseTelegramLoginUrl,
  remainingSeconds,
  safeImageURL,
  sameOriginPath,
} from './bridge-model.js'
export default function AccountsPage(props: PageProps) {
  const rpc = useRpc<PlatformAccountDashboardData>(props.entryId),
    action = useAction()
  const [now, setNow] = createSignal(Date.now()),
    [qr, setQr] = createSignal(false),
    [copied, setCopied] = createSignal(false)
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
  const configuration = createMemo(() =>
    JSON.stringify(rpc.data.serverConfig, null, 2),
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
              onClick={() => void action.run(() => rpc.data.refresh())}
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
          <details>
            <summary>View server configuration</summary>
            <pre aria-label="Server configuration">{configuration()}</pre>
          </details>
        </section>
        <div class="section-heading">
          <h2>Your identities</h2>
          <span class="muted">{ids().length} accounts</span>
        </div>
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
        <div class="platform-account-grid">
          <For each={filtered().slice(0, limit())}>
            {(id) => (
              <AccountCard
                account={accounts().get(id)!}
                now={now()}
                connected={rpc.ready}
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
    </>
  )
}
export function AccountCard(props: {
  account: PlatformAccountView
  now: number
  connected: boolean
}) {
  const [failedAvatar, setFailedAvatar] = createSignal(false),
    [copied, setCopied] = createSignal(''),
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
      data-platform={props.account.platformId}
    >
      <header>
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
      </Show>
      <ActionError error={action.error()} />
    </article>
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
