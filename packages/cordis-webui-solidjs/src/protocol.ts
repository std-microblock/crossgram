import type { Delta, DeltaState } from '@cordisjs/muon'

export interface PageMeta {
  path: string
  title: string
  icon: string
  group?: string
}
export interface EntryFiles {
  pages?: PageMeta[]
  baseUrl: string
  source?: string
  manifest?: string
  modulePath?: string
  /** A Solid client module ID, or a manifest-backed module for third-party extensions. */
  client?: string
  routes?: string[]
}
export interface EntryMeta {
  pages?: PageMeta[]
  module: string
  files: string[]
  routes: string[]
  entryId?: string
  methods: string[]
}
export interface Snapshot {
  id: string
  data: unknown
  cursor: ReturnType<DeltaState['snapshot']>
}
export interface EntryDelta extends Delta {
  id: string
}
export interface RpcRequest {
  sn: number
  entryId: string
  method: string
  args: unknown[]
}
export type RpcResponse =
  | { sn: number; ok: true; value: unknown }
  | { sn: number; ok: false; message: string }
export const PROTOCOL_VERSION = 'solid-1'
export const MAX_SOCKET_BUFFER = 8 * 1024 * 1024
export const MAX_REQUEST_BYTES = 1024 * 1024
export const MAX_PENDING_RPC = 64
