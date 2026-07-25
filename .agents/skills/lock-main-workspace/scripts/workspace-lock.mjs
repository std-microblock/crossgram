#!/usr/bin/env node

import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = 1
const DEFAULT_POLL_MS = 1_000
const TIMEOUT_EXIT_CODE = 124
const localHostname = hostname()

const usage = `Usage:
  workspace-lock.mjs acquire --agent <id> [options]
  workspace-lock.mjs release --agent <id> [--force] [options]
  workspace-lock.mjs status [--json] [options]
  workspace-lock.mjs help

Shared options:
  --lock-dir <path>        Override the shared lock directory

Acquire options:
  --agent <id>             Stable unique agent/task ID (required)
  --label <text>           Human-readable reason for the lease
  --wait-timeout <time>    Maximum wait; 0 disables (default: 0)
  --poll <time>            Poll interval (default: 1s)
  --quiet                  Suppress queue position messages

Release options:
  --agent <id>             The acquiring agent ID (required)
  --force                  Break another agent's abandoned lease

Status options:
  --json                   Print machine-readable JSON

Durations accept ms, s, m, or h, for example 500ms, 30s, 20m, or 2h.`

function fail(message, exitCode = 2) {
  const error = new Error(message)
  error.exitCode = exitCode
  throw error
}

function takeValue(args, index, option) {
  const value = args[index + 1]
  if (value === undefined) fail(`${option} requires a value`)
  return value
}

function parseDuration(value, option) {
  const match = /^(\d+)(ms|s|m|h)?$/i.exec(value)
  if (!match) fail(`${option} must be a duration such as 500ms, 30s, 20m, or 2h`)
  const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }
  const result = Number(match[1]) * multipliers[(match[2] || 'ms').toLowerCase()]
  if (!Number.isSafeInteger(result)) fail(`${option} is too large`)
  return result
}

function validateAgent(value) {
  if (!value || value.length > 128 || /[\u0000-\u001f]/.test(value)) {
    fail('--agent must contain 1-128 printable characters')
  }
  return value
}

function parseArgs(argv) {
  const command = argv[0] || 'help'
  if (['help', '--help', '-h'].includes(command)) return { command: 'help' }
  if (!['acquire', 'release', 'status'].includes(command)) fail(`unknown command: ${command}`)

  const result = {
    command,
    agent: process.env.CODEX_AGENT_ID || process.env.CODEX_THREAD_ID,
    label: undefined,
    lockDir: undefined,
    waitTimeoutMs: 0,
    pollMs: DEFAULT_POLL_MS,
    quiet: false,
    force: false,
    json: false,
  }
  const args = argv.slice(1)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--agent' && command !== 'status') {
      result.agent = validateAgent(takeValue(args, index, arg))
      index += 1
    } else if (arg === '--label' && command === 'acquire') {
      result.label = takeValue(args, index, arg)
      index += 1
    } else if (arg === '--lock-dir') {
      result.lockDir = path.resolve(takeValue(args, index, arg))
      index += 1
    } else if (arg === '--wait-timeout' && command === 'acquire') {
      result.waitTimeoutMs = parseDuration(takeValue(args, index, arg), arg)
      index += 1
    } else if (arg === '--poll' && command === 'acquire') {
      result.pollMs = parseDuration(takeValue(args, index, arg), arg)
      if (result.pollMs < 50) fail('--poll must be at least 50ms')
      index += 1
    } else if (arg === '--quiet' && command === 'acquire') {
      result.quiet = true
    } else if (arg === '--force' && command === 'release') {
      result.force = true
    } else if (arg === '--json' && command === 'status') {
      result.json = true
    } else {
      fail(`unknown or misplaced option for ${command}: ${arg}`)
    }
  }

  if (command !== 'status' && !result.agent) {
    fail(`${command} requires --agent <id> (or CODEX_AGENT_ID)`)
  }
  if (result.agent) result.agent = validateAgent(result.agent)
  return result
}

function gitOutput(args, cwd = process.cwd()) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  return result.status === 0 ? result.stdout.trim() : ''
}

function resolveLockDirectory(override, cwd = process.cwd()) {
  if (override) return path.resolve(override)
  if (process.env.MAIN_WORKSPACE_LOCK_DIR) return path.resolve(process.env.MAIN_WORKSPACE_LOCK_DIR)

  let commonDirectory = gitOutput(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
  if (!commonDirectory) {
    commonDirectory = gitOutput(['rev-parse', '--git-common-dir'], cwd)
    if (commonDirectory) commonDirectory = path.resolve(cwd, commonDirectory)
  }
  if (!commonDirectory) fail('cannot find a Git common directory; use --lock-dir <path>')
  return path.join(commonDirectory, 'codex', 'main-workspace-lock')
}

function resolveMainWorkspace(cwd = process.cwd()) {
  const output = gitOutput(['worktree', 'list', '--porcelain'], cwd)
  const firstLine = output.split(/\r?\n/, 1)[0]
  return firstLine.startsWith('worktree ') ? firstLine.slice('worktree '.length) : cwd
}

function lockPaths(directory) {
  return {
    directory,
    holderFile: path.join(directory, 'holder.json'),
    ticketsDirectory: path.join(directory, 'tickets'),
  }
}

async function ensureLockDirectory(paths) {
  await mkdir(paths.ticketsDirectory, { recursive: true })
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    if (error instanceof SyntaxError) return null
    throw error
  }
}

async function unlinkIfPresent(file) {
  await unlink(file).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function loadTickets(paths) {
  let names = []
  try {
    names = await readdir(paths.ticketsDirectory)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const tickets = []
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const file = path.join(paths.ticketsDirectory, name)
    const ticket = await readJson(file)
    if (ticket?.version === VERSION && ticket.id) tickets.push({ ...ticket, file })
  }
  tickets.sort((left, right) => left.queuedAtMs - right.queuedAtMs || left.id.localeCompare(right.id))
  return tickets
}

async function pruneDeadWaiters(paths, ownTicketId) {
  const tickets = await loadTickets(paths)
  for (const ticket of tickets) {
    if (ticket.id === ownTicketId) continue
    if (ticket.hostname && ticket.hostname !== localHostname) continue
    if (!isProcessAlive(ticket.waiterPid)) await unlinkIfPresent(ticket.file)
  }
}

async function createHolder(paths, ticket, mainWorkspace) {
  const holder = {
    version: VERSION,
    leaseId: ticket.id,
    agent: ticket.agent,
    label: ticket.label,
    mainWorkspace,
    requestedFrom: ticket.requestedFrom,
    hostname: localHostname,
    acquiredAt: new Date().toISOString(),
    acquiredAtMs: Date.now(),
  }
  const temporary = `${paths.holderFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(holder, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  try {
    await link(temporary, paths.holderFile)
    return holder
  } catch (error) {
    if (error.code === 'EEXIST') return undefined
    throw error
  } finally {
    await unlinkIfPresent(temporary)
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function formatAge(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

async function acquire(options) {
  const paths = lockPaths(resolveLockDirectory(options.lockDir))
  await ensureLockDirectory(paths)
  const existingHolder = await readJson(paths.holderFile)
  if (existingHolder === null) fail(`holder file is invalid: ${paths.holderFile}`, 1)
  if (existingHolder?.agent === options.agent) {
    process.stdout.write(`ALREADY ACQUIRED ${options.agent}\nMain workspace: ${existingHolder.mainWorkspace}\nLease: ${existingHolder.leaseId}\n`)
    return 0
  }

  await pruneDeadWaiters(paths)
  const existingTicket = (await loadTickets(paths)).find((ticket) => ticket.agent === options.agent)
  if (existingTicket) fail(`agent ${options.agent} is already waiting in another acquire process`)

  const queuedAtMs = Date.now()
  const ticket = {
    version: VERSION,
    id: `${queuedAtMs.toString(36)}-${process.pid}-${randomBytes(4).toString('hex')}`,
    agent: options.agent,
    label: options.label || '',
    requestedFrom: process.cwd(),
    hostname: localHostname,
    waiterPid: process.pid,
    queuedAt: new Date(queuedAtMs).toISOString(),
    queuedAtMs,
  }
  ticket.file = path.join(paths.ticketsDirectory, `${String(queuedAtMs).padStart(16, '0')}-${ticket.id}.json`)
  const temporaryTicket = `${ticket.file}.${process.pid}.tmp`
  await writeFile(temporaryTicket, `${JSON.stringify(ticket, (key, value) => key === 'file' ? undefined : value, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
  await rename(temporaryTicket, ticket.file)

  const log = (message) => {
    if (!options.quiet) process.stderr.write(`[workspace-lock] ${options.agent}: ${message}\n`)
  }
  let ticketExists = true
  const cleanTicket = async () => {
    if (!ticketExists) return
    ticketExists = false
    await unlinkIfPresent(ticket.file)
  }
  const handleSignal = () => {
    void cleanTicket().finally(() => process.exit(130))
  }
  process.once('SIGINT', handleSignal)
  process.once('SIGTERM', handleSignal)

  try {
    const startedAt = Date.now()
    let lastPosition
    while (true) {
      await pruneDeadWaiters(paths, ticket.id)
      const holder = await readJson(paths.holderFile)
      if (holder === null) fail(`holder file is invalid: ${paths.holderFile}`, 1)
      if (holder?.agent === options.agent) {
        await cleanTicket()
        process.stdout.write(`ALREADY ACQUIRED ${options.agent}\nMain workspace: ${holder.mainWorkspace}\nLease: ${holder.leaseId}\n`)
        return 0
      }
      if (options.waitTimeoutMs > 0 && Date.now() - startedAt >= options.waitTimeoutMs) {
        log(`wait timed out after ${options.waitTimeoutMs}ms`)
        return TIMEOUT_EXIT_CODE
      }

      const tickets = await loadTickets(paths)
      const position = tickets.findIndex((entry) => entry.id === ticket.id) + 1
      if (position === 0) fail('wait ticket disappeared', 1)
      if (position === 1 && holder === undefined) {
        const acquiredHolder = await createHolder(paths, ticket, resolveMainWorkspace())
        if (acquiredHolder) {
          await cleanTicket()
          process.stdout.write(`ACQUIRED ${options.agent}\nMain workspace: ${acquiredHolder.mainWorkspace}\nLease: ${acquiredHolder.leaseId}\n`)
          return 0
        }
      }
      if (position !== lastPosition) {
        log(`waiting at position ${position}${holder ? `; held by ${holder.agent}` : ''}`)
        lastPosition = position
      }
      await delay(options.pollMs)
    }
  } finally {
    process.removeListener('SIGINT', handleSignal)
    process.removeListener('SIGTERM', handleSignal)
    await cleanTicket()
  }
}

async function release(options) {
  const paths = lockPaths(resolveLockDirectory(options.lockDir))
  const holder = await readJson(paths.holderFile)
  if (holder === null) fail(`holder file is invalid: ${paths.holderFile}`, 1)
  if (!holder) {
    process.stdout.write('Main workspace is already unlocked\n')
    return 0
  }
  if (holder.agent !== options.agent && !options.force) {
    fail(`main workspace is held by ${holder.agent}; ${options.agent} cannot release it`)
  }
  await unlinkIfPresent(paths.holderFile)
  const action = holder.agent === options.agent ? 'RELEASED' : 'FORCE RELEASED'
  process.stdout.write(`${action} ${holder.agent}\nMain workspace: ${holder.mainWorkspace}\nLease: ${holder.leaseId}\n`)
  return 0
}

async function snapshot(options) {
  const paths = lockPaths(resolveLockDirectory(options.lockDir))
  const [holder, tickets] = await Promise.all([readJson(paths.holderFile), loadTickets(paths)])
  if (holder === null) fail(`holder file is invalid: ${paths.holderFile}`, 1)
  return {
    directory: paths.directory,
    mainWorkspace: holder?.mainWorkspace || resolveMainWorkspace(),
    holder: holder || null,
    waiters: tickets.map((ticket, index) => ({
      position: index + 1,
      id: ticket.id,
      agent: ticket.agent,
      label: ticket.label,
      requestedFrom: ticket.requestedFrom,
      queuedAt: ticket.queuedAt,
      queuedAtMs: ticket.queuedAtMs,
      waiterPid: ticket.waiterPid,
      waiterAlive: ticket.hostname !== localHostname || isProcessAlive(ticket.waiterPid),
    })),
  }
}

async function showStatus(options) {
  const state = await snapshot(options)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
    return 0
  }
  process.stdout.write(`Main workspace: ${state.mainWorkspace}\n`)
  if (state.holder) {
    process.stdout.write(`Holder: ${state.holder.agent} (${formatAge(state.holder.acquiredAtMs)})${state.holder.label ? ` - ${state.holder.label}` : ''}\n`)
  } else {
    process.stdout.write('Holder: none\n')
  }
  process.stdout.write(`Waiters: ${state.waiters.length}\n`)
  for (const waiter of state.waiters) {
    const stale = waiter.waiterAlive ? '' : ' [stale]'
    process.stdout.write(`#${waiter.position} ${waiter.agent} (${formatAge(waiter.queuedAtMs)})${waiter.label ? ` - ${waiter.label}` : ''}${stale}\n`)
  }
  return 0
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.command === 'help') {
    process.stdout.write(`${usage}\n`)
    return 0
  }
  if (options.command === 'acquire') return acquire(options)
  if (options.command === 'release') return release(options)
  return showStatus(options)
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntryPoint) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode
    },
    (error) => {
      process.stderr.write(`[workspace-lock] ${error.message}\n`)
      process.exitCode = error.exitCode || 1
    },
  )
}
