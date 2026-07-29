import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { afterEach, describe, expect, it } from 'vitest'

const disposals: Array<() => Promise<void>> = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'crossgram-sqlite-concurrency-'))
  directories.push(directory)
  const path = join(directory, 'cordis.db')
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Database),
    ctx.plugin(SQLiteDriver, { path: pathToFileURL(path).href }),
  ]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  const driver = ctx.database.drivers.find((candidate) => candidate instanceof SQLiteDriver) as SQLiteDriver
  if (!driver) throw new Error('SQLite driver did not start')
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return { driver, path }
}

function holdExclusiveWriter(path: string, milliseconds: number): ChildProcessWithoutNullStreams {
  const source = `
    import { DatabaseSync } from 'node:sqlite';
    const database = new DatabaseSync(process.argv[1]);
    database.exec('PRAGMA journal_mode = WAL; BEGIN EXCLUSIVE; INSERT INTO events(value) VALUES (2)');
    process.stdout.write('locked\\n');
    setTimeout(() => {
      database.exec('COMMIT');
      database.close();
    }, Number(process.argv[2]));
  `
  return spawn(process.execPath, ['--input-type=module', '--eval', source, path, String(milliseconds)])
}

async function waitForLine(child: ChildProcessWithoutNullStreams, line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = ''
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (!output.includes(`${line}\n`)) return
      child.stdout.off('data', onData)
      resolve()
    }
    child.stdout.on('data', onData)
    child.once('error', reject)
    child.once('exit', (code) => {
      if (!output.includes(`${line}\n`)) reject(new Error(`lock process exited early with code ${code}`))
    })
  })
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let error = ''
    child.stderr.on('data', (chunk) => { error += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(error || `lock process exited ${code}`)))
  })
}

describe('SQLite concurrency defaults', () => {
  it('enables WAL and a finite busy timeout for file databases', async () => {
    const { driver } = await createDatabase()

    expect(driver.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    expect(driver.db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5_000 })
  })

  it('keeps readers live and waits for a concurrent writer instead of dropping the write', async () => {
    const { driver, path } = await createDatabase()
    driver.db.exec('CREATE TABLE events (value INTEGER NOT NULL); INSERT INTO events(value) VALUES (1)')
    const child = holdExclusiveWriter(path, 400)
    const childExited = waitForExit(child)
    await waitForLine(child, 'locked')

    const readStarted = Date.now()
    expect(driver.db.prepare('SELECT count(*) AS count FROM events').get()).toEqual({ count: 1 })
    expect(Date.now() - readStarted).toBeLessThan(200)

    const writeStarted = Date.now()
    driver.db.exec('INSERT INTO events(value) VALUES (3)')
    const writeDuration = Date.now() - writeStarted
    expect(writeDuration).toBeGreaterThanOrEqual(150)
    expect(writeDuration).toBeLessThan(5_000)
    await childExited

    expect(driver.db.prepare('SELECT value FROM events ORDER BY value').all()).toEqual([
      { value: 1 }, { value: 2 }, { value: 3 },
    ])
  })
})
