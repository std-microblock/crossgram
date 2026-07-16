import Long from 'long'

/**
 * Server-side MTProto message-id and seq-no generator.
 *
 * `msg_id` is a 64-bit value: `(unix_time + timeOffset) * 2^32 + subsecond`,
 * kept strictly increasing. Server-generated ids use the `≡ 1 (mod 4)` parity
 * (server convention; client content messages are `≡ 0 (mod 4)`).
 *
 * `seq_no` counts content-related messages: content → `count*2+1` (then count++),
 * non-content (acks, pongs, salts) → `count*2`.
 */
export class ServerMessageIdGenerator {
  private _timeOffset = 0
  private _lastMsgId = Long.ZERO
  private _contentCount = 0

  /** Adjust the server clock offset (seconds) — e.g. after seeing the client's msg_id. */
  updateTimeOffset(offset: number): void {
    this._timeOffset = offset
  }

  /** Track the client's latest msg_id so server ids stay ahead of it. */
  observeClientMsgId(msgId: Long): void {
    if (msgId.greaterThan(this._lastMsgId)) this._lastMsgId = msgId
  }

  getMessageId(_isContentRelated = true): Long {
    const now = Date.now() / 1000 + this._timeOffset
    const secs = Math.floor(now)
    const frac = Math.floor((now - secs) * 0x1_0000_0000)
    // server convention: msg_id ≡ 1 (mod 4)
    const low = ((frac & ~3) | 1) >>> 0
    let msgId = new Long(low, secs, false)
    if (msgId.lessThanOrEqual(this._lastMsgId)) {
      msgId = this._lastMsgId.add(4)
    }
    this._lastMsgId = msgId
    return msgId
  }

  getSeqNo(isContentRelated: boolean): number {
    if (isContentRelated) {
      const seq = this._contentCount * 2 + 1
      this._contentCount++
      return seq
    }
    return this._contentCount * 2
  }
}
