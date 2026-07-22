declare module '*.vue' {
  import type { Component } from 'vue'
  const component: Component
  export default component
}

declare module '*.yml' {
  const value: Record<string, unknown>
  export default value
}

interface ImportMeta {
  hot?: {
    accept(...args: unknown[]): void
    dispose(callback: (...args: unknown[]) => void): void
  }
}
