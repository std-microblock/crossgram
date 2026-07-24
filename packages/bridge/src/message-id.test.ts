import { describe, expect, it } from 'vitest'
import {
  initialTimestampMessageIdEpoch, TIMESTAMP_MESSAGE_ID_INITIAL_SECOND,
  TIMESTAMP_MESSAGE_ID_MAX_SECOND, TIMESTAMP_MESSAGE_ID_SLOTS, timestampMessageIdBucket,
  qqMessageSequenceFromMetadata, qqReplySequenceFromMetadata,
} from './message-id.js'

describe('timestamp Telegram message ID encoding', () => {
  it('reserves sixteen IDs for every second', () => {
    const epoch = 1_700_000_000
    const first = timestampMessageIdBucket(epoch, epoch + 1)
    expect(first).toBe(16)
    expect(Array.from({ length: TIMESTAMP_MESSAGE_ID_SLOTS }, (_, slot) => first + slot))
      .toEqual(Array.from({ length: 16 }, (_, slot) => 16 + slot))
  })

  it('centers the first message and covers more than four years', () => {
    const timestamp = 1_800_000_000
    const epoch = initialTimestampMessageIdEpoch(timestamp)
    expect(timestampMessageIdBucket(epoch, timestamp)).toBe(0x40000000)
    expect(timestamp - epoch).toBe(TIMESTAMP_MESSAGE_ID_INITIAL_SECOND)
    expect(TIMESTAMP_MESSAGE_ID_MAX_SECOND).toBeGreaterThan(4 * 365 * 24 * 60 * 60)
  })

  it('parses decimal QQ sequences and rejects lossy or invalid values', () => {
    expect(qqMessageSequenceFromMetadata({ qqMsgSeq: '5850634' })).toBe(5_850_634)
    expect(qqMessageSequenceFromMetadata({ qqMsgSeq: 5_850_634 })).toBe(5_850_634)
    expect(qqMessageSequenceFromMetadata({ qqMsgSeq: '005850634' })).toBeUndefined()
    expect(qqMessageSequenceFromMetadata({ qqMsgSeq: 'opaque' })).toBeUndefined()
    expect(qqReplySequenceFromMetadata({ qqMsgSeq: '2', qqReplyToMsgSeq: '1' })).toBe(1)
    expect(qqReplySequenceFromMetadata({ qqMsgSeq: '2', telegramReplyToMessageId: 1 })).toBe(1)
  })

  it('rejects timestamps outside the persisted scope window', () => {
    const epoch = 1_700_000_000
    expect(() => timestampMessageIdBucket(epoch, epoch)).toThrow('time window')
    expect(() => timestampMessageIdBucket(epoch, epoch - 1)).toThrow('time window')
    expect(() => timestampMessageIdBucket(epoch, epoch + TIMESTAMP_MESSAGE_ID_MAX_SECOND + 1))
      .toThrow('time window')
  })
})
