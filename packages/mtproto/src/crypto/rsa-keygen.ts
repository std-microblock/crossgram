import {
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  privateDecrypt,
  generatePrimeSync,
  createHash,
  constants,
} from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ServerRsaKey {
  /** PKCS#1 PEM ("BEGIN RSA PUBLIC KEY") — this is what clients are patched with. */
  publicKeyPem: string
  /** PKCS#8 PEM private key. */
  privateKeyPem: string
  /** Telegram key fingerprint: low 64 bits of SHA1(TL bytes(n) ++ TL bytes(e)), hex. */
  fingerprint: string
  /** Modulus n, hex. */
  modulus: string
  /** Public exponent e, hex. */
  exponent: string
}

// ── bigint / byte helpers ───────────────────────────────────────────────────

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let v = 0n
  for (const b of bytes) v = (v << 8n) | BigInt(b)
  return v
}

function bigIntToBytesBE(v: bigint): Uint8Array {
  let hex = v.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bigIntToBytesN(v: bigint, n: number): Uint8Array {
  const out = new Uint8Array(n)
  let x = v
  for (let i = n - 1; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n }
  return out
}

/** TL `bytes` serialization: length prefix + data + padding to a 4-byte boundary. */
function tlBytes(data: Uint8Array): Uint8Array {
  let head: number[]
  let total: number
  if (data.length < 254) {
    head = [data.length]
    total = 1 + data.length
  } else {
    head = [254, data.length & 0xff, (data.length >> 8) & 0xff, (data.length >> 16) & 0xff]
    total = 4 + data.length
  }
  const pad = (4 - (total % 4)) % 4
  const out = new Uint8Array(head.length + data.length + pad)
  out.set(head, 0)
  out.set(data, head.length)
  return out
}

/**
 * Telegram RSA fingerprint = the low 64 bits of
 * SHA1( TL_bytes(modulus_BE) ++ TL_bytes(exponent_BE) ), formatted exactly as
 * mtcute does: `hex(reverse(sha1[-8]))` — a zero-padded 16-char hex string.
 */
function computeFingerprint(n: bigint, e: bigint): string {
  const serialized = new Uint8Array([...tlBytes(bigIntToBytesBE(n)), ...tlBytes(bigIntToBytesBE(e))])
  const sha = createHash('sha1').update(serialized).digest()
  const reversed = Uint8Array.from(sha.subarray(sha.length - 8)).reverse()
  let fp = ''
  for (const b of reversed) fp += b.toString(16).padStart(2, '0')
  return fp
}

// ── public API ──────────────────────────────────────────────────────────────

/** Generate a fresh RSA-2048 key pair with its Telegram fingerprint. */
export function generateRsaKeyPair(): ServerRsaKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  const jwk = createPublicKey(publicKey).export({ format: 'jwk' }) as { n: string, e: string }
  const n = bytesToBigIntBE(new Uint8Array(Buffer.from(jwk.n, 'base64url')))
  const e = bytesToBigIntBE(new Uint8Array(Buffer.from(jwk.e, 'base64url')))

  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    fingerprint: computeFingerprint(n, e),
    modulus: n.toString(16),
    exponent: e.toString(16),
  }
}

/** Load the key pair from `path` (JSON), or generate + persist it (and `<path>.pem`). */
export function loadOrCreateRsaKeyPair(path: string): ServerRsaKey {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf8')) as ServerRsaKey
  }
  const key = generateRsaKeyPair()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(key, null, 2))
  writeFileSync(`${path}.pem`, key.publicKeyPem)
  return key
}

/**
 * Raw RSA decryption (no padding): returns `ciphertext^d mod n` as a 256-byte
 * big-endian buffer. The MTProto DH handshake's `p_q_inner_data` is unpadded by
 * the caller (`server-authorization.ts`).
 */
export function rsaRawDecrypt(ciphertext: bigint, privateKeyPem: string): Uint8Array {
  const key = createPrivateKey(privateKeyPem)
  const input = Buffer.from(bigIntToBytesN(ciphertext, 256))
  const out = privateDecrypt({ key, padding: constants.RSA_NO_PADDING }, input)
  return new Uint8Array(out)
}

/** Generate a pq value: the product of two ~31-bit primes (pq < 2^63, factorizable). */
export function generatePq(): { pq: bigint, p: bigint, q: bigint } {
  let p = generatePrimeSync(31, { bigint: true }) as bigint
  let q = generatePrimeSync(31, { bigint: true }) as bigint
  if (p > q) [p, q] = [q, p]
  return { pq: p * q, p, q }
}
