/** Local synthetic retained-cache profile; never run GC/heap profiling on production. */
import { AuthKeyDataStore, AUTH_KEY_DATA_IDLE_TTL_MS, authKeyIdHex } from '../packages/mtproto/src/session/auth-key-data-store.js'

async function main() {
  const devices = Number(process.argv[2] ?? 8)
  const users = Number(process.argv[3] ?? 6000)
  const legacy = process.argv.includes('--no-prune')
  if (!Number.isSafeInteger(devices) || devices < 1 || devices > 100
    || !Number.isSafeInteger(users) || users < 1 || users > 100_000) {
    throw new Error('Usage: node --expose-gc --import tsx scripts/profile-device-memory.ts [1..100 devices] [1..100000 users] [--no-prune]')
  }
  if (!global.gc) throw new Error('Run with --expose-gc')
  const store = new AuthKeyDataStore()
  const key = (index: number) => Uint8Array.of(index)
  const measure = () => { global.gc!(); return process.memoryUsage() }
  const baseline = measure()
  function populate() {
    for (let device = 0; device < devices; device++) {
      // Mimic the user/avatar/member/message maps observed by the read-only probe.
      // This measures retention policy, not the whole app or a real Telegram workload.
      const rows = Array.from({ length: users }, (_, i) => ({
        id: String(i), firstName: 'user-' + device + '-' + i,
        metadata: { nickname: 'member-' + device + '-' + i, flags: [1, 2, 3] },
        avatar: { id: 'avatar-' + i, url: 'https://example.invalid/avatar/' + device + '/' + i },
      }))
      store.set(key(device), {
        users: new Map(rows.map(row => [row.id, row])),
        avatars: new Map(rows.map(row => [row.id, row.avatar])),
        members: rows.map(user => ({ user, role: 'member' })),
        messages: new Map(rows.map((row, i) => [i, { peer: row.id, messageId: 'message-' + device + '-' + i }])),
      })
    }
  }
  populate()
  const loaded = measure()
  const removed = legacy ? [] : store.prune(new Set([authKeyIdHex(key(0))]), Date.now() + AUTH_KEY_DATA_IDLE_TTL_MS + 1)
  // Let promise/microtask temporaries settle before the final GC.
  await new Promise<void>(resolve => setImmediate(resolve))
  const idle = measure()
  console.log(JSON.stringify({ devices, usersPerDevice: users, mode: legacy ? 'before-policy' : 'idle-eviction',
    evictedDevices: removed.length, baseline, loaded, idle,
    retainedHeapBefore: loaded.heapUsed - baseline.heapUsed,
    retainedHeapAfter: idle.heapUsed - baseline.heapUsed,
  }, null, 2))
}
void main()
