import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ComponentType,
} from 'react'
import type { Channel, Connection } from './channel.js'

export const ConnectionContext = createContext<Connection | null>(null)
export function useConnection(): Connection {
  const connection = useContext(ConnectionContext)
  if (!connection)
    throw new Error('WebUI components must be mounted inside ConnectionContext')
  return connection
}
/** Subscribe to the connection store (status, entries, error, update prompt). */
export function useConnectionState() {
  const connection = useConnection()
  return useSyncExternalStore(
    connection.subscribe,
    connection.getSnapshot,
    connection.getSnapshot,
  )
}
const EMPTY = Object.freeze({ value: {}, ready: false }) as {
  readonly value: any
  readonly ready: boolean
}
/**
 * Subscribe to one entry channel. The subscription itself acquires the channel,
 * so unmounting releases it and the server stops streaming deltas.
 */
export function useChannel<T>(id: string): { value: T; ready: boolean } {
  const connection = useConnection()
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const subscription = connection.acquire<T>(id)
      const unsubscribe = subscription.channel.subscribe(onStoreChange)
      return () => {
        unsubscribe()
        subscription.release()
      }
    },
    [connection, id],
  )
  const getSnapshot = useCallback(
    () => (connection.peek(id) ?? EMPTY) as { value: T; ready: boolean },
    [connection, id],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
export function useRpc<T extends object>(
  id: string,
): { readonly data: T; readonly ready: boolean } {
  const connection = useConnection()
  const state = useChannel<T>(id)
  const methods = useRef(
    new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  )
  const data = useRef<T>(undefined as unknown as T)
  if (!data.current) {
    data.current = new Proxy({} as T, {
      get(_target, key) {
        if (typeof key === 'string') {
          if (connection.state.entries[id]?.methods.includes(key)) {
            const cache = methods.current
            if (!cache.has(key))
              cache.set(key, (...args) => connection.rpc(id, key, args))
            return cache.get(key)
          }
          return (connection.peek(id)?.value as any)?.[key]
        }
        return undefined
      },
      has: (_target, key) =>
        typeof key === 'string' &&
        (connection.state.entries[id]?.methods.includes(key) ||
          key in ((connection.peek(id)?.value as any) ?? {})),
      ownKeys: () => Reflect.ownKeys((connection.peek(id)?.value as any) ?? {}),
      getOwnPropertyDescriptor: () => ({
        enumerable: true,
        configurable: true,
      }),
    })
  }
  return { data: data.current, ready: state.ready }
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
  component: ComponentType<PageProps>
}
export interface ClientModule {
  pages: PageDefinition[]
}
const navigationGuards = new Set<() => boolean>()
export function guardNavigation(guard: () => boolean) {
  navigationGuards.add(guard)
  return () => {
    navigationGuards.delete(guard)
  }
}
/** Register a navigation guard for the lifetime of the calling component. */
export function useNavigationGuard(guard: () => boolean) {
  const current = useRef(guard)
  current.current = guard
  useEffect(() => {
    const fn = () => current.current()
    return guardNavigation(fn)
  }, [])
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
/** Re-exported so pages can name the channel type without importing internals. */
export type { Channel, Connection }
