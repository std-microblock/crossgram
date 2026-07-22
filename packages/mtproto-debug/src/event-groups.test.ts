import { describe, expect, it } from 'vitest'
import { countGroupedEvents, filterEventGroups, groupRpcEvents } from './event-groups.js'
import type { CapturedMtprotoEvent } from './types.js'

describe('MTProto RPC event grouping', () => {
  it('places an RPC result on its call and removes the standalone result row', () => {
    const call = event(1, { messageId: '0x10', name: 'messages.getHistory' })
    const update = event(2, { direction: 'server->client', name: 'updateNewMessage' })
    const result = event(3, {
      direction: 'server->client',
      name: 'rpc_result -> messages.messages',
      requestMessageId: '0x10',
    })

    const groups = groupRpcEvents([call, update, result])

    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual({ event: call, result })
    expect(groups[1]).toEqual({ event: update })
    expect(countGroupedEvents(groups)).toBe(3)
  })

  it('correlates out-of-order results but never crosses connection boundaries', () => {
    const earlyResult = event(1, {
      direction: 'server->client', name: 'rpc_result -> pong', requestMessageId: '0x20',
    })
    const otherConnectionResult = event(2, {
      connectionId: 'conn-2', direction: 'server->client',
      name: 'rpc_result -> wrong', requestMessageId: '0x20',
    })
    const call = event(3, { messageId: '0x20', name: 'ping' })

    const groups = groupRpcEvents([earlyResult, otherConnectionResult, call])

    expect(groups).toEqual([
      { event: otherConnectionResult },
      { event: call, result: earlyResult },
    ])
  })

  it('matches filter terms across both halves of a correlated RPC pair', () => {
    const groups = groupRpcEvents([
      event(1, { messageId: '0x30', name: 'messages.getHistory', searchText: 'messages.gethistory client->server' }),
      event(2, {
        direction: 'server->client', name: 'rpc_result -> channelMessages',
        requestMessageId: '0x30', searchText: 'rpc_result channelmessages server->client',
      }),
      event(3, { name: 'updates.getState', searchText: 'updates.getstate client->server' }),
    ])

    expect(filterEventGroups(groups, 'gethistory channelmessages')).toEqual([groups[0]])
    expect(filterEventGroups(groups, 'SERVER->CLIENT')).toEqual([groups[0]])
    expect(filterEventGroups(groups, 'missing')).toEqual([])
    expect(filterEventGroups(groups, '   ')).toBe(groups)
  })

  it('includes or excludes an exact call/result type selected from the context menu', () => {
    const groups = groupRpcEvents([
      event(1, { messageId: '0x40', name: 'messages.getHistory' }),
      event(2, {
        direction: 'server->client', name: 'rpc_result -> messages.messages', requestMessageId: '0x40',
      }),
      event(3, { name: 'updates.getState' }),
    ])

    expect(filterEventGroups(groups, '', { mode: 'include', value: 'messages.getHistory' })).toEqual([groups[0]])
    expect(filterEventGroups(groups, '', { mode: 'include', value: 'rpc_result -> messages.messages' })).toEqual([groups[0]])
    expect(filterEventGroups(groups, '', { mode: 'exclude', value: 'messages.getHistory' })).toEqual([groups[1]])
  })
})

function event(id: number, overrides: Partial<CapturedMtprotoEvent> = {}): CapturedMtprotoEvent {
  const name = overrides.name ?? 'test.call'
  return {
    id,
    timestamp: id,
    direction: 'client->server',
    phase: 'message',
    connectionId: 'conn-1',
    name,
    payload: { _: name },
    searchText: name.toLowerCase(),
    ...overrides,
  }
}
