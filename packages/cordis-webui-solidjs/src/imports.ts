/** Stable browser import-map names shared by independently built extensions. */
export const sharedModules = {
  'cordis-webui-solidjs/utils': 'client/utils.ts',
  'cordis-webui-solidjs/session': 'client/session.ts',
  'solid-js': 'client/runtime/solid.ts',
  'solid-js/store': 'client/runtime/store.ts',
  'solid-js/web': 'client/runtime/web.ts',
  'cordis-webui-solidjs/client': 'client/sdk.ts',
  'cordis-webui-solidjs/components': 'client/components.tsx',
  'cordis-webui-solidjs/schema': 'client/schema.tsx',
} as const
