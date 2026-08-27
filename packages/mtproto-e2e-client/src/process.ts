import { spawn } from 'node:child_process'

export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

export type ProcessExecutor = (
  command: string,
  args: readonly string[],
  options?: { input?: string, timeoutMs?: number },
) => Promise<ProcessResult>

export const executeProcess: ProcessExecutor = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let settled = false
  const timer = options.timeoutMs
    ? setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        reject(new Error(`${command} timed out after ${options.timeoutMs}ms`))
      }, options.timeoutMs)
    : undefined
  timer?.unref()
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
  child.on('error', (error) => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    reject(error)
  })
  child.on('close', (code) => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    resolve({
      code: code ?? -1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    })
  })
  if (options.input !== undefined) child.stdin.end(options.input)
  else child.stdin.end()
})

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
