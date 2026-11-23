/**
 * The buffer size is a per-browser setting: the capture page remembers what the
 * operator picked and re-applies it to the server on the next load. The server
 * keeps the value only for the lifetime of the plugin, so the configured
 * `maxEvents` is the fallback after a restart.
 */
export const BUFFER_SIZE_STORAGE_KEY = 'crossgram.mtproto-debug.maxEvents'
/** Same bounds as the `maxEvents` config field. */
export const MIN_BUFFER_SIZE = 100
export const MAX_BUFFER_SIZE = 20_000
export const DEFAULT_BUFFER_SIZE = 2_000

export interface BufferSizeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function browserStorage(): BufferSizeStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    // Private modes throw on access instead of returning undefined.
    return undefined
  }
}

/** Read the stored size; a corrupted or missing value counts as "never set". */
export function readStoredBufferSize(
  storage: BufferSizeStorage | undefined = browserStorage(),
): number | undefined {
  try {
    return parseBufferSize(storage?.getItem(BUFFER_SIZE_STORAGE_KEY) ?? '')
  } catch {
    return undefined
  }
}

/** Persist the chosen size; a failed write only costs the next reload. */
export function storeBufferSize(
  value: number,
  storage: BufferSizeStorage | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(BUFFER_SIZE_STORAGE_KEY, String(value))
  } catch {
    // Quota or a disabled storage: the running page still keeps the setting.
  }
}

/** Validate the input box value; the message is shown to the operator as is. */
export function parseBufferSize(raw: string | number): number {
  const trimmed = typeof raw === 'number' ? '' : raw.trim()
  const value = typeof raw === 'number' ? raw : trimmed ? Number(trimmed) : Number.NaN
  if (!Number.isSafeInteger(value))
    throw new Error('Buffer size must be a whole number')
  if (value < MIN_BUFFER_SIZE || value > MAX_BUFFER_SIZE)
    throw new Error(
      `Buffer size must be between ${MIN_BUFFER_SIZE} and ${MAX_BUFFER_SIZE}`,
    )
  return value
}
