import type { TlReaderMap } from '@mtcute/tl-runtime'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { parseFullTlSchema, parseTlToEntries, generateReaderCodeForTlEntries } from '@mtcute/tl-utils'
import { __tlReaderMap } from '@mtcute/core/utils.js'
import { getHistoricalApiLayerReaderMap } from './api-layer.js'

const require = createRequire(import.meta.url)

let _serverReaderMap: TlReaderMap | null = null

/**
 * Constructors that mtcute's *client* MTProto schema (`mtp-schema.json`) omits
 * because a client never needs to *read* them — but a server does.
 *
 * The notable one is the legacy `req_pq` (#60469778): modern mtcute clients send
 * `req_pq_multi`, but Telegram Desktop / TDLib-based clients still open the
 * handshake with `req_pq`. Definitions are canonical MTProto and stable; they go
 * through the same codegen pipeline as every other reader (no hand-written
 * reader functions), with the `mt_` prefix so names match mtcute's (`mt_req_pq`).
 */
const EXTRA_MTP_SCHEMA = `
req_pq#60469778 nonce:int128 = ResPQ;
`

/**
 * Build a TL reader map that includes RPC method requests, by merging
 * mtcute's built-in `__tlReaderMap` with method readers generated at
 * runtime via `@mtcute/tl-utils`.
 *
 * mtcute's `__tlReaderMap` deliberately excludes method requests — a client
 * only reads responses. On the server side, we need to read the client's
 * RPC requests, so we generate the missing method readers and merge them.
 *
 * The result is cached after first call.
 */
export function getServerReaderMap(): TlReaderMap {
  if (_serverReaderMap) return _serverReaderMap

  const apiSchemaRaw = JSON.parse(readFileSync(require.resolve('@mtcute/core/tl/api-schema.json'), 'utf-8'))
  const mtpSchemaRaw = JSON.parse(readFileSync(require.resolve('@mtcute/core/tl/mtp-schema.json'), 'utf-8'))

  const apiSchema = parseFullTlSchema(apiSchemaRaw.e ?? apiSchemaRaw)
  const mtpSchema = parseFullTlSchema(mtpSchemaRaw)

  // Merge mtcute's MTProto entries with the server-only constructors it omits.
  // Keep mtcute's entries authoritative (so field shapes match its generated
  // TS types), only adding definitions whose ctor id isn't already present.
  const extraMtpEntries = parseTlToEntries(EXTRA_MTP_SCHEMA, { prefix: 'mt_' })
  const mtpEntries = [
    ...mtpSchema.entries,
    ...extraMtpEntries.filter(e => !mtpSchema.entries.some(x => x.id === e.id)),
  ]

  const removeInternal = (entries: typeof apiSchema.entries) =>
    entries.filter(it => !it.name.startsWith('mtcute.') || it.name === 'mtcute.customMethod')

  // Generate reader code with methods included
  let code = generateReaderCodeForTlEntries(removeInternal(apiSchema.entries), {
    variableName: 'm',
    includeMethods: true,
    includeMethodResults: true,
  })

  // Append MTP service message readers
  const mtpCode = generateReaderCodeForTlEntries(mtpEntries, { variableName: 'm' })
  code = code.substring(0, code.length - 1) + mtpCode.substring(8)
  code += '\nreturn m;'

  // eslint-disable-next-line no-new-func
  const generated = new Function(code)() as TlReaderMap

  // Merge: start with mtcute's built-in map, then add generated method readers
  _serverReaderMap = Object.assign(
    Object.create(null),
    __tlReaderMap,
    getHistoricalApiLayerReaderMap(),
    generated,
  ) as TlReaderMap

  return _serverReaderMap
}
