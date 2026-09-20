/** @jsxImportSource solid-js */
import {
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from 'solid-js'
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
export default function SsoPage(props: PageProps) {
  const rpc = useRpc<{ providers: Sso.ProviderMeta[] }>(props.entryId),
    action = useAction()
  const [provider, setProvider] = createSignal('password'),
    [intent, setIntent] = createSignal<Intent>('login')
  const [username, setUsername] = createSignal(''),
    [password, setPassword] = createSignal(''),
    [code, setCode] = createSignal('')
  const [challenge, setChallenge] = createSignal<Challenge>(),
    [stepup, setStepup] =
      createSignal<Extract<Sso.StepResult, { phase: 'stepup' }>>()
  const [notice, setNotice] = createSignal('')
  const controller = new AbortController()
  let cancelWebAuthn: (() => void) | undefined
  onCleanup(() => {
    controller.abort()
    cancelWebAuthn?.()
  })
  const [account, { refetch }] = createResource(async () => {
    if (!sessionToken())
      return { user: null as User | null, identities: [] as Identity[] }
    try {
      const user = await ssoRequest<User>(
        'GET',
        '/sso/me',
        undefined,
        true,
        controller.signal,
      )
      const identities = await ssoRequest<Identity[]>(
        'GET',
        '/sso/identities',
        undefined,
        true,
        controller.signal,
      )
      return { user, identities }
    } catch (error) {
      if (!sessionToken()) return { user: null, identities: [] }
      throw error
    }
  })
  const available = () =>
    (rpc.data.providers ?? []).filter(
      (item) => item.interactive && (accountData()?.user || item.canBePrimary),
    )
  createEffect(() => {
    if (rpc.ready && !available().some((item) => item.name === provider()))
      setProvider(available()[0]?.name ?? '')
  })
  const codeChallenge = () => {
    const response = challenge()?.response
    return response?.shape === 'code' ? response : undefined
  }
  const accountData = () => (account.error ? undefined : account())
  const selected = () => available().find((item) => item.name === provider())
  const resetChallenge = () => {
    setChallenge(undefined)
    setStepup(undefined)
    setCode('')
    cancelWebAuthn?.()
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
      controller.signal,
    )
    if (controller.signal.aborted) return
    if (result.phase === 'finish') {
      if (result.token) setSessionToken(result.token)
      resetChallenge()
      setPassword('')
      await refetch()
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
    cancelWebAuthn = () => webauthn.WebAuthnAbortService.cancelCeremony()
    if (controller.signal.aborted) return
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
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    setNotice('')
    void action.run(async () => {
      const current = challenge()
      if (current)
        return step(
          current.provider,
          current.intent,
          { challengeId: current.challengeId, code: code() },
          current.stepupId,
        )
      const name = provider(),
        kind = accountData()?.user ? 'bind' : intent()
      if (!name) throw new Error('No sign-in provider is available')
      const input =
        selected()?.category === 'redirect'
          ? beginOAuth(name)
          : { username: username(), password: password() }
      return step(name, kind, input)
    })
  }
  return (
    <>
      <PageHeader
        title="Your account"
        description="Sign in, manage your identity, and stay in control."
      />
      <ActionError
        error={action.error() || (account.error ? String(account.error) : '')}
      />
      <Show when={notice()}>
        <div class="notice" role="status">
          {notice()}
        </div>
      </Show>
      <LiveContent ready={rpc.ready}>
        <div class="account-layout">
          <Show when={accountData()?.user}>
            <section class="panel stack">
              <span class="eyebrow">SIGNED IN</span>
              <h2>
                {accountData()!.user!.display ||
                  accountData()!.user!.name ||
                  'User ' + accountData()!.user!.id}
              </h2>
              <p class="muted">Account #{accountData()!.user!.id}</p>
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
                      controller.signal,
                    )
                  } finally {
                    setSessionToken(null)
                    resetChallenge()
                    setPassword('')
                    setIntent('login')
                    setNotice('Signed out on this device')
                    await refetch()
                  }
                }}
              />
              <h3>Linked sign-in methods</h3>
              <For each={accountData()?.identities}>
                {(identity) => (
                  <div class="identity-row">
                    <div>
                      <strong>{identity.provider}</strong>
                      <small>
                        Linked{' '}
                        {new Date(identity.createdAt).toLocaleDateString()}
                      </small>
                    </div>
                    <ConfirmAction
                      label="Unlink"
                      title={'Unlink ' + identity.provider + '?'}
                      description="You will no longer be able to use this method to sign in. Your last sign-in method cannot be removed."
                      disabled={(accountData()?.identities.length ?? 0) <= 1}
                      danger
                      action={async () => {
                        await ssoRequest(
                          'DELETE',
                          '/sso/identities/' + identity.id,
                          undefined,
                          true,
                          controller.signal,
                        )
                        await refetch()
                      }}
                    />
                  </div>
                )}
              </For>
            </section>
          </Show>
          <section class="panel stack">
            <h2>
              {accountData()?.user
                ? 'Link a sign-in method'
                : intent() === 'register'
                  ? 'Create your account'
                  : 'Welcome back'}
            </h2>
            <Show when={!accountData()?.user}>
              <div class="segmented" role="tablist" aria-label="Account action">
                <button
                  role="tab"
                  aria-selected={intent() === 'login'}
                  classList={{ selected: intent() === 'login' }}
                  disabled={action.busy()}
                  onClick={() => {
                    setIntent('login')
                    resetChallenge()
                  }}
                >
                  Sign in
                </button>
                <button
                  role="tab"
                  aria-selected={intent() === 'register'}
                  classList={{ selected: intent() === 'register' }}
                  disabled={action.busy()}
                  onClick={() => {
                    setIntent('register')
                    resetChallenge()
                  }}
                >
                  Register
                </button>
              </div>
            </Show>
            <Show
              when={available().length}
              fallback={
                <p class="notice">
                  No interactive sign-in providers are enabled. Enable one in
                  plugin management.
                </p>
              }
            >
              <Show
                when={!stepup()}
                fallback={
                  <div class="stack">
                    <p>An additional verification factor is required.</p>
                    <For each={stepup()?.factors}>
                      {(factor) => (
                        <button
                          class="button tonal"
                          disabled={action.busy()}
                          onClick={() =>
                            void action.run(() =>
                              step(
                                factor.provider,
                                'login',
                                {},
                                stepup()!.stepupId,
                              ),
                            )
                          }
                        >
                          Verify with {factor.provider}
                        </button>
                      )}
                    </For>
                    <button class="button outlined" onClick={resetChallenge}>
                      Start again
                    </button>
                  </div>
                }
              >
                <form class="stack" onSubmit={submit}>
                  <Show
                    when={!challenge()}
                    fallback={
                      <>
                        <label class="field">
                          <span>Verification code</span>
                          <input
                            required
                            autocomplete="one-time-code"
                            inputmode={
                              codeChallenge()?.digits ? 'numeric' : 'text'
                            }
                            minlength={codeChallenge()?.length}
                            maxlength={codeChallenge()?.length}
                            value={code()}
                            onInput={(event) =>
                              setCode(event.currentTarget.value)
                            }
                          />
                        </label>
                        <Show when={challenge()?.data}>
                          <details>
                            <summary>Verification instructions</summary>
                            <JsonView value={challenge()?.data} />
                          </details>
                        </Show>
                      </>
                    }
                  >
                    <label class="field">
                      <span>Sign-in provider</span>
                      <select
                        aria-label="Sign-in provider"
                        value={provider()}
                        disabled={action.busy()}
                        onChange={(event) => {
                          setProvider(event.currentTarget.value)
                          resetChallenge()
                        }}
                      >
                        <For each={available()}>
                          {(item) => (
                            <option value={item.name}>{item.name}</option>
                          )}
                        </For>
                      </select>
                    </label>
                    <Show when={selected()?.category !== 'redirect'}>
                      <label class="field">
                        <span>Username</span>
                        <input
                          required={selected()?.category === 'credentials'}
                          autocomplete="username"
                          value={username()}
                          disabled={action.busy()}
                          onInput={(event) =>
                            setUsername(event.currentTarget.value)
                          }
                        />
                      </label>
                      <Show when={selected()?.category === 'credentials'}>
                        <label class="field">
                          <span>Password</span>
                          <input
                            required
                            type="password"
                            autocomplete={
                              intent() === 'login'
                                ? 'current-password'
                                : 'new-password'
                            }
                            value={password()}
                            disabled={action.busy()}
                            onInput={(event) =>
                              setPassword(event.currentTarget.value)
                            }
                          />
                        </label>
                      </Show>
                    </Show>
                  </Show>
                  <button
                    class="button filled"
                    disabled={action.busy() || account.loading}
                  >
                    {action.busy()
                      ? 'Working…'
                      : challenge()
                        ? 'Verify code'
                        : accountData()?.user
                          ? 'Link method'
                          : intent() === 'register'
                            ? 'Create account'
                            : 'Continue'}
                  </button>
                  <Show when={challenge()}>
                    <button
                      type="button"
                      class="button outlined"
                      disabled={action.busy()}
                      onClick={resetChallenge}
                    >
                      Start again
                    </button>
                  </Show>
                </form>
              </Show>
            </Show>
          </section>
        </div>
      </LiveContent>
    </>
  )
}
