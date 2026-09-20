import { Bytes } from '@fuman/io'

/** Reuse ordinary packet buffers, but do not retain an unusually large burst forever. */
export const MAX_RETAINED_RECEIVE_BYTES = 1024 * 1024

export function reclaimReceiveBuffer(buffer: Bytes, initialCapacity: number): Bytes {
  if (buffer.available === 0) {
    // Bytes.reclaim() resets cursors but does not shrink an empty buffer.
    if (buffer.capacity > MAX_RETAINED_RECEIVE_BYTES) return Bytes.alloc(initialCapacity)
    buffer.reset()
  } else {
    buffer.reclaim()
  }
  return buffer
}
