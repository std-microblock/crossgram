import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(process.argv[2] ?? '')
const ffmpeg = resolve(process.argv[3] ?? '')
if (!process.argv[2] || !existsSync(join(sourceRoot, 'face_config.json'))) {
  throw new Error('usage: node scripts/import-reactions.mjs <QQ emoji-resource> <ffmpeg>')
}
if (!process.argv[3] || !existsSync(ffmpeg)) throw new Error(`ffmpeg not found: ${ffmpeg}`)

const configBytes = await readFile(join(sourceRoot, 'face_config.json'))
const config = JSON.parse(configBytes)
const outputRoot = join(packageRoot, 'assets', 'reactions', 'sysface')
await mkdir(outputRoot, { recursive: true })

const entries = []
for (const item of config.sysface ?? []) {
  if (item.QHide === '1' || !/^\d+$/.test(item.QSid)) continue
  const source = join(sourceRoot, 'sysface_res', 'apng', `s${item.QSid}.png`)
  if (!existsSync(source)) continue
  const output = join(outputRoot, `s${item.QSid}.webm`)
  await run(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', source,
    '-map_metadata', '-1', '-vf', 'fps=30,scale=100:100:flags=lanczos,format=yuva420p',
    '-t', '3', '-an', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
    '-auto-alt-ref', '0', '-b:v', '0', '-crf', '32', '-threads', '1',
    '-metadata:s:v:0', 'alpha_mode=1', output,
  ])
  const bytes = await readFile(output)
  entries.push({
    id: item.QSid,
    file: basename(output),
    size: (await stat(output)).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
}

entries.sort((left, right) => Number(left.id) - Number(right.id))
await writeFile(join(packageRoot, 'assets', 'reactions', 'manifest.json'), `${JSON.stringify({
  source: 'QQNT local cloud-control emoji-resource',
  faceConfigSha256: createHash('sha256').update(configBytes).digest('hex'),
  codec: 'VP9 alpha, 100x100, 30fps, max 3s, CRF 32',
  entries,
}, null, 2)}\n`)
console.log(`generated ${entries.length} QQ reaction WebM assets in ${outputRoot}`)

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`${command} exited with ${code ?? signal}`)))
  })
}
