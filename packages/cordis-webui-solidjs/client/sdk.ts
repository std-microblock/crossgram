import { createContext, useContext, onCleanup, type Component } from 'solid-js'
import type { Connection } from './channel.js'

export const ConnectionContext = createContext<Connection>()
export function useConnection(): Connection {
  const connection = useContext(ConnectionContext)
  if (!connection)
    throw new Error('WebUI components must be mounted inside ConnectionContext')
  return connection
}
export function useChannel<T>(id: string) {
  const subscription = useConnection().acquire<T>(id)
  onCleanup(subscription.release)
  return subscription.channel.state
}
export function useRpc<T extends object>(
  id: string,
): { readonly data: T; readonly ready: boolean } {
  const connection = useConnection()
  const state = useChannel<T>(id)
  const methods = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const data = new Proxy({} as T, {
    get(_target, key) {
      if (
        typeof key === 'string' &&
        connection.state.entries[id]?.methods.includes(key)
      ) {
        if (!methods.has(key))
          methods.set(key, (...args) => connection.rpc(id, key, args))
        return methods.get(key)
      }
      return state.value?.[key as keyof T]
    },
    ownKeys: () => Reflect.ownKeys(state.value ?? {}),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  })
  return {
    data,
    get ready() {
      return state.ready
    },
  }
}
export interface PageProps {
  entryId: string
  path: string
}
export interface PageDefinition {
  path: string
  title: string
  icon: string
  group?: string
  component: Component<PageProps>
}
export interface ClientModule {
  pages: PageDefinition[]
}
const navigationGuards = new Set<() => boolean>()
export function guardNavigation(guard: () => boolean) {
  navigationGuards.add(guard)
  onCleanup(() => navigationGuards.delete(guard))
}
export function approveNavigation() {
  return ![...navigationGuards].some((guard) => !guard())
}
export function navigate(path: string) {
  if (path === location.pathname) return
  if (!approveNavigation()) return
  history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
