// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapturedMtprotoEvent, MtprotoDebugData } from '../src/types.js'

const rpcState = vi.hoisted(() => ({ data: undefined as unknown }))

vi.mock('@cordisjs/client', async () => {
  const { ref } = await import('vue')
  return { useRpc: () => ref(rpcState.data) }
})

import { DebugPage, EventRow } from './index.js'

describe('MTProto debug client', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        if ((this as HTMLElement).classList.contains('debug-virtual-viewport')) return 600
        if ((this as HTMLElement).classList.contains('debug-virtual-row')) return 44
        return 0
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        return 1_200
      },
    })
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })

  beforeEach(() => {
    rpcState.data = debugData([])
  })

  it('keeps metadata in one row and expands only the paired payloads', async () => {
    const call = event(1, {
      messageId: '0x100', seqNo: 7, authKeyId: 'deadbeef', sessionId: '0x200',
      payload: { _: 'messages.getHistory', peer: { _: 'inputPeerSelf' } },
    })
    const result = event(2, {
      direction: 'server->client', name: 'rpc_result -> messages.messages',
      requestMessageId: '0x100', payload: { _: 'rpc_result', result: { _: 'messages.messages' } },
    })
    const Harness = defineComponent({
      setup() {
        const expanded = ref(false)
        return () => h(EventRow, {
          event: call,
          result,
          expanded: expanded.value,
          onToggle: () => { expanded.value = !expanded.value },
        })
      },
    })
    const wrapper = mount(Harness)
    const header = wrapper.get('.event-header')

    expect(wrapper.find('.event-meta').exists()).toBe(false)
    expect(header.get('.event-time').exists()).toBe(true)
    expect(header.get('.direction-label').text()).toBe('C -> S')
    expect(header.get('.event-connection').text()).toBe('conn-1')
    expect(header.get('.event-message').text()).toBe('0x100')
    expect(header.get('.event-seq').text()).toBe('seq:7')
    expect(header.get('.event-auth').text()).toBe('key:deadbeef')
    expect(header.get('.event-session').text()).toBe('sid:0x200')
    expect(header.get('.rpc-result-summary').text()).toContain('messages.messages')
    expect(wrapper.find('.event-detail').exists()).toBe(false)

    await header.trigger('click')

    expect(wrapper.get('.event-detail').text()).toContain('messages.getHistory')
    expect(wrapper.get('.rpc-result-detail').text()).toContain('rpc_result')
    expect(wrapper.get('.rpc-result-detail').classes()).toContain('rpc-result-detail')
  })

  it('virtualizes a large stream and keeps a correlated result at the call row', async () => {
    const events = Array.from({ length: 1_000 }, (_, index) => event(index + 1, {
      messageId: `0x${(index + 1).toString(16)}`,
      name: index === 0 ? 'messages.getHistory' : `test.call${index}`,
    }))
    events.push(event(1_001, {
      direction: 'server->client', name: 'rpc_result -> messages.channelMessages',
      requestMessageId: '0x1', searchText: 'rpc_result messages.channelmessages server->client',
    }))
    rpcState.data = debugData(events)

    const wrapper = mount(DebugPage, {
      global: {
        stubs: {
          'k-layout': layoutStub,
          'k-icon': iconStub,
        },
      },
    })
    await nextTick()
    await nextTick()

    const renderedRows = wrapper.findAll('.debug-event')
    expect(wrapper.get('.debug-virtual-viewport').exists()).toBe(true)
    expect(renderedRows.length).toBeGreaterThan(0)
    expect(renderedRows.length).toBeLessThan(100)
    expect(wrapper.findAll('.rpc-result-summary')).toHaveLength(1)
    expect(wrapper.findAll('.event-name').map(node => node.text())).not.toContain('rpc_result -> messages.channelMessages')

    await wrapper.get('.event-header').trigger('click')
    await nextTick()

    expect(wrapper.get('.event-detail').exists()).toBe(true)
    expect(wrapper.findAll('.debug-event').length).toBeLessThan(100)
  })
})

const layoutStub = defineComponent({
  setup(_, { slots }) {
    return () => h('div', [h('header', slots.header?.()), h('section', slots.default?.())])
  },
})

const iconStub = defineComponent({
  setup() {
    return () => h('i', { class: 'k-icon' })
  },
})

function debugData(events: CapturedMtprotoEvent[]): MtprotoDebugData {
  return {
    events,
    dropped: 0,
    capturing: true,
    start: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  }
}

function event(id: number, overrides: Partial<CapturedMtprotoEvent> = {}): CapturedMtprotoEvent {
  const name = overrides.name ?? 'messages.getHistory'
  return {
    id,
    timestamp: 1_900_000_000_000 + id,
    direction: 'client->server',
    phase: 'message',
    connectionId: 'conn-1',
    name,
    payload: { _: name },
    searchText: `${name} client->server conn-1`.toLowerCase(),
    ...overrides,
  }
}
