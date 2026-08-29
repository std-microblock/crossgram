import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./probe-relay.mjs', import.meta.url))

function execute(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)),
    )
  })
}

test('CLI atomically deploys, reads status, removes, and cleans probes in local mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'probe-relay-e2e-'))
  const source = join(root, 'source.ts')
  writeFileSync(source, 'export function apply() {}\n')
  try {
    assert.deepEqual(
      await execute(
        ['deploy', source, '--name', 'issue/probe.ts', '--local-root', root],
        root,
      ),
      {
        deployed: 'issue/probe.ts',
      },
    )
    const deployed = join(root, 'debug-scripts', 'issue', 'probe.ts')
    assert.equal(existsSync(deployed), true)

    const results = join(root, 'debug-results', 'issue')
    mkdirSync(results, { recursive: true })
    const status = {
      script: 'issue/probe.ts',
      state: 'active',
      generation: 1,
      results: [{ value: 'ok' }],
    }
    writeFileSync(join(results, 'probe.ts.json'), JSON.stringify(status))
    assert.deepEqual(
      await execute(['status', 'issue/probe.ts', '--local-root', root], root),
      status,
    )

    assert.deepEqual(
      await execute(['remove', 'issue/probe.ts', '--local-root', root], root),
      { removed: 'issue/probe.ts' },
    )
    assert.equal(existsSync(deployed), false)

    writeFileSync(
      join(root, 'debug-scripts', 'leftover.ts'),
      'export function apply() {}',
    )
    assert.deepEqual(await execute(['cleanup', '--local-root', root], root), {
      cleaned: true,
    })
    assert.equal(existsSync(join(root, 'debug-scripts', 'leftover.ts')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI wait observes a result written asynchronously by the runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'probe-relay-wait-e2e-'))
  try {
    const results = join(root, 'debug-results')
    mkdirSync(results, { recursive: true })
    setTimeout(
      () =>
        writeFileSync(
          join(results, 'probe.ts.json'),
          JSON.stringify({
            script: 'probe.ts',
            state: 'active',
            generation: 1,
            results: [{ value: 42 }],
          }),
        ),
      100,
    )
    const result = await execute(
      [
        'wait',
        'probe.ts',
        '--result',
        '--timeout',
        '3000',
        '--interval',
        '25',
        '--local-root',
        root,
      ],
      root,
    )
    assert.equal(result.results[0].value, 42)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('statistics deploys the bundled probe, unwraps its result, and removes it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'probe-relay-statistics-e2e-'))
  const name = 'monitor/mtproto-statistics.ts'
  const deployed = join(root, 'debug-scripts', 'monitor', 'mtproto-statistics.ts')
  const status = join(
    root,
    'debug-results',
    'monitor',
    'mtproto-statistics.ts.json',
  )
  let publisher
  try {
    publisher = setInterval(() => {
      if (!existsSync(deployed) || existsSync(status)) return
      mkdirSync(join(root, 'debug-results', 'monitor'), { recursive: true })
      writeFileSync(
        status,
        JSON.stringify({
          script: name,
          state: 'active',
          generation: 1,
          results: [
            {
              value: {
                snapshot: {
                  methods: [
                    {
                      method: 'messages.getHistory',
                      count: 12,
                      averageMs: 40,
                      p90Ms: 90,
                      p99Ms: 150,
                      errors: 0,
                      errorRate: 0,
                    },
                  ],
                },
                series: { seconds: [], minutes: [], hours: [] },
              },
            },
          ],
        }),
      )
    }, 10)
    const result = await execute(
      [
        'statistics',
        '--name',
        name,
        '--timeout',
        '3000',
        '--interval',
        '25',
        '--local-root',
        root,
      ],
      root,
    )
    assert.equal(
      result.snapshot.methods[0].method,
      'messages.getHistory',
    )
    assert.equal(result.snapshot.methods[0].p99Ms, 150)
    assert.equal(existsSync(deployed), false)
  } finally {
    clearInterval(publisher)
    rmSync(root, { recursive: true, force: true })
  }
})
