import type { Plugin } from 'vite'
/** Vite's module manifest omits worker-only assets. Publish an exact additional allowlist. */
export function publicAssets(): Plugin {
  return {
    name: 'solid-webui-public-assets', enforce: 'post',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter(file => file.startsWith('assets/') && !file.endsWith('.map')).sort()
      this.emitFile({ type: 'asset', fileName: 'public-assets.json', source: JSON.stringify(files) })
    },
  }
}
