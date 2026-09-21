import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { buildClient } from 'cordis-webui-solidjs/build'
const root = new URL('../', import.meta.url)
await build({ configFile: fileURLToPath(new URL('packages/cordis-webui-solidjs/vite.config.ts', root)) })
for (const folder of await readdir(new URL('packages/', root))) {
  const directory = new URL('packages/' + folder + '/', root)
  let pkg
  try { pkg = JSON.parse(await readFile(new URL('package.json', directory), 'utf8')) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
  if (pkg.cordis?.webui?.framework !== 'solid') continue
  await buildClient({ root: fileURLToPath(directory), entry: pkg.cordis.webui.entry ?? 'client/index.ts' })
}
