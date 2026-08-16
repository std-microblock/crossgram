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
const hooksPath = join(projectRoot, '.husky')

async function git(repo, ...args) {
  return execFileAsync('git', ['-C', repo, ...args])
}

test('git commit rejects a Claude co-author and accepts a normal commit', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'commit-message-e2e-'))
  await git(repo, 'init', '-b', 'main')
  await git(repo, 'config', 'user.name', 'Commit Message Test')
  await git(repo, 'config', 'user.email', 'test@example.invalid')
  await git(repo, 'config', 'core.hooksPath', hooksPath)

  const file = join(repo, 'file.txt')
  await writeFile(file, 'first\n')
  await git(repo, 'add', 'file.txt')
  await git(repo, 'commit', '-m', 'test: accept normal commit')

  await writeFile(file, 'second\n')
  await git(repo, 'add', 'file.txt')
  await git(
    repo,
    'commit',
    '-m',
    'test: accept trailer text in body',
    '-m',
    'Co-authored-by: Claude <noreply@anthropic.com>\nThis line makes it ordinary body text.',
  )

  await writeFile(file, 'third\n')
  await git(repo, 'add', 'file.txt')
  await assert.rejects(
    git(repo, 'commit', '-m', 'test: reject Claude co-author', '-m', 'Co-authored-by: Anthropic Claude <noreply@anthropic.com>'),
    error => error.code === 1 && error.stderr.includes('Claude must not be listed as a co-author'),
  )

  const { stdout } = await git(repo, 'log', '--format=%s')
  assert.deepEqual(stdout.trim().split('\n'), [
    'test: accept trailer text in body',
    'test: accept normal commit',
  ])
})
