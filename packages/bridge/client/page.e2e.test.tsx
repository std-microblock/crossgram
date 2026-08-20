// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlatformAccountDashboardData } from '../src/account-dashboard.js'
import type { StickerPackDashboardData } from '../src/sticker-dashboard.js'
import type { BotDashboardData } from '../src/bot-dashboard.js'

type DashboardData = PlatformAccountDashboardData & StickerPackDashboardData & BotDashboardData

const rpcState = vi.hoisted(() => ({ data: undefined as unknown as DashboardData }))
const qrState = vi.hoisted(() => ({ result: null as { data: string } | null }))

vi.mock('@cordisjs/client', async () => {
  const { ref } = await import('vue')
  return { useRpc: () => ref(rpcState.data) }
})
vi.mock('jsqr', () => ({ default: vi.fn(() => qrState.result) }))

import jsQR from 'jsqr'
import { BotsPage, PlatformAccountsPage, StickerPacksPage } from './page.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Bridge sticker pack management page', () => {
  beforeEach(() => {
    rpcState.data = dashboardData()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  })

  it('assigns any catalog pack to the selected account and keeps native favorites locked', async () => {
    const wrapper = mountPage()
    const cards = wrapper.findAll('.sticker-pack-card')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.text()).toContain('QQ 收藏表情')
    expect(cards[0]!.get('.assignment-button').text()).toBe('自动关联')
    expect(cards[0]!.get('.assignment-button').attributes('disabled')).toBeDefined()
    expect(cards[1]!.get('.assignment-button').text()).toBe('添加')

    await cards[1]!.get('.assignment-button').trigger('click')
    expect(rpcState.data.setStickerPackAssigned).toHaveBeenCalledWith(
      'qq-session', 'qq/primary:stickers', 'market-1', true,
    )

    await wrapper.findAll('.account-tab')[1]!.trigger('click')
    expect(wrapper.findAll('.account-tab')[1]!.classes()).toContain('active')
    expect(wrapper.findAll('.sticker-pack-card')[0]!.get('.assignment-button').text()).toBe('添加')
    expect(wrapper.findAll('.sticker-pack-card')[1]!.get('.assignment-button').text()).toBe('已添加')
  })

  it('filters the catalog without changing account assignments and refreshes on demand', async () => {
    const wrapper = mountPage()
    await wrapper.get('.sticker-search input').setValue('market-1')
    expect(wrapper.findAll('.sticker-pack-card')).toHaveLength(1)
    expect(wrapper.get('.sticker-pack-card').text()).toContain('QQ 商店包')

    await wrapper.get('.refresh-button').trigger('click')
    await nextTick()
    expect(rpcState.data.refreshStickerPacks).toHaveBeenCalledTimes(1)
  })
})

describe('Bridge platform account page', () => {
  beforeEach(() => {
    rpcState.data = dashboardData()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  })

  it('shows one server configuration panel for multiple accounts', () => {
    rpcState.data.accounts = [
      { platformId: 'qq/primary', platformKind: 'qq', status: 'ready' },
      { platformId: 'static/demo', platformKind: 'static', status: 'unsupported' },
    ]
    const wrapper = mountPlatformAccountsPage()

    expect(wrapper.findAll('.server-config-panel')).toHaveLength(1)
    expect(wrapper.findAll('.platform-account-card')).toHaveLength(2)
    expect(wrapper.get('.server-config-code').text()).toBe(
      JSON.stringify(rpcState.data.serverConfig, null, 2),
    )
    wrapper.unmount()
  })

  it.each([
    ['+8881234567890', '+888 123 456 7890'],
    ['+88812345678901', '+888 1 234 567 8901'],
  ])('formats %s by QQ groups while copying the dashboard value', async (virtualPhone, formattedPhone) => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    rpcState.data.accounts = [{
      platformId: 'qq/primary', platformKind: 'qq', status: 'ready', displayName: 'QQ Alice',
      virtualPhone, loginCode: '123456', validUntil: Date.now() + 30_000,
    }]
    const wrapper = mountPlatformAccountsPage()

    expect(wrapper.get('.phone-number').text()).toBe(formattedPhone)
    await wrapper.get('[aria-label="复制虚拟手机号"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(virtualPhone)
    wrapper.unmount()
  })

  it('shows the server configuration panel with no platform accounts', () => {
    const wrapper = mountPlatformAccountsPage()

    expect(wrapper.findAll('.server-config-panel')).toHaveLength(1)
    expect(wrapper.find('.accounts-empty').exists()).toBe(true)
    wrapper.unmount()
  })

  it('copies the server configuration and resets the copied state', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const wrapper = mountPlatformAccountsPage()
    const button = wrapper.get('[aria-label="复制服务器连接配置"]')

    await button.trigger('click')
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(rpcState.data.serverConfig, null, 2))
    expect(button.text()).toBe('已复制')
    expect(wrapper.get('[aria-live="polite"]').text()).toContain('服务器连接配置已复制')

    await vi.advanceTimersByTimeAsync(1_500)
    expect(button.text()).toBe('复制')
    wrapper.unmount()
  })

  it('does not show copied state when copying the server configuration fails', async () => {
    const writeText = vi.fn(async () => { throw new Error('clipboard unavailable') })
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const wrapper = mountPlatformAccountsPage()

    await wrapper.get('[aria-label="复制服务器连接配置"]').trigger('click')
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[aria-label="复制服务器连接配置"]').text()).toBe('复制')
    wrapper.unmount()
  })

  it('does not show copied state when the fallback copy command fails', async () => {
    vi.stubGlobal('navigator', {})
    const execCommand = vi.fn(() => false)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    const wrapper = mountPlatformAccountsPage()

    await wrapper.get('[aria-label="复制服务器连接配置"]').trigger('click')
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(wrapper.get('[aria-label="复制服务器连接配置"]').text()).toBe('复制')
    wrapper.unmount()
    delete (document as { execCommand?: unknown }).execCommand
  })

  it('does not intercept a plain-text-only paste event', () => {
    const wrapper = mountPlatformAccountsPage()
    const event = new Event('paste', { cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', { value: { items: [{ type: 'text/plain' }] } })

    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    expect(jsQR).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('approves a pasted Telegram login QR without keyboard modifiers', async () => {
    rpcState.data.accounts = [{ platformId: 'static', platformKind: 'static', status: 'ready' }]
    qrState.result = { data: telegramQr() }
    const wrapper = mountPlatformAccountsPage()
    stubImageDecoder()

    pasteImage()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/login-tokens/static/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: telegramQr() }),
    }))
    expect(wrapper.text()).toContain('已批准 Telegram 二维码登录')
    wrapper.unmount()
  })

  it('accepts a Meta+V image paste for Telegram login approval', async () => {
    rpcState.data.accounts = [{ platformId: 'static', platformKind: 'static', status: 'ready' }]
    qrState.result = { data: telegramQr() }
    const wrapper = mountPlatformAccountsPage()
    stubImageDecoder()

    pasteImage({ metaKey: true })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    wrapper.unmount()
  })

  it('prompts for the target account when a pasted Telegram login QR has multiple ready accounts', async () => {
    rpcState.data.accounts = [
      { platformId: 'qq/primary', platformKind: 'qq', status: 'ready', displayName: 'QQ Alice' },
      { platformId: 'static/demo', platformKind: 'static', status: 'ready', displayName: 'Static Demo' },
    ]
    qrState.result = { data: telegramQr() }
    const prompt = vi.fn(() => '2')
    vi.stubGlobal('prompt', prompt)
    const wrapper = mountPlatformAccountsPage()
    stubImageDecoder()

    pasteImage()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/login-tokens/static%2Fdemo/approve', expect.objectContaining({
      body: JSON.stringify({ token: telegramQr() }),
    })))
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('QQ Alice'), '1')
    wrapper.unmount()
  })

  it('reports pasted images without a QR code or a Telegram login QR', async () => {
    const wrapper = mountPlatformAccountsPage()
    stubImageDecoder()

    qrState.result = null
    pasteImage()
    await vi.waitFor(() => expect(wrapper.text()).toContain('未能在粘贴的图片中识别到二维码'))
    expect(fetch).not.toHaveBeenCalled()

    qrState.result = { data: 'https://example.com/qr' }
    pasteImage()
    await vi.waitFor(() => expect(wrapper.text()).toContain('该二维码不是 Telegram 登录二维码'))
    expect(fetch).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('Bridge bot management page', () => {
  beforeEach(() => {
    rpcState.data = dashboardData()
  })

  it('shows bot source and copies the canonical t.me link', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    rpcState.data.bots = [{
      conversationId: 'bridge:platform-admin', title: 'CrossGram 管理助手', username: 'CrossGramAdminBot',
      sourcePlugin: '@mtproto-relay/platform-admin-bot',
    }]
    const wrapper = mountBotsPage()

    expect(wrapper.text()).toContain('@CrossGramAdminBot')
    expect(wrapper.text()).toContain('@mtproto-relay/platform-admin-bot')
    expect(wrapper.get('.bot-link-actions a').attributes('href')).toBe('https://t.me/CrossGramAdminBot')
    await wrapper.get('.bot-link-actions button').trigger('click')
    expect(writeText).toHaveBeenCalledWith('https://t.me/CrossGramAdminBot')
    expect(wrapper.get('.bot-link-actions button').text()).toBe('已复制')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(wrapper.get('.bot-link-actions button').text()).toBe('复制链接')
    await wrapper.get('.refresh-button').trigger('click')
    expect(rpcState.data.refreshBots).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

function mountPage() {
  const Layout = defineComponent({
    setup(_, { slots }) {
      return () => h('div', [slots.header?.(), slots.default?.()])
    },
  })
  return mount(StickerPacksPage, {
    global: {
      components: {
        'k-layout': Layout,
        'k-icon': defineComponent({ setup: () => () => h('i') }),
      },
    },
  })
}

function mountPlatformAccountsPage() {
  const Layout = defineComponent({
    setup(_, { slots }) {
      return () => h('div', [slots.header?.(), slots.default?.()])
    },
  })
  return mount(PlatformAccountsPage, {
    global: {
      components: {
        'k-layout': Layout,
        'k-icon': defineComponent({ setup: () => () => h('i') }),
      },
    },
  })
}

function mountBotsPage() {
  const Layout = defineComponent({
    setup(_, { slots }) {
      return () => h('div', [slots.header?.(), slots.default?.()])
    },
  })
  return mount(BotsPage, {
    global: {
      components: {
        'k-layout': Layout,
        'k-icon': defineComponent({ setup: () => () => h('i') }),
      },
    },
  })
}

function telegramQr(): string {
  return `tg://login?token=${Buffer.from(new Uint8Array(32).fill(7)).toString('base64url')}`
}

function pasteImage(modifiers: { ctrlKey?: boolean, metaKey?: boolean } = {}): void {
  const file = new File(['image'], 'login.png', { type: 'image/png' })
  const event = new Event('paste') as ClipboardEvent
  Object.defineProperties(event, {
    ...(modifiers.ctrlKey === undefined ? {} : { ctrlKey: { value: modifiers.ctrlKey } }),
    ...(modifiers.metaKey === undefined ? {} : { metaKey: { value: modifiers.metaKey } }),
    clipboardData: {
      value: { items: [{ type: 'image/png', getAsFile: () => file }] },
    },
  })
  window.dispatchEvent(event)
}

function stubImageDecoder(): void {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 16, height: 16, close: vi.fn() })))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray(16 * 16 * 4) }),
  } as unknown as CanvasRenderingContext2D)
}

function dashboardData(): DashboardData {
  return {
    accounts: [],
    serverConfig: {
      name: 'CrossGram',
      enable_special_config: false,
      host: '203.0.113.8',
      port: 4430,
      rsa_key: '-----BEGIN RSA PUBLIC KEY-----\nkey\n-----END RSA PUBLIC KEY-----',
      dcs: [
        { id: 1, ip: '203.0.113.8', port: 4430 },
        { id: 2, ip: '203.0.113.8', port: 4430 },
        { id: 3, ip: '203.0.113.8', port: 4430 },
        { id: 4, ip: '203.0.113.8', port: 4430 },
        { id: 5, ip: '203.0.113.8', port: 4430 },
      ],
    },
    loginTokenApprovalUrl: '/api/login-tokens',
    updatedAt: 0,
    refresh: vi.fn(async () => undefined),
    stickerUpdatedAt: 0,
    bots: [],
    botUpdatedAt: 0,
    refreshBots: vi.fn(async () => undefined),
    refreshStickerPacks: vi.fn(async () => undefined),
    setStickerPackAssigned: vi.fn(async () => undefined),
    stickerAccounts: [
      {
        platformId: 'qq/primary', platformSessionId: 'qq-session', platformKind: 'qq',
        displayName: 'QQ Alice', userId: '10001',
      },
      {
        platformId: 'static/demo', platformSessionId: 'static-session', platformKind: 'static',
        displayName: 'Static Demo', userId: 'demo',
      },
    ],
    stickerPacks: [
      {
        providerId: 'qq/primary:stickers', packId: 'qq-favorites', title: 'QQ 收藏表情', count: 5,
        sourcePlatformId: 'qq/primary', sourcePlatformSessionId: 'qq-session',
        assignments: [
          { platformSessionId: 'qq-session', assigned: true, automatic: true },
          { platformSessionId: 'static-session', assigned: false, automatic: false },
        ],
      },
      {
        providerId: 'qq/primary:stickers', packId: 'market-1', title: 'QQ 商店包', count: 24,
        sourcePlatformId: 'qq/primary', sourcePlatformSessionId: 'qq-session',
        assignments: [
          { platformSessionId: 'qq-session', assigned: false, automatic: false },
          { platformSessionId: 'static-session', assigned: true, automatic: false },
        ],
      },
    ],
  }
}
