/** @jsxImportSource vue */
/** @jsxRuntime automatic */

import type { Context } from 'cordis'
import { computed, defineComponent, onBeforeUnmount, onMounted, ref, resolveComponent } from 'vue'
import { useRpc } from '@cordisjs/client'
import jsQR from 'jsqr'
import type { PlatformAccountDashboardData, PlatformAccountView } from '../src/account-dashboard.js'
import type { BotDashboardData } from '../src/bot-dashboard.js'
import type {
  StickerDashboardPack, StickerPackDashboardData,
} from '../src/sticker-dashboard.js'
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
    const qrMessage = ref<string>()
    const serverConfig = computed(() => JSON.stringify(data.value.serverConfig, null, 2))
    const copiedServerConfig = ref(false)
    let timer: ReturnType<typeof setInterval> | undefined
    let copiedTimer: ReturnType<typeof setTimeout> | undefined
    const approveLoginToken = async (token: string, platformId: string) => {
      qrMessage.value = undefined
      try {
        const response = await fetch(`${data.value.loginTokenApprovalUrl}/${encodeURIComponent(platformId)}/approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        if (!response.ok) throw new Error('二维码批准失败，请重新登录 WebUI 后重试。')
        qrMessage.value = '已批准 Telegram 二维码登录，请在 Telegram Desktop 中继续。'
      } catch (error) {
        qrMessage.value = error instanceof Error ? error.message : String(error)
      }
    }
    const handlePaste = (event: ClipboardEvent) => {
      const item = Array.from(event.clipboardData?.items ?? []).find(item => item.type.startsWith('image/'))
      const image = item?.getAsFile()
      if (!image) return
      event.preventDefault()
      void decodeLoginQr(image)
    }
    const decodeLoginQr = async (image: File) => {
      const maxBytes = 8 * 1024 * 1024
      const maxDimension = 4_096
      const maxPixels = 16_000_000
      if (image.size > maxBytes) {
        qrMessage.value = '二维码图片过大，请粘贴 8MB 以内的图片。'
        return
      }
      let bitmap: ImageBitmap | undefined
      try {
        bitmap = await createImageBitmap(image)
        if (bitmap.width > maxDimension || bitmap.height > maxDimension || bitmap.width * bitmap.height > maxPixels) {
          qrMessage.value = '二维码图片尺寸过大，请粘贴不超过 4096×4096 的图片。'
          return
        }
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('无法读取二维码图片。')
        context.drawImage(bitmap, 0, 0)
        const result = jsQR(context.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width, bitmap.height)
        if (!result) {
          qrMessage.value = '未能在粘贴的图片中识别到二维码。'
          return
        }
        const token = parseTelegramLoginUrl(result.data)
        if (!token) {
          qrMessage.value = '该二维码不是 Telegram 登录二维码。'
          return
        }
        const accounts = data.value.accounts.filter(account => account.status === 'ready')
        if (!accounts.length) {
          qrMessage.value = '没有可用于批准登录的平台账号。'
          return
        }
        if (accounts.length === 1) {
          await approveLoginToken(token, accounts[0]!.platformId)
          return
        }
        const choices = accounts.map((account, index) =>
          `${index + 1}. ${account.displayName ?? account.platformId}`).join('\n')
        const selected = window.prompt(`请选择要登录的平台账号：\n${choices}`, '1')
        if (selected === null) return
        const account = accounts[Number(selected) - 1]
        if (!account) {
          qrMessage.value = '请选择列表中的平台账号。'
          return
        }
        await approveLoginToken(token, account.platformId)
      } catch (error) {
        qrMessage.value = error instanceof Error ? error.message : '二维码图片无法读取。'
      } finally {
        bitmap?.close()
      }
    }
    onMounted(() => {
      timer = setInterval(() => { now.value = Date.now() }, 250)
      window.addEventListener('paste', handlePaste)
    })
    onBeforeUnmount(() => {
      if (timer) clearInterval(timer)
      if (copiedTimer) clearTimeout(copiedTimer)
      window.removeEventListener('paste', handlePaste)
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
    const copyServerConfig = async () => {
      try {
        await copyText(serverConfig.value)
      } catch {
        return
      }
      copiedServerConfig.value = true
      if (copiedTimer) clearTimeout(copiedTimer)
      copiedTimer = setTimeout(() => { copiedServerConfig.value = false }, 1_500)
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
          {qrMessage.value && <div class="dashboard-error" role="status">{qrMessage.value}</div>}
          <section class="server-config-panel" aria-labelledby="server-config-heading">
            <div class="server-config-header">
              <div>
                <h2 id="server-config-heading">服务器连接配置</h2>
                <p>将以下 JSON 导入 CrossGram 客户端以连接此服务器。</p>
              </div>
              <button
                type="button"
                class="copy-button"
                aria-label="复制服务器连接配置"
                onClick={copyServerConfig}
              >{copiedServerConfig.value ? '已复制' : '复制'}</button>
            </div>
            <pre class="server-config-code"><code>{serverConfig.value}</code></pre>
            <span class="sr-only" aria-live="polite">
              {copiedServerConfig.value ? '服务器连接配置已复制' : ''}
            </span>
          </section>
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

export const StickerPacksPage = defineComponent({
  name: 'StickerPacksPage',
  setup() {
    const data = useRpc<PlatformAccountDashboardData & StickerPackDashboardData>()
    const selectedAccount = ref<string>()
    const query = ref('')
    const refreshing = ref(false)
    const pending = ref<string>()
    const error = ref<string>()
    const currentAccount = computed(() => {
      const accounts = data.value.stickerAccounts
      return accounts.find(account => account.platformSessionId === selectedAccount.value) ?? accounts[0]
    })
    const visiblePacks = computed(() => {
      const needle = query.value.trim().toLocaleLowerCase()
      if (!needle) return data.value.stickerPacks
      return data.value.stickerPacks.filter(pack => [pack.title, pack.providerId, pack.packId]
        .some(value => value.toLocaleLowerCase().includes(needle)))
    })
    const refresh = async () => {
      refreshing.value = true
      error.value = undefined
      try {
        await data.value.refreshStickerPacks()
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : String(cause)
      } finally {
        refreshing.value = false
      }
    }
    const toggle = async (pack: StickerDashboardPack) => {
      const account = currentAccount.value
      if (!account) return
      const assignment = pack.assignments.find(item => item.platformSessionId === account.platformSessionId)
      if (assignment?.automatic) return
      const key = `${account.platformSessionId}\0${pack.providerId}\0${pack.packId}`
      pending.value = key
      error.value = undefined
      try {
        await data.value.setStickerPackAssigned(
          account.platformSessionId, pack.providerId, pack.packId, !assignment?.assigned,
        )
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : String(cause)
      } finally {
        if (pending.value === key) pending.value = undefined
      }
    }

    return () => {
      const Layout = resolveComponent('k-layout') as any
      const Icon = resolveComponent('k-icon') as any
      const accounts = data.value.stickerAccounts
      const account = currentAccount.value
      return <Layout class="sticker-packs-page">{{
        header: () => <div class="accounts-toolbar sticker-toolbar">
          <div>
            <h1>表情包管理</h1>
            <p>由 Bridge 统一决定每个账号可用的表情包集合。</p>
          </div>
          <button type="button" class="refresh-button" disabled={refreshing.value} onClick={refresh}>
            <Icon name="refresh" />
            <span>{refreshing.value ? '正在刷新' : '刷新目录'}</span>
          </button>
        </div>,
        default: () => <main class="sticker-content">
          {error.value && <div class="dashboard-error" role="alert">操作失败：{error.value}</div>}
          {accounts.length
            ? <>
              <section class="sticker-account-picker" aria-label="目标账号">
                <div class="picker-label">添加到账号</div>
                <div class="account-tabs">
                  {accounts.map(item => <button
                    key={item.platformSessionId}
                    type="button"
                    class={['account-tab', { active: item.platformSessionId === account?.platformSessionId }]}
                    aria-pressed={item.platformSessionId === account?.platformSessionId}
                    onClick={() => { selectedAccount.value = item.platformSessionId }}
                  >
                    <strong>{item.displayName}</strong>
                    <span>{item.platformKind} · {item.userId}</span>
                  </button>)}
                </div>
              </section>
              <section class="sticker-catalog">
                <div class="catalog-heading">
                  <div>
                    <h2>可用集合</h2>
                    <span>{visiblePacks.value.length} 个表情包</span>
                  </div>
                  <label class="sticker-search">
                    <span class="sr-only">搜索表情包</span>
                    <input
                      value={query.value}
                      placeholder="搜索名称、Provider 或 Pack ID"
                      onInput={(event) => { query.value = (event.target as HTMLInputElement).value }}
                    />
                  </label>
                </div>
                {visiblePacks.value.length
                  ? <div class="sticker-pack-grid">
                    {visiblePacks.value.map(pack => {
                      const assignment = pack.assignments.find(item =>
                        item.platformSessionId === account?.platformSessionId)
                      const key = account
                        ? `${account.platformSessionId}\0${pack.providerId}\0${pack.packId}`
                        : ''
                      const source = accounts.find(item =>
                        item.platformSessionId === pack.sourcePlatformSessionId)
                      return <article class={['sticker-pack-card', { assigned: assignment?.assigned }]}
                        data-provider={pack.providerId} data-pack={pack.packId}>
                        <div class="pack-symbol" aria-hidden="true">{pack.title.trim()[0] ?? '☺'}</div>
                        <div class="pack-details">
                          <h3>{pack.title}</h3>
                          <p>{pack.count == null ? '数量未知' : `${pack.count} 个表情`}</p>
                          <code>{pack.providerId} / {pack.packId}</code>
                          {source && <span class="pack-source">来源：{source.displayName}</span>}
                        </div>
                        <button
                          type="button"
                          class={['assignment-button', {
                            automatic: assignment?.automatic,
                            assigned: assignment?.assigned,
                          }]}
                          disabled={!account || assignment?.automatic || pending.value === key}
                          onClick={() => toggle(pack)}
                        >
                          {pending.value === key
                            ? '处理中'
                            : assignment?.automatic
                              ? '自动关联'
                              : assignment?.assigned ? '已添加' : '添加'}
                        </button>
                      </article>
                    })}
                  </div>
                  : <div class="sticker-empty">没有匹配的表情包集合。</div>}
              </section>
            </>
            : <div class="accounts-empty">
              <Icon name="account:default" />
              <h2>还没有可管理的账号</h2>
              <p>Bridge 获取到平台账号后，才能为它分配表情包。</p>
            </div>}
        </main>,
      }}</Layout>
    }
  },
})

export const BotsPage = defineComponent({
  name: 'BotsPage',
  setup() {
    const data = useRpc<BotDashboardData>()
    const refreshing = ref(false)
    const copied = ref<string>()
    const error = ref<string>()
    let copiedTimer: ReturnType<typeof setTimeout> | undefined
    onBeforeUnmount(() => {
      if (copiedTimer) clearTimeout(copiedTimer)
    })
    const refresh = async () => {
      refreshing.value = true
      error.value = undefined
      try {
        await data.value.refreshBots()
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : String(cause)
      } finally {
        refreshing.value = false
      }
    }
    const copy = async (link: string) => {
      try {
        await copyText(link)
        copied.value = link
        if (copiedTimer) clearTimeout(copiedTimer)
        copiedTimer = setTimeout(() => { copied.value = undefined }, 1_500)
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : '复制链接失败。'
      }
    }

    return () => {
      const Layout = resolveComponent('k-layout') as any
      const Icon = resolveComponent('k-icon') as any
      const bots = data.value.bots
      return <Layout class="bots-page">{{
        header: () => <div class="accounts-toolbar bots-toolbar">
          <div>
            <h1>Bot 管理</h1>
            <p>所有 Bridge 内置和已创建的 Bot 均可通过 t.me 链接打开。</p>
          </div>
          <button type="button" class="refresh-button" disabled={refreshing.value} onClick={refresh}>
            <Icon name="refresh" />
            <span>{refreshing.value ? '正在刷新' : '刷新 Bot'}</span>
          </button>
        </div>,
        default: () => <main class="bots-content">
          {error.value && <div class="dashboard-error" role="alert">操作失败：{error.value}</div>}
          {bots.length
            ? <section class="bot-list" aria-label="已注册 Bot">
              {bots.map((bot) => {
                const link = `https://t.me/${bot.username}`
                return <article class="bot-card" data-username={bot.username}>
                  <div class="bot-avatar" aria-hidden="true">{bot.title.trim()[0] ?? 'B'}</div>
                  <div class="bot-details">
                    <h2>{bot.title}</h2>
                    <code>@{bot.username}</code>
                    <span>来源：{bot.sourcePlugin}</span>
                  </div>
                  <div class="bot-link-actions">
                    <a href={link} target="_blank" rel="noreferrer">打开</a>
                    <button type="button" class="copy-button" onClick={() => copy(link)}>
                      {copied.value === link ? '已复制' : '复制链接'}
                    </button>
                  </div>
                </article>
              })}
            </section>
            : <div class="accounts-empty">
              <Icon name="account:default" />
              <h2>还没有已启用的 Bot</h2>
              <p>启用平台管理、Bot API 或其他 Bot 插件后，它们会自动显示在这里。</p>
            </div>}
        </main>,
      }}</Layout>
    }
  },
})

export function parseTelegramLoginUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    const token = url.searchParams.get('token')
    if (
      url.protocol !== 'tg:'
      || url.hostname !== 'login'
      || (url.pathname && url.pathname !== '/')
      || !token
      || !/^[A-Za-z0-9_-]+={0,2}$/.test(token)
    ) return
    const decoded = atob(token.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(token.length / 4) * 4, '='))
    const paddedCanonical = btoa(decoded).replace(/\+/g, '-').replace(/\//g, '_')
    const canonical = paddedCanonical.replace(/=+$/, '')
    return decoded.length === 32 && (token === canonical || token === paddedCanonical) ? value : undefined
  } catch {
    return
  }
}

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
  try {
    input.select()
    if (!document.execCommand('copy')) throw new Error('Clipboard write failed')
  } finally {
    input.remove()
  }
}

export default function apply(ctx: Context): void {
  ctx.client.router.page({
    path: '/platform-accounts',
    name: '平台账号',
    icon: 'activity:default',
    order: 110,
    component: PlatformAccountsPage,
  })
  ctx.client.router.page({
    path: '/sticker-packs',
    name: '表情包管理',
    icon: 'activity:default',
    order: 111,
    component: StickerPacksPage,
  })
  ctx.client.router.page({
    path: '/bots',
    name: 'Bot 管理',
    icon: 'activity:default',
    order: 112,
    component: BotsPage,
  })
}

function formatPhone(phone?: string): string {
  if (!phone) return '—'
  const digits = phone.replace(/\D/g, '')
  if (digits.startsWith('888')) {
    const qq = digits.slice(3)
    const prefix = qq.slice(0, -4).match(/\d{1,3}(?=(?:\d{3})*$)/g)?.join(' ')
    return `+888${prefix ? ` ${prefix}` : ''} ${qq.slice(-4)}`
  }
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
