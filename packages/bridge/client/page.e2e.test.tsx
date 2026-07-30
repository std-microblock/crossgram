// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlatformAccountDashboardData } from '../src/account-dashboard.js'
import type { StickerPackDashboardData } from '../src/sticker-dashboard.js'

const rpcState = vi.hoisted(() => ({ data: undefined as unknown }))

vi.mock('@cordisjs/client', async () => {
  const { ref } = await import('vue')
  return { useRpc: () => ref(rpcState.data) }
})

import { StickerPacksPage } from './page.js'

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

function dashboardData(): PlatformAccountDashboardData & StickerPackDashboardData {
  return {
    accounts: [], updatedAt: 0, refresh: vi.fn(async () => undefined),
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
