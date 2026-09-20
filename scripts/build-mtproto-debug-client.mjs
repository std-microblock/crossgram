import { fileURLToPath } from 'node:url'
import { build } from '@cordisjs/client/lib'

await build(fileURLToPath(new URL('../packages/mtproto-debug', import.meta.url)).replaceAll('\\', '/'))
