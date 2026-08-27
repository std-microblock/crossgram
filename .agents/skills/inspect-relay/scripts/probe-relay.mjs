#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function parseArgs(argv) {
  const [command = 'doctor', ...tokens] = argv
  const options = { _: [] }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token.startsWith('--')) {
      options._.push(token)
      continue
    }
    const [rawKey, inlineValue] = token.slice(2).split(/=(.*)/s, 2)
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    const next = tokens[index + 1]
    options[key] =
      inlineValue ??
      (next !== undefined && !next.startsWith('--') ? tokens[++index] : true)
  }
  return { command, options }
}

export function normalizeScriptName(value) {
  const normalized = String(value).replaceAll('\\', '/')
  const parts = normalized.split('/')
  if (
    !normalized.endsWith('.ts') ||
    normalized.endsWith('.d.ts') ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    parts.some(
      (part) => !part || part === '.' || part === '..' || part.startsWith('.'),
    )
  ) {
    throw new Error(`Invalid debug script name: ${value}`)
  }
  return normalized
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

export function runtimeOptions(options = {}, env = process.env) {
  return {
    host: String(
      options.host || env.CROSSGRAM_INSPECT_HOST || 'root@118.89.184.208',
    ),
    remoteRoot: String(options.remoteRoot || '/var/lib/crossgram'),
    localRoot: options.localRoot
      ? resolve(String(options.localRoot))
      : undefined,
    timeout: boundedInteger(options.timeout, 10_000, 100, 300_000),
    interval: boundedInteger(options.interval, 250, 25, 10_000),
  }
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value ?? fallback)
  if (!Number.isInteger(number) || number < min || number > max)
    throw new Error(`Invalid numeric option: ${value}`)
  return number
}

export function localPaths(root, name) {
  const script = normalizeScriptName(name)
  return {
    scriptsRoot: join(root, 'debug-scripts'),
    resultsRoot: join(root, 'debug-results'),
    script: join(root, 'debug-scripts', ...script.split('/')),
    status: join(root, 'debug-results', ...`${script}.json`.split('/')),
    index: join(root, 'debug-results', 'index.json'),
  }
}

export function remotePaths(root, name) {
  const script = normalizeScriptName(name)
  const base = root.replace(/\/$/, '')
  return {
    scriptsRoot: `${base}/debug-scripts`,
    resultsRoot: `${base}/debug-results`,
    script: `${base}/debug-scripts/${script}`,
    status: `${base}/debug-results/${script}.json`,
    index: `${base}/debug-results/index.json`,
  }
}

export function buildRemoteInstallCommand(root, name, temporary) {
  const paths = remotePaths(root, name)
  return [
    `install -d -m 0700 -o crossgram -g crossgram ${shellQuote(posix.dirname(paths.script))} ${shellQuote(paths.resultsRoot)}`,
    `install -m 0600 -o crossgram -g crossgram ${shellQuote(temporary)} ${shellQuote(paths.script)}`,
    `rm -f -- ${shellQuote(temporary)}`,
  ].join(' && ')
}

export function execute(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0 || options.allowFailure)
        resolvePromise({ code, stdout, stderr })
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`))
    })
  })
}

async function readJson(path, options, allowMissing = false) {
  let source
  if (options.localRoot) {
    if (allowMissing && !existsSync(path)) return undefined
    source = await readFile(path, 'utf8')
  } else {
    const result = await execute(
      'ssh',
      [options.host, `cat -- ${shellQuote(path)}`],
      { allowFailure: allowMissing },
    )
    if (result.code !== 0) return undefined
    source = result.stdout
  }
  return JSON.parse(source)
}

async function deploy(filename, name, options) {
  const source = resolve(filename)
  if (!existsSync(source)) throw new Error(`Probe does not exist: ${source}`)
  if (options.localRoot) {
    const paths = localPaths(options.localRoot, name)
    await mkdir(dirname(paths.script), { recursive: true, mode: 0o700 })
    await mkdir(paths.resultsRoot, { recursive: true, mode: 0o700 })
    const temporary = `${paths.script}.tmp-${process.pid}`
    await copyFile(source, temporary)
    await rename(temporary, paths.script)
    return
  }
  const temporary = `/tmp/crossgram-debug-${randomUUID()}.ts`
  await execute('scp', [source, `${options.host}:${temporary}`])
  try {
    await execute('ssh', [
      options.host,
      buildRemoteInstallCommand(options.remoteRoot, name, temporary),
    ])
  } catch (error) {
    await execute('ssh', [options.host, `rm -f -- ${shellQuote(temporary)}`], {
      allowFailure: true,
    })
    throw error
  }
}

async function removeProbe(name, options) {
  if (options.localRoot) {
    await rm(localPaths(options.localRoot, name).script, { force: true })
  } else {
    await execute('ssh', [
      options.host,
      `rm -f -- ${shellQuote(remotePaths(options.remoteRoot, name).script)}`,
    ])
  }
}

async function status(name, options, allowMissing = false) {
  const path = options.localRoot
    ? localPaths(options.localRoot, name).status
    : remotePaths(options.remoteRoot, name).status
  return readJson(path, options, allowMissing)
}

async function list(options) {
  const path = options.localRoot
    ? join(options.localRoot, 'debug-results', 'index.json')
    : `${options.remoteRoot.replace(/\/$/, '')}/debug-results/index.json`
  return (await readJson(path, options, true)) ?? []
}

async function wait(name, options, requireResult) {
  const started = Date.now()
  while (Date.now() - started < options.timeout) {
    const current = await status(name, options, true)
    if (current?.state === 'failed') return current
    if (
      current?.state === 'active' &&
      (!requireResult || current.results?.length)
    )
      return current
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, options.interval),
    )
  }
  throw new Error(`Timed out waiting for ${name} after ${options.timeout}ms`)
}

async function doctor(options) {
  if (options.localRoot) {
    return {
      mode: 'local',
      root: options.localRoot,
      scriptsExists: existsSync(join(options.localRoot, 'debug-scripts')),
      resultsExists: existsSync(join(options.localRoot, 'debug-results')),
      probes: await list(options),
    }
  }
  const service = await execute(
    'ssh',
    [options.host, 'systemctl is-active crossgram'],
    { allowFailure: true },
  )
  const paths = remotePaths(options.remoteRoot, 'doctor.ts')
  const directories = await execute(
    'ssh',
    [
      options.host,
      `test -d ${shellQuote(paths.scriptsRoot)} && test -d ${shellQuote(paths.resultsRoot)}`,
    ],
    { allowFailure: true },
  )
  return {
    mode: 'ssh',
    host: options.host,
    service: service.stdout.trim() || 'unknown',
    runnerDirectories: directories.code === 0,
    probes: await list(options),
  }
}

async function cleanup(options) {
  if (options.localRoot) {
    await rm(join(options.localRoot, 'debug-scripts'), {
      recursive: true,
      force: true,
    })
    await mkdir(join(options.localRoot, 'debug-scripts'), {
      recursive: true,
      mode: 0o700,
    })
  } else {
    const root = `${options.remoteRoot.replace(/\/$/, '')}/debug-scripts`
    await execute('ssh', [
      options.host,
      `find ${shellQuote(root)} -type f -name '*.ts' -delete`,
    ])
  }
}

export async function run(argv, io = {}) {
  const { command, options: raw } = parseArgs(argv)
  const options = runtimeOptions(raw, io.env)
  let result
  if (command === 'doctor') {
    result = await doctor(options)
  } else if (command === 'list') {
    result = await list(options)
  } else if (command === 'deploy') {
    const filename = raw._[0]
    if (!filename)
      throw new Error('Usage: deploy <probe.ts> [--name path/probe.ts]')
    const name = normalizeScriptName(String(raw.name || basename(filename)))
    await deploy(filename, name, options)
    result = { deployed: name }
  } else if (command === 'status') {
    result = await status(normalizeScriptName(raw._[0]), options)
  } else if (command === 'wait') {
    result = await wait(
      normalizeScriptName(raw._[0]),
      options,
      raw.result === true || raw.result === 'true',
    )
  } else if (command === 'remove') {
    const name = normalizeScriptName(raw._[0])
    await removeProbe(name, options)
    result = { removed: name }
  } else if (command === 'cleanup') {
    await cleanup(options)
    result = { cleaned: true }
  } else if (command === 'run') {
    const filename = raw._[0]
    if (!filename)
      throw new Error('Usage: run <probe.ts> [--name path/probe.ts] [--keep]')
    const name = normalizeScriptName(String(raw.name || basename(filename)))
    await deploy(filename, name, options)
    try {
      result = await wait(name, options, true)
    } finally {
      if (raw.keep !== true && raw.keep !== 'true')
        await removeProbe(name, options)
    }
  } else {
    throw new Error(`Unknown command: ${command}`)
  }
  const json = `${JSON.stringify(result, null, 2)}\n`
  ;(io.stdout || process.stdout).write(json)
  return result
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
