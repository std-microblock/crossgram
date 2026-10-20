import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { Identity, Sso, User } from '@cordisjs/plugin-sso'
import { useRpc, type PageProps } from '../sdk.js'
import {
  ActionError,
  ConfirmAction,
  JsonView,
  LiveContent,
  PageHeader,
  useAction,
} from '../components.js'
import {
  beginOAuth,
  sessionToken,
  setSessionToken,
  ssoRequest,
} from '../session.js'
import { safeHttpURL } from './admin-model.js'
type Intent = 'login' | 'register' | 'bind'
type Challenge = Extract<Sso.StepResult, { phase: 'challenge' }> & {
  provider: string
  intent: Intent
  stepupId?: string
}
interface Account {
  user: User | null
  identities: Identity[]
}
export default function SsoPage(props: PageProps) {
  const rpc = useRpc<{ providers: Sso.ProviderMeta[] }>(props.entryId),
    action = useAction()
  const [provider, setProvider] = useState('password'),
    [intent, setIntent] = useState<Intent>('login')
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [code, setCode] = useState('')
  const [challenge, setChallenge] = useState<Challenge>(),
    [stepup, setStepup] =
      useState<Extract<Sso.StepResult, { phase: 'stepup' }>>()
  const [notice, setNotice] = useState('')
  const [account, setAccount] = useState<Account>(),
    [accountLoading, setAccountLoading] = useState(true),
    [accountError, setAccountError] = useState<unknown>()
  const alive = useRef(true)
  const controller = useRef<AbortController | undefined>(undefined),
    cancelWebAuthn = useRef<(() => void) | undefined>(undefined)
  if (!controller.current) controller.current = new AbortController()
  const signal = controller.current.signal
  useEffect(
    () => () => {
      alive.current = false
      controller.current?.abort()
      cancelWebAuthn.current?.()
    },
    [],
  )
  /** Awaitable so flows can finish before reporting success, like Solid's refetch. */
  const loadAccount = async (): Promise<void> => {
    setAccountError(undefined)
    try {
      if (!sessionToken()) {
        if (alive.current) setAccount({ user: null, identities: [] })
        return
      }
      let next: Account
      try {
        const user = await ssoRequest<User>(
          'GET',
          '/sso/me',
          undefined,
          true,
          signal,
        )
        const identities = await ssoRequest<Identity[]>(
          'GET',
          '/sso/identities',
          undefined,
          true,
          signal,
        )
        next = { user, identities }
      } catch (error) {
        if (!sessionToken()) next = { user: null, identities: [] }
        else throw error
      }
      if (alive.current) setAccount(next)
    } catch (caught) {
      if (alive.current) setAccountError(caught)
    } finally {
      if (alive.current) setAccountLoading(false)
    }
  }
  useEffect(() => {
    void loadAccount()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const accountData = accountError ? undefined : account
  const providers = rpc.data.providers
  const available = useMemo(
    () =>
      (providers ?? []).filter(
        (item) => item.interactive && (accountData?.user || item.canBePrimary),
      ),
    [providers, accountData?.user],
  )
  useEffect(() => {
    if (rpc.ready && !available.some((item) => item.name === provider))
      setProvider(available[0]?.name ?? '')
  }, [rpc.ready, available, provider])
  const codeChallenge =
    challenge?.response.shape === 'code' ? challenge.response : undefined
  const selected = available.find((item) => item.name === provider)
  const resetChallenge = () => {
    setChallenge(undefined)
    setStepup(undefined)
    setCode('')
    cancelWebAuthn.current?.()
  }
  async function step(
    name: string,
    kind: Intent,
    input: Record<string, unknown>,
    stepupId?: string,
    depth = 0,
  ): Promise<void> {
    if (depth > 8) throw new Error('Too many sign-in steps. Start again.')
    const path = kind === 'bind' ? '/sso/identities/' : '/sso/sessions/'
    const result = await ssoRequest<Sso.StepResult>(
      'POST',
      path + encodeURIComponent(name),
      {
        ...input,
        ...(kind === 'register' ? { intent: 'register' } : {}),
        ...(stepupId ? { stepupId } : {}),
      },
      kind === 'bind',
      signal,
    )
    if (signal.aborted) return
    if (result.phase === 'finish') {
      if (result.token) setSessionToken(result.token)
      resetChallenge()
      setPassword('')
      await loadAccount()
      setIntent('bind')
      setNotice(kind === 'bind' ? 'Sign-in method linked' : 'You are signed in')
      return
    }
    if (result.phase === 'redirect') {
      location.assign(safeHttpURL(result.url))
      return
    }
    if (result.phase === 'stepup') {
      setStepup(result)
      setChallenge(undefined)
      setNotice('Choose another factor to finish signing in.')
      return
    }
    if (result.phase !== 'challenge')
      throw new Error('Unsupported SSO response')
    if (result.response.shape === 'code') {
      setStepup(undefined)
      setChallenge({ ...result, provider: name, intent: kind, stepupId })
      setCode('')
      return
    }
    const webauthn = await import('@simplewebauthn/browser')
    cancelWebAuthn.current = () =>
      webauthn.WebAuthnAbortService.cancelCeremony()
    if (signal.aborted) return
    const response =
      result.response.shape === 'webauthn-create'
        ? await webauthn.startRegistration({
            optionsJSON: result.response.options,
          })
        : await webauthn.startAuthentication({
            optionsJSON: result.response.options,
          })
    await step(
      name,
      kind,
      { challengeId: result.challengeId, response },
      stepupId,
      depth + 1,
    )
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice('')
    void action.run(async () => {
      const current = challenge
      if (current)
        return step(
          current.provider,
          current.intent,
          { challengeId: current.challengeId, code },
          current.stepupId,
        )
      const name = provider,
        kind: Intent = accountData?.user ? 'bind' : intent
      if (!name) throw new Error('No sign-in provider is available')
      const input =
        selected?.category === 'redirect'
          ? beginOAuth(name)
          : { username, password }
      return step(name, kind, input)
    })
  }
  const user = accountData?.user
  const identities = accountData?.identities ?? []
  return (
    <>
      <PageHeader
        title="Your account"
        description="Sign in, manage your identity, and stay in control."
      />
      <ActionError
        error={action.error || (accountError ? String(accountError) : '')}
      />
      {notice ? (
        <div className="notice" role="status">
          {notice}
        </div>
      ) : null}
      <LiveContent ready={rpc.ready}>
        <div className="account-layout">
          {user ? (
            <section className="panel stack">
              <span className="eyebrow">SIGNED IN</span>
              <h2>{user.display || user.name || 'User ' + user.id}</h2>
              <p className="muted">Account #{user.id}</p>
              <ConfirmAction
                label="Sign out"
                title="Sign out on this device?"
                description="This revokes the current session. Other devices stay signed in."
                action={async () => {
                  try {
                    await ssoRequest(
                      'DELETE',
                      '/sso/sessions',
                      undefined,
                      true,
                      signal,
                    )
                  } finally {
                    setSessionToken(null)
                    resetChallenge()
                    setPassword('')
                    setIntent('login')
                    setNotice('Signed out on this device')
                    await loadAccount()
                  }
                }}
              />
              <h3>Linked sign-in methods</h3>
              {identities.map((identity) => (
                <div key={identity.id} className="identity-row">
                  <div>
                    <strong>{identity.provider}</strong>
                    <small>
                      Linked {new Date(identity.createdAt).toLocaleDateString()}
                    </small>
                  </div>
                  <ConfirmAction
                    label="Unlink"
                    title={'Unlink ' + identity.provider + '?'}
                    description="You will no longer be able to use this method to sign in. Your last sign-in method cannot be removed."
                    disabled={identities.length <= 1}
                    danger
                    action={async () => {
                      await ssoRequest(
                        'DELETE',
                        '/sso/identities/' + identity.id,
                        undefined,
                        true,
                        signal,
                      )
                      await loadAccount()
                    }}
                  />
                </div>
              ))}
            </section>
          ) : null}
          <section className="panel stack">
            <h2>
              {user
                ? 'Link a sign-in method'
                : intent === 'register'
                  ? 'Create your account'
                  : 'Welcome back'}
            </h2>
            {!user ? (
              <div
                className="segmented"
                role="tablist"
                aria-label="Account action"
              >
                <button
                  role="tab"
                  aria-selected={intent === 'login'}
                  className={intent === 'login' ? 'selected' : undefined}
                  disabled={action.busy}
                  onClick={() => {
                    setIntent('login')
                    resetChallenge()
                  }}
                >
                  Sign in
                </button>
                <button
                  role="tab"
                  aria-selected={intent === 'register'}
                  className={intent === 'register' ? 'selected' : undefined}
                  disabled={action.busy}
                  onClick={() => {
                    setIntent('register')
                    resetChallenge()
                  }}
                >
                  Register
                </button>
              </div>
            ) : null}
            {available.length ? (
              !stepup ? (
                <form className="stack" onSubmit={submit}>
                  {!challenge ? (
                    <>
                      <label className="field">
                        <span>Sign-in provider</span>
                        <select
                          aria-label="Sign-in provider"
                          value={provider}
                          disabled={action.busy}
                          onChange={(event) => {
                            setProvider(event.currentTarget.value)
                            resetChallenge()
                          }}
                        >
                          {available.map((item) => (
                            <option key={item.name} value={item.name}>
                              {item.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {selected?.category !== 'redirect' ? (
                        <>
                          <label className="field">
                            <span>Username</span>
                            <input
                              required={selected?.category === 'credentials'}
                              autoComplete="username"
                              value={username}
                              disabled={action.busy}
                              onChange={(event) =>
                                setUsername(event.currentTarget.value)
                              }
                            />
                          </label>
                          {selected?.category === 'credentials' ? (
                            <label className="field">
                              <span>Password</span>
                              <input
                                required
                                type="password"
                                autoComplete={
                                  intent === 'login'
                                    ? 'current-password'
                                    : 'new-password'
                                }
                                value={password}
                                disabled={action.busy}
                                onChange={(event) =>
                                  setPassword(event.currentTarget.value)
                                }
                              />
                            </label>
                          ) : null}
                        </>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <label className="field">
                        <span>Verification code</span>
                        <input
                          required
                          autoComplete="one-time-code"
                          inputMode={codeChallenge?.digits ? 'numeric' : 'text'}
                          minLength={codeChallenge?.length}
                          maxLength={codeChallenge?.length}
                          value={code}
                          onChange={(event) =>
                            setCode(event.currentTarget.value)
                          }
                        />
                      </label>
                      {challenge?.data ? (
                        <details>
                          <summary>Verification instructions</summary>
                          <JsonView value={challenge.data} />
                        </details>
                      ) : null}
                    </>
                  )}
                  <button
                    className="button filled"
                    disabled={action.busy || accountLoading}
                  >
                    {action.busy
                      ? 'Working…'
                      : challenge
                        ? 'Verify code'
                        : user
                          ? 'Link method'
                          : intent === 'register'
                            ? 'Create account'
                            : 'Continue'}
                  </button>
                  {challenge ? (
                    <button
                      type="button"
                      className="button outlined"
                      disabled={action.busy}
                      onClick={resetChallenge}
                    >
                      Start again
                    </button>
                  ) : null}
                </form>
              ) : (
                <div className="stack">
                  <p>An additional verification factor is required.</p>
                  {stepup.factors.map((factor) => (
                    <button
                      key={factor.provider}
                      className="button tonal"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(() =>
                          step(factor.provider, 'login', {}, stepup.stepupId),
                        )
                      }
                    >
                      Verify with {factor.provider}
                    </button>
                  ))}
                  <button className="button outlined" onClick={resetChallenge}>
                    Start again
                  </button>
                </div>
              )
            ) : (
              <p className="notice">
                No interactive sign-in providers are enabled. Enable one in
                plugin management.
              </p>
            )}
          </section>
        </div>
      </LiveContent>
    </>
  )
}
