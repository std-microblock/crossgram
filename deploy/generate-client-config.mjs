#!/usr/bin/env node
import { createPublicKey } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'

const options = parseArgs(process.argv.slice(2))
const host = options.host
const port = Number(options.port ?? 4430)
const name = options.name ?? 'CrossGram'
const keyPath = options.key ?? '/var/lib/crossgram/data/rsa-key.json'

if (!host || !isIP(host)) throw new Error('--host must be a literal IPv4 or IPv6 address')
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port must be between 1 and 65535')

const keySource = readFileSync(keyPath, 'utf8')
const candidate = keySource.trimStart().startsWith('{')
  ? JSON.parse(keySource).publicKeyPem
  : keySource
if (typeof candidate !== 'string') throw new Error(`${keyPath} does not contain publicKeyPem`)
const rsaKey = createPublicKey(candidate).export({ type: 'pkcs1', format: 'pem' }).toString().trim()

const config = {
  name,
  enable_special_config: false,
  host,
  port,
  rsa_key: rsaKey,
  dcs: Array.from({ length: 5 }, (_, index) => ({ id: index + 1, ip: host, port })),
}
const json = `${JSON.stringify(config, null, 2)}\n`
if (options.output) writeFileSync(options.output, json, { mode: 0o600 })
else process.stdout.write(json)

function parseArgs(args) {
  const parsed = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument: ${key ?? '<missing>'}`)
    parsed[key.slice(2)] = value
  }
  return parsed
}
