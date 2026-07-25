#!/usr/bin/env node
'use strict'

const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { lstat, readdir, rm } = require('node:fs/promises')
const { basename, dirname, isAbsolute, join, relative, resolve } = require('node:path')

const MATERIALGRAM_IMAGE = 'materialgram.exe'
const PROJECT_PORTS = new Set([4430, 3140])
const MATERIALGRAM_DIRECTORIES = new Set(['tdata', 'logs', 'log', 'dumps', 'cache'])
const MATERIALGRAM_FILE_PATTERN = /^(?:log|crash|debug).*|.*\.(?:log|dmp|tmp)$/i
const RSA_KEY_PATTERN = /^(?:rsa[-_]?key)(?:[._-]|$)/i

function isWithin(base, target) {
  const rel = relative(resolve(base), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function assertSafeTarget(target, allowedBases) {
  const absolute = resolve(target)
  const owner = allowedBases.find(base => isWithin(base, absolute) && resolve(base) !== absolute)
  if (!owner) throw new Error(`Refusing unsafe cleanup target: ${absolute}`)
  return absolute
}

function isRsaKeyArtifact(name) {
  return RSA_KEY_PATTERN.test(name)
}

function isMaterialgramRuntimeEntry(entry) {
  if (entry.isDirectory()) return MATERIALGRAM_DIRECTORIES.has(entry.name.toLowerCase())
  return entry.isFile() && MATERIALGRAM_FILE_PATTERN.test(entry.name)
}

async function entries(directory) {
  if (!existsSync(directory)) return []
  return readdir(directory, { withFileTypes: true })
}

async function buildCleanupPlan(projectRoot, materialgramDir) {
  const root = resolve(projectRoot)
  const client = resolve(materialgramDir)
  const dataDir = join(root, 'data')
  const projectCache = join(root, 'cache')
  const targets = []
  const preserved = []

  for (const entry of await entries(client)) {
    if (!isMaterialgramRuntimeEntry(entry)) continue
    targets.push({ path: join(client, entry.name), reason: 'Materialgram runtime data' })
  }

  for (const entry of await entries(dataDir)) {
    if (isRsaKeyArtifact(entry.name)) {
      preserved.push(join(dataDir, entry.name))
      continue
    }
    targets.push({ path: join(dataDir, entry.name), reason: 'relay database/cache state' })
  }

  if (existsSync(projectCache)) {
    targets.push({ path: projectCache, reason: 'project cache' })
  }

  const allowedBases = [client, dataDir, root]
  return {
    targets: targets.map(target => ({
      ...target,
      path: assertSafeTarget(target.path, allowedBases),
    })).sort((left, right) => left.path.localeCompare(right.path)),
    preserved: preserved.map(path => resolve(path)).sort(),
  }
}

function parseListeningPorts(output) {
  const portsByPid = new Map()
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i)
    if (!match) continue
    const port = Number(match[2])
    const pid = Number(match[3])
    const ports = portsByPid.get(pid) ?? new Set()
    ports.add(port)
    portsByPid.set(pid, ports)
  }
  return portsByPid
}

function normalizePowerShellJson(output) {
  const text = output.trim()
  if (!text) return []
  const value = JSON.parse(text)
  return Array.isArray(value) ? value : [value]
}

function listCandidateProcesses() {
  const command = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()',
    "Get-CimInstance Win32_Process | Where-Object {",
    "  $_.Name -ieq 'materialgram.exe' -or $_.Name -ieq 'node.exe' -or $_.Name -ieq 'cordis.exe'",
    '} | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
  ].join('; ')
  const output = execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command,
  ], { encoding: 'utf8', windowsHide: true })
  const ports = parseListeningPorts(execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], {
    encoding: 'utf8', windowsHide: true,
  }))
  return normalizePowerShellJson(output).map(item => ({
    pid: Number(item.ProcessId),
    parentPid: Number(item.ParentProcessId),
    name: String(item.Name ?? ''),
    executablePath: String(item.ExecutablePath ?? ''),
    commandLine: String(item.CommandLine ?? ''),
    listeningPorts: [...(ports.get(Number(item.ProcessId)) ?? [])],
  }))
}

function selectRelatedProcesses(processes, projectRoot, currentPid = process.pid) {
  const root = resolve(projectRoot).toLowerCase()
  return processes.filter(item => {
    if (!Number.isSafeInteger(item.pid) || item.pid <= 0 || item.pid === currentPid) return false
    const name = item.name.toLowerCase()
    if (name === MATERIALGRAM_IMAGE) return true
    if (name !== 'node.exe' && name !== 'cordis.exe') return false
    const command = item.commandLine.toLowerCase()
    const ownsProjectPort = item.listeningPorts.some(port => PROJECT_PORTS.has(port))
    return command.includes(root) || ownsProjectPort
  })
}

function findRelatedProcesses(projectRoot) {
  return selectRelatedProcesses(listCandidateProcesses(), projectRoot)
}

function processLabel(item) {
  const ports = item.listeningPorts.length ? ` ports=${item.listeningPorts.join(',')}` : ''
  return `${item.name} pid=${item.pid}${ports}`
}

async function stopRelatedProcesses(projectRoot) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const related = findRelatedProcesses(projectRoot)
    if (!related.length) return
    for (const item of related) {
      console.log(`Stopping ${processLabel(item)} ...`)
      try {
        execFileSync('taskkill.exe', ['/PID', String(item.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true,
        })
      } catch {
        // The process may have exited between discovery and taskkill.
      }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 400))
  }
  const remaining = findRelatedProcesses(projectRoot)
  if (remaining.length) {
    throw new Error(`Processes are still running: ${remaining.map(processLabel).join('; ')}`)
  }
}

async function removeTarget(target) {
  let stat
  try {
    stat = await lstat(target)
  } catch (error) {
    if (error && error.code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) {
    await rm(target, { force: true })
  } else {
    await rm(target, { recursive: stat.isDirectory(), force: true })
  }
}

function resolveRoots() {
  const testRoot = process.env.NODE_ENV === 'test'
    ? process.env.MATERIALGRAM_CLEANUP_TEST_ROOT
    : undefined
  const projectRoot = resolve(testRoot || join(__dirname, '..', '..'))
  const materialgramDir = testRoot
    ? join(projectRoot, 'binary_patch', 'materialgram')
    : resolve(__dirname)
  const packageFile = join(projectRoot, 'package.json')
  const executable = join(materialgramDir, MATERIALGRAM_IMAGE)
  if (!existsSync(packageFile)) throw new Error(`Project marker not found: ${packageFile}`)
  if (!existsSync(executable)) throw new Error(`Materialgram executable not found: ${executable}`)
  if (!isWithin(projectRoot, materialgramDir)) {
    throw new Error(`Materialgram directory is outside the project: ${materialgramDir}`)
  }
  return { projectRoot, materialgramDir }
}

async function run(options = {}) {
  const { projectRoot, materialgramDir } = resolveRoots()
  const plan = await buildCleanupPlan(projectRoot, materialgramDir)
  console.log(`Project: ${projectRoot}`)
  console.log(`Client : ${materialgramDir}`)
  console.log('')

  if (options.dryRun) {
    const related = process.env.MATERIALGRAM_CLEANUP_SKIP_PROCESSES === '1'
      ? []
      : findRelatedProcesses(projectRoot)
    console.log('DRY RUN - nothing will be stopped or deleted.')
    for (const item of related) console.log(`[process] ${processLabel(item)}`)
  } else {
    if (!options.yes) {
      throw new Error('Destructive cleanup requires --yes. Use --dry-run to preview.')
    }
    if (process.env.MATERIALGRAM_CLEANUP_SKIP_PROCESSES !== '1') {
      await stopRelatedProcesses(projectRoot)
    }
  }

  for (const path of plan.preserved) console.log(`[keep]   ${path}`)
  for (const target of plan.targets) {
    console.log(`[delete] ${target.path} (${target.reason})`)
    if (!options.dryRun) await removeTarget(target.path)
  }
  console.log('')
  console.log(options.dryRun ? 'Dry run complete.' : 'Cleanup complete. RSA key files were preserved.')
  return plan
}

function parseArgs(argv) {
  const args = new Set(argv)
  const known = new Set(['--yes', '--dry-run', '--help'])
  for (const arg of args) {
    if (!known.has(arg)) throw new Error(`Unknown option: ${arg}`)
  }
  return { yes: args.has('--yes'), dryRun: args.has('--dry-run'), help: args.has('--help') }
}

function usage() {
  console.log([
    'Usage:',
    '  clean-materialgram.cmd       Stop related processes and perform cleanup',
    '  node clean-materialgram.cjs --dry-run',
    '',
    'Preserved: materialgram.exe, cleanup scripts, data/rsa-key*',
    'Deleted  : tdata/logs/dumps, project cache, all other entries under data',
  ].join('\n'))
}

if (require.main === module) {
  Promise.resolve().then(async () => {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) return usage()
    await run(options)
  }).catch(error => {
    console.error(`Cleanup failed: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  assertSafeTarget,
  buildCleanupPlan,
  isMaterialgramRuntimeEntry,
  isRsaKeyArtifact,
  isWithin,
  parseListeningPorts,
  selectRelatedProcesses,
}
