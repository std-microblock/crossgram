import { describe, expect, it } from 'vitest'
import { CaptureQueryError, parseCaptureQuery, queryCapture } from './capture-api.js'
import type { CapturedMtprotoEvent, MtprotoDebugData } from './types.js'

const events: CapturedMtprotoEvent[] = [
  {
    id: 1, timestamp: 1_000, direction: 'client->server', phase: 'handshake',
    connectionId: 'conn-a', name: 'req_pq_multi', payload: { _: 'req_pq_multi' }, searchText: 'req_pq_multi conn-a',
  },
  {
    id: 2, timestamp: 2_000, direction: 'client->server', phase: 'message',
    connectionId: 'conn-a', name: 'messages.sendMessage', messageId: '0x20', authKeyId: 'auth-a',
    sessionId: '0x50', payload: { _: 'messages.sendMessage', peer: { channelId: 42 }, message: 'Hello World' },
    searchText: 'messages.sendmessage hello world auth-a',
  },
  {
    id: 3, timestamp: 3_000, direction: 'server->client', phase: 'message',
    connectionId: 'conn-a', name: 'rpc_result -> updates', messageId: '0x30', requestMessageId: '0x20',
    authKeyId: 'auth-a', sessionId: '0x50', payload: { _: 'rpc_result', result: { _: 'updates' } },
    searchText: 'rpc_result updates auth-a',
  },
  {
    id: 4, timestamp: 4_000, direction: 'server->client', phase: 'connection',
    connectionId: 'conn-b', name: 'connection_closed', error: 'socket reset',
    payload: { _: 'connection_closed' }, searchText: 'connection_closed socket reset conn-b',
  },
]

const data: Pick<MtprotoDebugData, 'capturing' | 'dropped' | 'maxEvents' | 'events'> = {
  capturing: true, dropped: 7, maxEvents: 2_000, events,
}

describe('MTProto capture API query', () => {
  it('parses time, cursor, enum, identifier, text, and repeated payload field filters', () => {
    const query = new URLSearchParams([
      ['limit', '25'], ['since', '30m'], ['until', '1970-01-01T01:00:00Z'],
      ['afterId', '10'], ['beforeId', '100'], ['id', '42'], ['name', 'sendMessage'],
      ['direction', 'client->server'], ['phase', 'message'], ['connectionId', 'conn-a'],
      ['messageId', '0x20'], ['requestMessageId', '0x10'], ['authKeyId', 'auth-a'],
      ['sessionId', '0x50'], ['grep', 'hello'], ['field', 'payload.peer.channelId=42'],
      ['field', 'payload.message=Hello World'],
    ])
    expect(parseCaptureQuery(query, 2_000_000)).toEqual({
      limit: 25, since: 200_000, until: 3_600_000, afterId: 10, beforeId: 100, id: 42,
      name: 'sendMessage', direction: 'client->server', phase: 'message', connectionId: 'conn-a',
      messageId: '0x20', requestMessageId: '0x10', authKeyId: 'auth-a', sessionId: '0x50', grep: 'hello',
      fields: [
        { path: 'payload.peer.channelId', value: '42' },
        { path: 'payload.message', value: 'Hello World' },
      ],
    })
  })

  it.each([
    ['limit=0', 'Invalid limit'],
    ['limit=10001', 'Invalid limit'],
    ['direction=sideways', 'Invalid direction'],
    ['phase=crypto', 'Invalid phase'],
    ['since=recently', 'Invalid since'],
    ['field=payload..id=1', 'Invalid field filter'],
  ])('rejects malformed query %s', (source, message) => {
    expect(() => parseCaptureQuery(new URLSearchParams(source))).toThrow(new RegExp(message))
  })

  it('filters decoded capture details and reports totals before applying the tail limit', () => {
    expect(queryCapture(data, {
      since: 1_500, until: 3_500, direction: 'client->server', phase: 'message',
      connectionId: 'conn-a', name: 'SENDMESSAGE', messageId: '0x20', authKeyId: 'auth-a',
      sessionId: '0x50', grep: 'HELLO', fields: [{ path: 'payload.peer.channelId', value: '42' }],
    })).toEqual({ capturing: true, dropped: 7, maxEvents: 2_000, total: 4, matched: 1, events: [events[1]] })

    const limited = queryCapture(data, { phase: 'message', limit: 1 })
    expect(limited.matched).toBe(2)
    expect(limited.events.map(event => event.id)).toEqual([3])
  })

  it('supports exact event and RPC-result correlation cursors', () => {
    expect(queryCapture(data, { afterId: 1, beforeId: 4 }).events.map(event => event.id)).toEqual([2, 3])
    expect(queryCapture(data, { id: 3, requestMessageId: '0x20' }).events).toEqual([events[2]])
    expect(queryCapture(data, { connectionId: 'conn-b', grep: 'RESET' }).events).toEqual([events[3]])
  })
})
