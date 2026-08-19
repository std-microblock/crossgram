import type { TlReaderMap } from '@mtcute/tl-runtime'
import { parseFullTlSchema, parseTlToEntries, generateReaderCodeForTlEntries, type TlEntry } from '@mtcute/tl-utils'
import { __tlReaderMap } from '@mtcute/core/utils.js'
import apiSchemaRaw from '@mtcute/core/tl/api-schema.json' with { type: 'json' }
import mtpSchemaRaw from '@mtcute/core/tl/mtp-schema.json' with { type: 'json' }
import { getHistoricalApiLayerReaderMap } from './api-layer.js'

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
 * Telegram Android still emits these legacy/private requests while declaring
 * the current public API layer. They are present in the official Android
 * sources but absent from both mtcute's current schema and the public TDLib
 * layer history mirrored by this project.
 *
 * Keep them as an explicit server compatibility surface: constructor IDs are
 * the wire identity, while the shared method names let the normal RPC route pipeline
 * route them to the canonical handlers after decoding.
 */
const TELEGRAM_ANDROID_COMPAT_SCHEMA = `
gzip_packed#3072cfa1 packed_data:bytes = Object;

---functions---
channels.getMessages#93d7b347 channel:InputChannel id:Vector<int> = messages.Messages;
langpack.getLanguages#800fd57d = Vector<LangPackLanguage>;
account.registerDevice#637ea878 token_type:int token:string = Bool;
`

/** Crossgram client extensions. Constructor ids are a stable wire contract. */
export const CROSSGRAM_API_SCHEMA = `
---functions---
crossgram.getFileUrl#7520f6ea location:InputFileLocation = DataJSON;
crossgram.prepareMediaUpload#f75adc0e peer:InputPeer file_id:long name:string size:long kind:string mime_type:string md5:bytes sha1:bytes file10m_md5:bytes width:int height:int duration:double = Bool;
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

  // mtcute publishes schemas as generated JSON. The JSON module declaration
  // cannot express its TL entry shape, so verify it at this boundary.
  const apiSchema = parseFullTlSchema((apiSchemaRaw.e ?? apiSchemaRaw) as unknown as TlEntry[])
  const mtpSchema = parseFullTlSchema(mtpSchemaRaw as unknown as TlEntry[])

  const compatApiEntries = parseTlToEntries(`${TELEGRAM_ANDROID_COMPAT_SCHEMA}\n${CROSSGRAM_API_SCHEMA}`)
  const apiEntries = [
    ...apiSchema.entries,
    ...compatApiEntries.filter(e => !apiSchema.entries.some(x => x.id === e.id)),
  ]

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
  let code = generateReaderCodeForTlEntries(removeInternal(apiEntries), {
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
