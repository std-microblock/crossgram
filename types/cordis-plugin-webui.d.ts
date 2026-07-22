import '@cordisjs/plugin-webui'

declare module '@cordisjs/plugin-webui' {
  interface RpcResponse {
    sn: number
    ok: boolean
    value?: unknown
    message?: string
  }
}
