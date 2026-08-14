// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlatformAccountDashboardData } from '../src/account-dashboard.js'
import type { StickerPackDashboardData } from '../src/sticker-dashboard.js'

type DashboardData = PlatformAccountDashboardData & StickerPackDashboardData

const rpcState = vi.hoisted(() => ({ data: undefined as unknown as DashboardData }))

vi.mock('@cordisjs/client', async () => {
  const { ref } = await import('vue')
  return { useRpc: () => ref(rpcState.data) }
})

import { PlatformAccountsPage, StickerPacksPage } from './page.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Bridge sticker pack management page', () => {
  beforeEach(() => {
    rpcState.data = dashboardData()
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
    updatedAt: 0,
    refresh: vi.fn(async () => undefined),
    stickerUpdatedAt: 0,
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
