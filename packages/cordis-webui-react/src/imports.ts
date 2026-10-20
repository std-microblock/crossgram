/** Stable browser import-map names shared by independently built extensions. */
export const sharedModules = {
  'cordis-webui-react/utils': 'client/utils.ts',
  'cordis-webui-react/session': 'client/session.ts',
  'cordis-webui-react/client': 'client/sdk.tsx',
  'cordis-webui-react/components': 'client/components.tsx',
  'cordis-webui-react/icons': 'client/icons.tsx',
  'cordis-webui-react/schema': 'client/schema.tsx',
  react: 'client/runtime/react.ts',
  'react/jsx-runtime': 'client/runtime/jsx-runtime.ts',
  /* A development-mode extension build asks for the dev JSX runtime; mapping it
   * keeps such a build loadable instead of bundling a second React runtime. */
  'react/jsx-dev-runtime': 'client/runtime/jsx-dev-runtime.ts',
  'react-dom': 'client/runtime/react-dom.ts',
  'react-dom/client': 'client/runtime/react-dom-client.ts',
} as const
