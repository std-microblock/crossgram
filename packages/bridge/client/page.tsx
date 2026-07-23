/** @jsxImportSource vue */
/** @jsxRuntime automatic */

import type { Context } from 'cordis'
import { computed, defineComponent, onBeforeUnmount, onMounted, ref, resolveComponent } from 'vue'
import { useRpc } from '@cordisjs/client'
import type { PlatformAccountDashboardData, PlatformAccountView } from '../src/account-dashboard.js'
import './style.css'

export const PlatformAccountCard = defineComponent({
  name: 'PlatformAccountCard',
  props: {
    account: { type: Object as () => PlatformAccountView, required: true },
    now: { type: Number, required: true },
  },
  setup(props) {
    const copied = ref<'phone' | 'code'>()
    const avatarFailed = ref(false)
    let copiedTimer: ReturnType<typeof setTimeout> | undefined
    const remaining = computed(() => props.account.validUntil
      ? Math.max(0, Math.ceil((props.account.validUntil - props.now) / 1_000))
      : 0)
    const progress = computed(() => Math.max(0, Math.min(1, remaining.value / 30)))
    const initials = computed(() => (props.account.displayName ?? props.account.platformId)
      .split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join(''))

    const copy = async (kind: 'phone' | 'code', value?: string) => {
      if (!value) return
      await copyText(value)
      copied.value = kind
      if (copiedTimer) clearTimeout(copiedTimer)
      copiedTimer = setTimeout(() => { copied.value = undefined }, 1_500)
    }
    onBeforeUnmount(() => {
      if (copiedTimer) clearTimeout(copiedTimer)
    })

    return () => {
      const account = props.account
      const ready = account.status === 'ready'
      return <article class={['platform-account-card', `status-${account.status}`]} data-platform={account.platformId}>
        <header class="account-profile">
          <div class="account-avatar" aria-hidden="true">
            {account.avatarUrl && !avatarFailed.value
              ? <img src={account.avatarUrl} alt="" onError={() => { avatarFailed.value = true }} />
              : <span>{initials.value || '?'}</span>}
          </div>
          <div class="account-identity">
            <div class="account-heading">
              <h2>{account.displayName ?? account.platformId}</h2>
              <span class="platform-kind">{account.platformKind}</span>
            </div>
            {account.username && <div class="account-username">@{account.username}</div>}
            <dl class="account-meta">
              <div><dt>平台</dt><dd>{account.platformId}</dd></div>
              <div><dt>用户 ID</dt><dd>{account.userId ?? '—'}</dd></div>
            </dl>
          </div>
        </header>

        {ready
          ? <section class="login-credential-panel" aria-label={`${account.displayName} 登录凭据`}>
            <div class="credential-copy-row">
              <div>
                <span class="credential-label">虚拟手机号</span>
                <code class="phone-number">{formatPhone(account.virtualPhone)}</code>
              </div>
              <button
                type="button"
                class="copy-button"
                aria-label="复制虚拟手机号"
                onClick={() => copy('phone', account.virtualPhone)}
              >{copied.value === 'phone' ? '已复制' : '复制'}</button>
            </div>
            <div class="otp-block">
              <div class="otp-heading">
                <span class="credential-label">登录验证码</span>
                <span class="otp-live" aria-live="polite">{remaining.value} 秒后更新</span>
              </div>
              <div class="otp-content">
                <button
                  type="button"
                  class="otp-code"
                  aria-label={`登录验证码 ${account.loginCode}`}
                  title="点击复制验证码"
                  onClick={() => copy('code', account.loginCode)}
                >{[...(account.loginCode ?? '------')].map((digit, index) =>
                  <span key={index}>{digit}</span>)}</button>
                <div class="otp-timer" style={{ '--otp-progress': `${progress.value * 360}deg` }} aria-hidden="true">
                  <span>{remaining.value}</span>
                </div>
              </div>
              <div class="otp-hint">在 Telegram 登录界面输入上方手机号和当前验证码。</div>
            </div>
          </section>
          : <section class="account-unavailable" role="status">
            <span class="status-dot" />
            <div>
              <strong>{statusTitle(account.status)}</strong>
              <p>{account.error ?? statusDescription(account.status)}</p>
            </div>
          </section>}
      </article>
    }
  },
})

export const PlatformAccountsPage = defineComponent({
  name: 'PlatformAccountsPage',
  setup() {
    const data = useRpc<PlatformAccountDashboardData>()
    const now = ref(Date.now())
    const refreshing = ref(false)
    const refreshError = ref<string>()
    let timer: ReturnType<typeof setInterval> | undefined
    onMounted(() => {
      timer = setInterval(() => { now.value = Date.now() }, 250)
    })
    onBeforeUnmount(() => {
      if (timer) clearInterval(timer)
    })
    const refresh = async () => {
      refreshing.value = true
      refreshError.value = undefined
      try {
        await data.value.refresh()
      } catch (error) {
        refreshError.value = error instanceof Error ? error.message : String(error)
      } finally {
        refreshing.value = false
      }
    }

    return () => {
      const Layout = resolveComponent('k-layout') as any
      const Icon = resolveComponent('k-icon') as any
      const accounts = data.value.accounts
      return <Layout class="platform-accounts-page">{{
        header: () => <div class="accounts-toolbar">
          <div>
            <h1>平台账号</h1>
          </div>
          <button type="button" class="refresh-button" disabled={refreshing.value} onClick={refresh}>
            <Icon name="refresh" />
            <span>{refreshing.value ? '正在刷新' : '刷新资料'}</span>
          </button>
        </div>,
        default: () => <main class="accounts-content">
          {refreshError.value && <div class="dashboard-error" role="alert">刷新失败：{refreshError.value}</div>}
          {accounts.length
            ? <div class="account-grid">
              {accounts.map(account => <PlatformAccountCard key={account.platformId} account={account} now={now.value} />)}
            </div>
            : <div class="accounts-empty">
              <Icon name="account:default" />
              <h2>还没有平台账号</h2>
              <p>启用一个实现了账号资料接口的平台插件后，它会自动显示在这里。</p>
            </div>}
        </main>,
      }}</Layout>
    }
  },
})

export async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const input = document.createElement('textarea')
  input.value = value
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.append(input)
  input.select()
  document.execCommand('copy')
  input.remove()
}

export default function apply(ctx: Context): void {
  ctx.client.router.page({
    path: '/platform-accounts',
    name: '平台账号',
    icon: 'key:default',
    order: 110,
    component: PlatformAccountsPage,
  })
}

function formatPhone(phone?: string): string {
  if (!phone) return '—'
  const digits = phone.replace(/\D/g, '')
  return `+${digits.slice(0, 3)} ${digits.slice(3, 7)} ${digits.slice(7, 11)} ${digits.slice(11)}`.trim()
}

function statusTitle(status: PlatformAccountView['status']): string {
  if (status === 'loading') return '正在获取平台资料'
  if (status === 'unsupported') return '平台尚未提供账号资料'
  return '平台账号不可用'
}

function statusDescription(status: PlatformAccountView['status']): string {
  return status === 'unsupported'
    ? '请让平台插件实现 getAccount()，由平台提供用户、头像和 ID。'
    : 'Cordis 会在平台恢复连接后重新获取资料。'
}
