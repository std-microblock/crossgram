import type { tl } from '@mtcute/core'
import { randomBytes } from 'node:crypto'
import { RpcError } from '@mtproto-relay/mtproto'

const DH_CONFIG_VERSION = 1
const MAX_RANDOM_LENGTH = 1_024

// This is the standard Telegram 2048-bit safe prime. It must stay byte-for-byte
// identical to TELEGRAM_DH_PRIME_HEX in packages/voice-worker/src/crypto.rs.
const TELEGRAM_DH_PRIME = Uint8Array.from(Buffer.from([
  'C71CAEB9C6B1C9048E6C522F70F13F73980D40238E3E21C14934D037563D930F',
  '48198A0AA7C14058229493D22530F4DBFA336F6E0AC925139543AED44CCE7C372',
  '0FD51F69458705AC68CD4FE6B6B13ABDC9746512969328454F18FAF8C595F642',
  '477FE96BB2A941D5BCD1D4AC8CC49880708FA9B378E3C4F3A9060BEE67CF9A4A',
  '4A695811051907E162753B56B0F6B410DBA74D8A84B2A14B3144E0EF1284754F',
  'D17ED950D5965B4B9DD46582DB1178D169C6BC465B0D6FF9CA3928FEF5B9AE4E',
  '418FC15E83EBEA0F87FA9FF5EED70050DED2849F47BF959D956850CE929851F0D',
  '8115F635B105EE2E4E15D04B2454BF6F4FADF034B10403119CD8E3B92FCC5B',
].join(''), 'hex'))

export type DhRandomSource = (size: number) => Uint8Array

/** Supplies the DH group Telegram clients need before they can call phone.acceptCall. */
export function getDhConfig(
  request: tl.messages.RawGetDhConfigRequest,
  random: DhRandomSource = randomBytes,
): tl.messages.TypeDhConfig {
  if (!Number.isSafeInteger(request.randomLength)
    || request.randomLength < 0
    || request.randomLength > MAX_RANDOM_LENGTH) {
    throw new RpcError(400, 'RANDOM_LENGTH_INVALID')
  }

  const randomValue = random(request.randomLength)
  if (randomValue.length !== request.randomLength) {
    throw new RpcError(500, 'DH_RANDOM_FAILED')
  }

  if (request.version === DH_CONFIG_VERSION) {
    return { _: 'messages.dhConfigNotModified', random: randomValue }
  }

  return {
    _: 'messages.dhConfig',
    g: 3,
    p: TELEGRAM_DH_PRIME.slice(),
    version: DH_CONFIG_VERSION,
    random: randomValue,
  }
}
