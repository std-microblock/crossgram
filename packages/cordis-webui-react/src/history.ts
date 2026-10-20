/** Legacy instrumentation plugins expose rolling arrays but did not enforce their limits. */
export function boundHistory(module: string, data: any) {
  const field =
    module === 'logs'
      ? 'messages'
      : module === 'http'
        ? 'history'
        : module === 'server'
          ? 'requests'
          : undefined
  if (!field || !Array.isArray(data?.[field])) return
  const requested =
    module === 'http'
      ? data.limit
      : module === 'server'
        ? data.requestLimit
        : 1000
  const limit = Number.isFinite(requested)
    ? Math.max(0, Math.min(2000, Math.floor(requested)))
    : 1000
  if (data[field].length > limit)
    data[field].splice(0, data[field].length - limit)
}
