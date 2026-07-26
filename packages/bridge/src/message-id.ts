import type { JsonObject, JsonValue } from './platform.js'

export const TELEGRAM_MESSAGE_ID_MAX = 0x7fffffff
export const TIMESTAMP_MESSAGE_ID_SLOTS = 16
export const TIMESTAMP_MESSAGE_ID_MAX_SECOND = Math.floor(
  (TELEGRAM_MESSAGE_ID_MAX - TIMESTAMP_MESSAGE_ID_SLOTS + 1) / TIMESTAMP_MESSAGE_ID_SLOTS,
)
export const TIMESTAMP_MESSAGE_ID_INITIAL_SECOND = 0x40000000 / TIMESTAMP_MESSAGE_ID_SLOTS

/** Parse QQ's per-conversation sequence without losing precision through JSON coercion. */
export function qqMessageSequenceFromMetadata(metadata?: JsonObject): number | undefined {
  return positiveSequence(metadata?.qqMsgSeq)
}

/** QQNT currently exposes replayMsgSeq through this compatibility metadata field. */
export function qqReplySequenceFromMetadata(metadata?: JsonObject): number | undefined {
  return positiveSequence(metadata?.qqReplyToMsgSeq)
    ?? (metadata?.qqMsgSeq === undefined ? undefined : positiveSequence(metadata.telegramReplyToMessageId))
}

/** Center the first observed message in the roughly 4.25-year int32 window. */
export function initialTimestampMessageIdEpoch(timestamp: number): number {
  assertTimestamp(timestamp)
  return timestamp - TIMESTAMP_MESSAGE_ID_INITIAL_SECOND
}

/** Reserve sixteen Telegram IDs for each second relative to a durable scope epoch. */
export function timestampMessageIdBucket(epoch: number, timestamp: number): number {
  assertTimestamp(epoch)
  assertTimestamp(timestamp)
  const relativeSecond = timestamp - epoch
  if (relativeSecond <= 0 || relativeSecond > TIMESTAMP_MESSAGE_ID_MAX_SECOND) {
    throw new RangeError('message timestamp is outside the Telegram message ID time window')
  }
  return relativeSecond * TIMESTAMP_MESSAGE_ID_SLOTS
}

/**
 * Return the closest representable bucket for a valid timestamp.
 *
 * A single int32 Telegram message-ID scope can only cover roughly 4.25 years.
 * Long-lived upstream conversations must remain readable after crossing either
 * edge, so callers that allocate durable IDs can probe inward from the nearest
 * boundary instead of failing the entire history/dialog request.
 */
export function clampedTimestampMessageIdBucket(epoch: number, timestamp: number): number {
  assertTimestamp(epoch)
  assertTimestamp(timestamp)
  const relativeSecond = Math.max(1, Math.min(TIMESTAMP_MESSAGE_ID_MAX_SECOND, timestamp - epoch))
  return relativeSecond * TIMESTAMP_MESSAGE_ID_SLOTS
}

export function messageIdBucketStart(messageId: number): number {
  return Math.floor(messageId / TIMESTAMP_MESSAGE_ID_SLOTS) * TIMESTAMP_MESSAGE_ID_SLOTS
}

function positiveSequence(value: JsonValue | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value)) throw new RangeError('message timestamp must be a safe integer number of seconds')
}
