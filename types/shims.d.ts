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
