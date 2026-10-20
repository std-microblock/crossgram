import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PlatformAccountDashboardData,
  PlatformAccountView,
} from '../src/dashboard-types.js'
import { useRpc, type PageProps } from 'cordis-webui-react/client'
import {
  ActionError,
  LiveContent,
  Modal,
  PageHeader,
  useAction,
} from 'cordis-webui-react/components'
import { sessionToken } from 'cordis-webui-react/session'
import {
  copyText,
  formatPhone,
  formatServerConfig,
  parseTelegramLoginUrl,
  remainingSeconds,
  safeImageURL,
  sameOriginPath,
  serializeServerConfig,
} from './bridge-model.js'
export default function AccountsPage(props: PageProps) {
  const rpc = useRpc<PlatformAccountDashboardData>(props.entryId),
    action = useAction()
  const [now, setNow] = useState(() => Date.now()),
    [qr, setQr] = useState(false),
    [copied, setCopied] = useState(false)
  // Local clock for login-code countdowns only: never a network poll, and it
  // stops as soon as no code is waiting.
  const countdown = (rpc.data.accounts ?? []).some(
    (account) => (account.validUntil ?? 0) > now,
  )
  useEffect(() => {
    if (!countdown) return
    const tick = () => {
      if (!document.hidden) setNow(Date.now())
    }
    const timer = setInterval(tick, 1000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [countdown])
  const accounts = new Map(
    (rpc.data.accounts ?? []).map((account) => [account.platformId, account]),
  )
  const ids = [...accounts.keys()]
  // The page shows the readable document, but the clipboard has to stay on a single
  // line: Android clients reject a pasted pretty-printed configuration as invalid JSON.
  const configuration = formatServerConfig(rpc.data.serverConfig)
  const clipboardConfiguration = serializeServerConfig(rpc.data.serverConfig)
  const [search, setSearch] = useState(''),
    [limit, setLimit] = useState(24)
  const filtered = ids.filter((id) => {
    const account = accounts.get(id)!
    return (account.displayName + ' ' + id + ' ' + account.username)
      .toLowerCase()
      .includes(search.toLowerCase())
  })
  return (
    <>
      <PageHeader
        title="Platform accounts"
        description="Your connected identities. Ready for Telegram."
        actions={
          <>
            <button
              className="button outlined"
              disabled={action.busy || !rpc.ready}
              onClick={() => void action.run(() => rpc.data.refresh())}
            >
              Refresh accounts
            </button>
            <button
              className="button filled"
              disabled={!rpc.ready}
              onClick={() => setQr(true)}
            >
              Approve QR login
            </button>
          </>
        }
      />
      <ActionError error={action.error} />
      <LiveContent ready={rpc.ready}>
        <section className="panel connection-config">
          <div>
            <span className="eyebrow">CONNECT YOUR CLIENT</span>
            <h2>One configuration. Your whole workspace.</h2>
            <p>
              Import this server configuration into a patched Crossgram client.
            </p>
          </div>
          <button
            className="button tonal"
            disabled={!rpc.ready || !rpc.data.serverConfig}
            onClick={() =>
              void action.run(async () => {
                await copyText(clipboardConfiguration!)
                setCopied(true)
              })
            }
          >
            {copied ? 'Configuration copied' : 'Copy server configuration'}
          </button>
          <details>
            <summary>View server configuration</summary>
            <pre aria-label="Server configuration">{configuration}</pre>
          </details>
        </section>
        <div className="section-heading">
          <h2>Your identities</h2>
          <span className="muted">{ids.length} accounts</span>
        </div>
        <label className="field account-search">
          <span className="sr-only">Find an account</span>
          <input
            type="search"
            placeholder="Find an account…"
            value={search}
            onChange={(event) => {
              setSearch(event.currentTarget.value)
              setLimit(24)
            }}
          />
        </label>
        <div className="platform-account-grid">
          {filtered.slice(0, limit).map((id) => (
            <AccountCard
              key={id}
              account={accounts.get(id)!}
              now={now}
              connected={rpc.ready}
              setPassword={(password) =>
                rpc.data.setLoginPassword(id, password)
              }
            />
          ))}
        </div>
        {!filtered.length ? (
          <section className="panel empty-state">
            <h2>
              {ids.length ? 'No matching accounts' : 'No platform accounts yet'}
            </h2>
            <p>
              Enable a platform plugin that provides account information to get
              started.
            </p>
          </section>
        ) : null}
        {filtered.length > limit ? (
          <button
            className="button outlined"
            onClick={() => setLimit(limit + 24)}
          >
            Show more accounts
          </button>
        ) : null}
      </LiveContent>
      {qr ? (
        <QrLogin
          data={rpc.data}
          connected={rpc.ready}
          onClose={() => setQr(false)}
        />
      ) : null}
    </>
  )
}
export function AccountCard(props: {
  account: PlatformAccountView
  now: number
  connected: boolean
  setPassword: (password: string | null) => Promise<void>
}) {
  const [failedAvatar, setFailedAvatar] = useState(false),
    [copied, setCopied] = useState(''),
    [passwordOpen, setPasswordOpen] = useState(false)
  const action = useAction()
  const avatar = safeImageURL(props.account.avatarUrl)
  useEffect(() => {
    setFailedAvatar(false)
  }, [avatar])
  const remaining = remainingSeconds(props.account.validUntil, props.now)
  const initials = (props.account.displayName || props.account.platformId)
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
  const code =
    props.connected && remaining > 0 ? (props.account.loginCode ?? '') : ''
  const copy = (kind: string, value: string) =>
    void action.run(async () => {
      await copyText(value)
      setCopied(kind)
    })
  return (
    <article
      className="panel identity-card"
      data-platform={props.account.platformId}
    >
      <header>
        <div className="identity-avatar">
          {avatar && !failedAvatar ? (
            <img
              src={avatar}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setFailedAvatar(true)}
            />
          ) : (
            <span>{initials}</span>
          )}
        </div>
        <div className="identity-heading">
          <h2>{props.account.displayName || props.account.platformId}</h2>
          <p>
            {props.account.username
              ? '@' + props.account.username
              : props.account.platformKind}
          </p>
        </div>
        <span className="chip">{props.account.platformKind}</span>
      </header>
      <dl className="identity-meta">
        <div>
          <dt>Platform</dt>
          <dd>{props.account.platformId}</dd>
        </div>
        <div>
          <dt>User ID</dt>
          <dd>{props.account.userId ?? '—'}</dd>
        </div>
      </dl>
      {props.account.status === 'ready' ? (
        <>
          <div className="phone-row">
            <div>
              <span className="eyebrow">VIRTUAL PHONE</span>
              <code>{formatPhone(props.account.virtualPhone)}</code>
            </div>
            <button
              className="button outlined"
              aria-label={'Copy phone for ' + props.account.platformId}
              disabled={!props.account.virtualPhone}
              onClick={() => copy('phone', props.account.virtualPhone!)}
            >
              {copied === 'phone' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="otp-panel">
            <div className="toolbar">
              <span className="eyebrow">TELEGRAM LOGIN CODE</span>
              <span className="otp-expiry">
                {code
                  ? remaining + 's remaining'
                  : props.connected
                    ? 'Waiting for a fresh code'
                    : 'Reconnecting…'}
              </span>
            </div>
            <button
              className="otp-digits"
              aria-label={'Copy login code for ' + props.account.platformId}
              disabled={!code}
              onClick={() => copy('code', code)}
            >
              {(code || '------').split('').map((digit, index) => (
                <span key={index}>{digit}</span>
              ))}
            </button>
            <div
              className="otp-progress"
              role="progressbar"
              aria-label="Login code validity"
              aria-valuenow={remaining}
              aria-valuemin={0}
              aria-valuemax={30}
            >
              <span
                style={{ width: Math.min(100, (remaining / 30) * 100) + '%' }}
              />
            </div>
            <small>
              {copied === 'code'
                ? 'Code copied'
                : 'Enter this phone number and code in your Telegram client.'}
            </small>
          </div>
          <div className="phone-row">
            <div>
              <span className="eyebrow">TWO-STEP VERIFICATION</span>
              <code>
                {props.account.hasPassword
                  ? 'Password enabled (all-zero code)'
                  : 'Disabled'}
              </code>
            </div>
            <button
              className="button outlined"
              disabled={!props.connected}
              onClick={() => setPasswordOpen(true)}
            >
              {props.account.hasPassword ? 'Change' : 'Set password'}
            </button>
          </div>
          {props.account.hasPassword ? (
            <button
              className="button outlined"
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
          ) : null}
        </>
      ) : (
        <div className="identity-status" role="status">
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
      )}
      {passwordOpen ? (
        <PasswordModal
          hasPassword={props.account.hasPassword ?? false}
          onClose={() => setPasswordOpen(false)}
          onSubmit={async (password) => {
            await props.setPassword(password)
            setPasswordOpen(false)
          }}
        />
      ) : null}
      <ActionError error={action.error} />
    </article>
  )
}

function PasswordModal(props: {
  hasPassword: boolean
  onClose: () => void
  onSubmit: (password: string) => Promise<void>
}) {
  const [password, setPassword] = useState(''),
    [confirm, setConfirm] = useState('')
  const action = useAction()
  const mismatch = password !== confirm ? 'Passwords do not match.' : undefined
  const weak = password.length < 1 ? 'Password must not be empty.' : undefined
  const problem = mismatch ?? weak
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
      <label className="field">
        <span>Password</span>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          disabled={action.busy}
          onChange={(event) => setPassword(event.currentTarget.value)}
        />
      </label>
      <label className="field">
        <span>Confirm password</span>
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          disabled={action.busy}
          onChange={(event) => setConfirm(event.currentTarget.value)}
        />
      </label>
      {problem ? (
        <p className="notice error" role="alert">
          {problem}
        </p>
      ) : null}
      <ActionError error={action.error} />
      <button
        className="button filled"
        disabled={action.busy || Boolean(problem)}
        onClick={() => void action.run(() => props.onSubmit(password))}
      >
        {action.busy ? 'Saving…' : 'Save password'}
      </button>
    </Modal>
  )
}
function QrLogin(props: {
  data: PlatformAccountDashboardData
  connected: boolean
  onClose: () => void
}) {
  const [input, setInput] = useState(''),
    [account, setAccount] = useState(''),
    [approved, setApproved] = useState(false)
  const scan = useAction(),
    approve = useAction(),
    [controller] = useState(() => new AbortController())
  // Handlers live in effects, so they read the freshest action through a ref
  // instead of capturing the render where the listener was registered.
  const scanRef = useRef(scan)
  scanRef.current = scan
  const token = parseTelegramLoginUrl(input.trim())
  const readyAccounts = (props.data.accounts ?? []).filter(
    (value) => value.status === 'ready',
  )
  useEffect(() => {
    if (!readyAccounts.some((value) => value.platformId === account))
      setAccount(readyAccounts[0]?.platformId ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.data.accounts, account])
  const decode = useCallback(
    (file?: File) => {
      if (!file) return
      void scanRef.current.run(async () => {
        setApproved(false)
        const { decodeQrImage } = await import('./qr.js')
        const result = await decodeQrImage(file, controller.signal)
        if (!parseTelegramLoginUrl(result))
          throw new Error('This is not a valid Telegram login QR code')
        setInput(result)
      })
    },
    [controller],
  )
  useEffect(() => {
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
    return () => {
      controller.abort()
      window.removeEventListener('paste', paste)
    }
  }, [decode, controller])
  return (
    <Modal title="Approve Telegram QR login" onClose={props.onClose}>
      <p>
        Upload or paste a QR image from your Telegram login screen, or paste its
        login link. Nothing is approved until you confirm below.
      </p>
      <label className="field">
        <span>QR image</span>
        <input
          type="file"
          accept="image/*"
          disabled={scan.busy || approve.busy}
          onChange={(event) => decode(event.currentTarget.files?.[0])}
        />
      </label>
      {scan.busy ? <p role="status">Scanning the QR code…</p> : null}
      <label className="field">
        <span>Telegram login link</span>
        <textarea
          value={input}
          placeholder="tg://login?token=…"
          disabled={approve.busy}
          onChange={(event) => {
            setInput(event.currentTarget.value)
            setApproved(false)
          }}
        />
      </label>
      <label className="field">
        <span>Sign in as</span>
        <select
          aria-label="Sign in as"
          value={account}
          disabled={approve.busy}
          onChange={(event) => setAccount(event.currentTarget.value)}
        >
          {readyAccounts.map((value) => (
            <option key={value.platformId} value={value.platformId}>
              {value.displayName || value.platformId} · {value.platformKind}
            </option>
          ))}
        </select>
      </label>
      {input && !token ? (
        <p className="notice error" role="alert">
          Enter a valid Telegram login link containing a 32-byte token.
        </p>
      ) : null}
      <ActionError error={scan.error || approve.error} />
      {approved ? (
        <p className="notice" role="status">
          Login approved. Continue in your Telegram client.
        </p>
      ) : null}
      <button
        className="button filled"
        disabled={
          !token ||
          !account ||
          !props.connected ||
          scan.busy ||
          approve.busy ||
          approved
        }
        onClick={() =>
          void approve.run(async () => {
            const address = sameOriginPath(
              props.data.loginTokenApprovalUrl.replace(/\/$/, '') +
                '/' +
                encodeURIComponent(account) +
                '/approve',
            )
            const headers = new Headers({ 'content-type': 'application/json' })
            if (sessionToken())
              headers.set('authorization', 'Bearer ' + sessionToken())
            const response = await fetch(address, {
              method: 'POST',
              headers,
              body: JSON.stringify({ token }),
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
        {approve.busy ? 'Approving…' : 'Approve login'}
      </button>
      <small className="muted">
        Approving grants the requesting Telegram client access to the selected
        platform account.
      </small>
    </Modal>
  )
}
