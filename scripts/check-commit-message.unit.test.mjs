import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const hook = join(projectRoot, '.husky/commit-msg')

async function check(message) {
  const root = await mkdtemp(join(tmpdir(), 'commit-message-test-'))
  const messageFile = join(root, 'COMMIT_EDITMSG')
  await writeFile(messageFile, message)
  return execFileAsync('sh', [hook, messageFile])
}

test('accepts commit messages without a Claude co-author', async () => {
  await check('fix: handle reconnect\n')
  await check('fix: mention Claude in the description\n\nClaude helped diagnose the issue.\n')
  await check('fix: document a trailer example\n\nCo-authored-by: Claude <noreply@anthropic.com>\nThis line keeps the example in the commit body.\n')
  await check('fix: pair on reconnect\n\nCo-authored-by: Alice <alice@example.com>\n')
  await check('fix: allow unrelated identities\n\nCo-authored-by: Claudette <claudette@example.com>\nCo-authored-by: Alice <claude@example.com>\n')
})

test('rejects Claude co-author trailers case-insensitively', async () => {
  for (const trailer of [
    'Co-authored-by: Claude <noreply@anthropic.com>',
    'co-authored-by: claude code <noreply@anthropic.com>',
    'CO-AUTHORED-BY: Claude Opus <noreply@anthropic.com>',
  ]) {
    await assert.rejects(
      check(`fix: handle reconnect\n\n${trailer}\n`),
      error => error.code === 1 && error.stderr.includes('Claude must not be listed as a co-author'),
    )
  }
})
