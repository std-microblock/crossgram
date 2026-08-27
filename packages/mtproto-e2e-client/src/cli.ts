#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { credentialsExist, resolveE2eProfile } from './profile.js'
import { openE2eClient } from './client.js'
import { runE2eProbe } from './probe.js'
import type { E2eClientEvent, OpenE2eClientOptions } from './types.js'

interface ParsedArgs {
  command: string
  positional: string[]
  options: Record<string, string | boolean>
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = 'auth', ...tokens] = argv
  const positional: string[] = []
  const options: Record<string, string | boolean> = {}
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const equals = token.indexOf('=')
    const rawName = equals >= 0 ? token.slice(2, equals) : token.slice(2)
    const name = rawName.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
    if (equals >= 0) {
      options[name] = token.slice(equals + 1)
      continue
    }
    const next = tokens[index + 1]
    if (next !== undefined && !next.startsWith('--')) options[name] = tokens[++index]!
    else options[name] = true
  }
  return { command, positional, options }
}

export function clientOptions(parsed: ParsedArgs, env = process.env): OpenE2eClientOptions {
  const value = parsed.options
  return {
    profile: stringOption(value.profile) ?? env.CROSSGRAM_E2E_PROFILE,
    root: stringOption(value.root) ?? env.CROSSGRAM_E2E_ROOT,
    host: stringOption(value.host) ?? env.CROSSGRAM_E2E_HOST,
    port: integerOption(value.port ?? env.CROSSGRAM_E2E_PORT, 'port', 1, 65_535),
    rsaKeyPath: stringOption(value.rsaKey) ?? env.CROSSGRAM_E2E_RSA_KEY,
    sshHost: stringOption(value.ssh) ?? env.CROSSGRAM_E2E_SSH,
    platformId: stringOption(value.platform) ?? env.CROSSGRAM_E2E_PLATFORM,
    approvalOrigin: stringOption(value.approvalOrigin) ?? env.CROSSGRAM_E2E_APPROVAL_ORIGIN,
    remoteRsaKeyPath: stringOption(value.remoteRsaKey) ?? env.CROSSGRAM_E2E_REMOTE_RSA_KEY,
    fresh: booleanOption(value.fresh),
    timeoutMs: integerOption(value.authTimeoutMs, 'auth-timeout-ms', 1),
    logLevel: integerOption(value.logLevel, 'log-level', 0),
    onEvent: printEvent,
  }
}

export async function runCli(argv: readonly string[], env = process.env): Promise<void> {
  const parsed = parseArgs(argv)
  const options = clientOptions(parsed, env)
  if (parsed.command === 'doctor') {
    const profile = await resolveE2eProfile(options)
    print({
      event: 'doctor', profile: profile.name, host: profile.config.host, port: profile.config.port,
      approval: profile.config.approval?.kind, platformId: profile.config.approval?.platformId,
      credentials: profile.paths.credentials, credentialsExist: await credentialsExist(profile.paths),
    })
    return
  }
  if (parsed.command === 'auth') {
    const opened = await openE2eClient(options)
    try {
      print({
        event: 'ready', profile: opened.profile.name, userId: opened.user.id,
        credentials: opened.profile.paths.credentials,
      })
    } finally {
      await opened.close()
    }
    return
  }
  if (parsed.command === 'run') {
    const filename = parsed.positional[0]
    if (!filename) throw new Error('Usage: mtproto:e2e run <probe.ts> [options]')
    await runE2eProbe(filename, {
      ...options,
      probeTimeoutMs: integerOption(parsed.options.timeoutMs, 'timeout-ms', 1) ?? 60_000,
      callTimeoutMs: integerOption(parsed.options.callTimeoutMs, 'call-timeout-ms', 1) ?? 30_000,
      maxResultBytes: integerOption(parsed.options.maxResultBytes, 'max-result-bytes', 1) ?? 1024 * 1024,
      onResult: value => print({ event: 'result', value }),
    })
    return
  }
  throw new Error(`Unknown command: ${parsed.command}`)
}

function printEvent(event: E2eClientEvent): void {
  print(event)
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function stringOption(value: string | boolean | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('Option requires a value')
  return value
}

function booleanOption(value: string | boolean | undefined): boolean {
  if (value === undefined || value === false || value === 'false') return false
  if (value === true || value === 'true') return true
  throw new Error(`Expected a boolean option, got ${value}`)
}

function integerOption(
  value: string | boolean | undefined,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === undefined) return undefined
  const result = Number(value)
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`--${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
