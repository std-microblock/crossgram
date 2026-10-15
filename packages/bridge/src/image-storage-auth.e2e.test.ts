import SSO from '@cordisjs/plugin-sso'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startApp, waitForWebuiRoute } from '../../test-suite/src/harness.js'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })

async function fixture(adminUserIds: number[] = [1]) {
  const root = await mkdtemp(join(tmpdir(), 'crossgram-image-auth-'))
  disposals.push(() => rm(root, { recursive: true, force: true }))
  const app = await startApp({ bridgeConfig: {
    uploadPath: join(root, 'uploads'), imageStorage: { path: join(root, 'images'), adminUserIds },
  } })
  disposals.push(app.stop)
  const entry = await waitForWebuiRoute(app.ctx, '/platform-accounts')
  const id = 'a'.repeat(64)
  await app.ctx.database.create('mtproto_image_storage', {
    id, platformId: 'private-account', platformSessionId: 'private-session', messageId: 1,
    platformMediaId: 'private-image', isPreview: false, conversationId: 'secret-group', conversationTitle: '私密群',
    date: '2026-10-15', timestamp: 1792022400, media: {}, state: 'pending', bytes: 0,
  })
  const frames: any[] = []
  const socket = new WebSocket(app.ctx.server.baseUrl.replace('http:', 'ws:') + '/api')
  disposals.push(async () => { socket.close() })
  socket.addEventListener('message', event => frames.push(JSON.parse(String(event.data))))
  await vi.waitFor(() => expect(frames[0]?.type).toBe('entry:init'))
  let serial = 0
  const call = async (method: string, token?: unknown, filter: unknown = {}) => {
    const sn = ++serial
    socket.send(JSON.stringify({ type: 'rpc:request', body: { sn, entryId: entry.id, method, args: [filter, token] } }))
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'rpc:response' && frame.body.sn === sn)).toBe(true))
    return frames.find(frame => frame.type === 'rpc:response' && frame.body.sn === sn).body
  }
  const pending = async () => expect(await app.ctx.database.get('mtproto_image_storage', { id }))
    .toMatchObject([{ state: 'pending' }])
  const sso = async () => {
    const fiber = app.ctx.plugin(SSO)
    disposals.push(() => fiber.dispose())
    await fiber
    await app.ctx.database.prepared()
    const admin = await app.ctx.sso.createUser('image-storage-auth-admin')
    const member = await app.ctx.sso.createUser('image-storage-auth-member')
    expect(admin.user.id).toBe(1)
    return {
      admin: await app.ctx.sso.createSession(admin.user.id, admin.identityId),
      member: await app.ctx.sso.createSession(member.user.id, member.identityId),
    }
  }
  return { ...app, entry, id, frames, socket, call, pending, sso }
}

describe('图片存储 WebSocket 管理权限 e2e', () => {
  it('无SSO时拒绝新RPC，匿名账号发现保持原行为且不广播归档清单', async () => {
    const app = await fixture()
    for (const method of ['getImageStorage', 'deleteImageStorage']) {
      expect(await app.call(method)).toMatchObject({ ok: false, message: expect.stringContaining('SSO') })
    }
    await app.pending()
    app.socket.send(JSON.stringify({ type: 'entry:subscribe', body: { id: app.entry.id } }))
    await vi.waitFor(() => expect(app.frames.some(frame => frame.type === 'entry:snapshot')).toBe(true))
    const snapshot = app.frames.find(frame => frame.type === 'entry:snapshot')
    expect(snapshot.body.data.accounts).toBeInstanceOf(Array)
    expect(JSON.stringify(app.frames)).not.toContain('secret-group')
    expect(JSON.stringify(app.frames)).not.toContain('私密群')
  })

  it('每次query/delete都拒绝匿名、伪造token、普通SSO用户和已撤销管理员会话', async () => {
    const app = await fixture()
    const tokens = await app.sso()
    for (const method of ['getImageStorage', 'deleteImageStorage']) {
      expect(await app.call(method)).toMatchObject({ ok: false, message: expect.stringContaining('Your account') })
      expect(await app.call(method, { id: 1 })).toMatchObject({ ok: false, message: expect.stringContaining('Your account') })
      expect(await app.call(method, 'forged-token')).toMatchObject({ ok: false, message: expect.stringContaining('登录已失效') })
      expect(await app.call(method, tokens.member)).toMatchObject({ ok: false, message: expect.stringContaining('没有图片存储管理权限') })
      await app.pending()
    }
    expect(JSON.stringify(app.frames)).not.toContain('secret-group')
    expect(await app.call('getImageStorage', tokens.admin)).toMatchObject({ ok: true, value: {
      count: 0, bytes: 0, pendingCount: 1, groups: [{ conversationId: 'secret-group' }],
    } })
    await app.ctx.sso.destroySession(tokens.admin)
    for (const method of ['getImageStorage', 'deleteImageStorage']) {
      expect(await app.call(method, tokens.admin)).toMatchObject({ ok: false, message: expect.stringContaining('登录已失效') })
    }
    await app.pending()
    const identity = (await app.ctx.sso.getIdentities(1))[0]
    const expired = await app.ctx.sso.createSession(1, identity.id)
    await app.ctx.database.set('sso.session', { token: expired }, { expiresAt: new Date(0) })
    for (const method of ['getImageStorage', 'deleteImageStorage']) {
      expect(await app.call(method, expired)).toMatchObject({ ok: false, message: expect.stringContaining('登录已失效') })
    }
    await app.pending()
    const fresh = await app.ctx.sso.createSession(1, identity.id)
    expect(await app.call('deleteImageStorage', fresh, { conversationId: 'secret-group' }))
      .toMatchObject({ ok: true, value: { count: 0, bytes: 0 } })
    expect(await app.ctx.database.get('mtproto_image_storage', { id: app.id })).toMatchObject([{ state: 'deleted' }])
  })

  it('空管理员白名单在已登录时仍拒绝管理，不把普通注册用户当管理员', async () => {
    const app = await fixture([])
    const tokens = await app.sso()
    for (const method of ['getImageStorage', 'deleteImageStorage']) {
      expect(await app.call(method, tokens.admin)).toMatchObject({ ok: false, message: expect.stringContaining('imageStorage.adminUserIds') })
    }
    await app.pending()
  })
})
