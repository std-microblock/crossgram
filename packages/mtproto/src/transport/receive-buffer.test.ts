import { describe, expect, it } from 'vitest'
import { Bytes } from '@fuman/io'
import { MAX_RETAINED_RECEIVE_BYTES, reclaimReceiveBuffer } from './receive-buffer.js'

describe('receive buffer reclamation', () => {
  it('reuses ordinary drained buffers and resets both cursors', () => {
    const buffer = Bytes.alloc(16)
    buffer.writeSync(1024).fill(7)
    buffer.readSync(1024)
    expect(reclaimReceiveBuffer(buffer, 16)).toBe(buffer)
    expect(buffer.written).toBe(0)
    expect(buffer.available).toBe(0)
  })

  it('releases a large drained burst rather than retaining its high-water allocation', () => {
    const buffer = Bytes.alloc(16)
    buffer.writeSync(MAX_RETAINED_RECEIVE_BYTES + 4).fill(1)
    buffer.readSync(buffer.available)
    const compact = reclaimReceiveBuffer(buffer, 16)
    expect(compact).not.toBe(buffer)
    expect(compact.capacity).toBe(16)
    expect(compact.written).toBe(0)
  })

  it('never discards incomplete frames, including those larger than the retention limit', () => {
    const buffer = Bytes.alloc(16)
    const size = MAX_RETAINED_RECEIVE_BYTES + 128
    buffer.writeSync(size).fill(9)
    buffer.readSync(4)
    expect(reclaimReceiveBuffer(buffer, 16)).toBe(buffer)
    expect(buffer.available).toBe(size - 4)
    expect(buffer.written).toBe(size - 4)
    expect(buffer.result().every(byte => byte === 9)).toBe(true)
    buffer.readSync(size - 12)
    expect(reclaimReceiveBuffer(buffer, 16)).toBe(buffer)
    expect(buffer.capacity).toBe(16)
    expect([...buffer.result()]).toEqual(new Array(8).fill(9))
  })
})
