import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context } from 'cordis'
import { RpcError, type ServerRpcContext } from '@mtproto-relay/mtproto'
import Long from 'long'
import type { BridgeSessionState } from './bridge-service.js'
import { stableId } from './dialogs.js'
import type { IMMedia } from './platform.js'
import type { IMPlatformService } from './platform-manager.js'
import { makeUser } from './synthetic.js'

export interface GroupFilesMiniAppConfig {
  enabled?: boolean
  path?: string
  publicUrl?: string
  secret?: string
  tokenTtlSeconds?: number
}

export interface BrowseToken {
  kind: 'browse'
  platformId: string
  platformSessionId: string
  conversationId: string
  title: string
  exp: number
}

export interface DownloadToken extends Omit<BrowseToken, 'kind' | 'title'> {
  kind: 'download'
  name: string
  media: IMMedia
}

export type MiniAppToken = BrowseToken | DownloadToken
type InputUser = { _: string, userId?: number }
type RequestWebView = { bot: InputUser, peer: Parameters<BridgeSessionState['dialogs']['resolveInputConversation']>[0] }

const BOT_ID = stableId('crossgram:group-files-miniapp')
const BOT_USERNAME = 'crossgram_group_files_bot'

export function registerGroupFilesMiniApp(
  ctx: Context,
  platforms: IMPlatformService,
  resolveSession: (rpc: ServerRpcContext) => Promise<BridgeSessionState>,
  config: GroupFilesMiniAppConfig = {},
): void {
  const enabled = config.enabled ?? true
  const routePath = normalizePath(config.path ?? '/group-files')
  const tokenTtlSeconds = Math.max(60, Math.min(3_600, Math.trunc(config.tokenTtlSeconds ?? 600)))
  const secret = Buffer.from(config.secret || process.env.CROSSGRAM_GROUP_FILES_SECRET || randomBytes(32).toString('base64url'))
  const publicUrl = resolveMiniAppPublicUrl(config.publicUrl || routePath, ctx.server.baseUrl)
  const sign = (payload: MiniAppToken) => signGroupFilesMiniAppToken(payload, secret)
  const verify = (token: string | null): MiniAppToken | undefined => verifyGroupFilesMiniAppToken(token, secret)
  const registerRpc = ctx.mtproto.register.bind(ctx.mtproto) as (
    method: string,
    handler: (rpc: ServerRpcContext, request: unknown) => unknown | Promise<unknown>,
  ) => unknown

  const bot = makeUser({
    id: BOT_ID,
    bot: true,
    firstName: '群文件',
    username: BOT_USERNAME,
  })
  const attachBot = {
    _: 'attachMenuBot',
    showInAttachMenu: true,
    botId: BOT_ID,
    shortName: '群文件',
    peerTypes: [{ _: 'attachMenuPeerTypeChat' }],
    icons: [{
      _: 'attachMenuBotIcon', name: 'default_static',
      icon: { _: 'documentEmpty', id: Long.fromNumber(stableId('crossgram:group-files-miniapp:icon')) },
    }],
  }

  registerRpc('messages.getAttachMenuBots', async () => {
    if (!enabled) return { _: 'attachMenuBots', hash: Long.ZERO, bots: [], users: [] }
    return { _: 'attachMenuBots', hash: Long.fromNumber(BOT_ID), bots: [attachBot], users: [bot] }
  })
  registerRpc('messages.getAttachMenuBot', async (_rpc, request) => {
    if (!enabled || !isGroupFilesBot((request as { bot: InputUser }).bot)) {
      throw new RpcError(400, 'BOT_INVALID')
    }
    return { _: 'attachMenuBotsBot', bot: attachBot, users: [bot] }
  })
  registerRpc('messages.toggleBotInAttachMenu', async () => ({ _: 'boolTrue' }))
  registerRpc('messages.requestWebView', async (rpc, request) => {
    if (!enabled) throw new RpcError(400, 'BOT_INVALID')
    const input = request as RequestWebView
    if (!isGroupFilesBot(input.bot)) throw new RpcError(400, 'BOT_INVALID')
    const state = await resolveSession(rpc)
    if (!state.platform.listGroupFiles) throw new RpcError(400, 'GROUP_FILES_UNAVAILABLE')
    const conversation = await state.dialogs.resolveInputConversation(input.peer)
    if (conversation.kind !== 'group') throw new RpcError(400, 'PEER_ID_INVALID')
    const token = sign({
      kind: 'browse',
      platformId: state.session.platformId,
      platformSessionId: state.session.platformSessionId,
      conversationId: conversation.id,
      title: conversation.title,
      exp: nowSeconds() + tokenTtlSeconds,
    })
    const url = new URL(publicUrl)
    url.searchParams.set('token', token)
    return {
      _: 'webViewResultUrl', fullscreen: true, queryId: Long.fromNumber(stableId(token)), url: url.toString(),
    }
  })

  ctx.server.get(routePath, async (_req, res) => {
    res.headers.set('content-type', 'text/html; charset=utf-8')
    res.headers.set('cache-control', 'no-store')
    res.headers.set('referrer-policy', 'no-referrer')
    res.headers.set('x-content-type-options', 'nosniff')
    res.headers.set('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'self' https://web.telegram.org")
    res.body = GROUP_FILES_MINI_APP_HTML
  })

  ctx.server.get(`${routePath}/api/files`, async (req, res) => {
    const params = requestSearchParams(req.url)
    const token = verify(params.get('token'))
    if (!token || token.kind !== 'browse') return jsonError(res, 401, 'TOKEN_INVALID')
    const binding = activeBinding(platforms, token)
    if (!binding?.platform.listGroupFiles) return jsonError(res, 503, 'GROUP_FILES_UNAVAILABLE')
    const limit = clampInteger(params.get('limit'), 1, 200, 100)
    const page = await binding.platform.listGroupFiles(binding.session, {
      id: token.conversationId,
    }, {
      folderId: params.get('folderId') || undefined,
      cursor: params.get('cursor') || undefined,
      limit,
    })
    const items = page.items.map((item) => item.type === 'folder' ? item : ({
      type: item.type,
      id: item.id,
      parentId: item.parentId,
      name: item.name,
      size: item.size,
      uploadTime: item.uploadTime,
      modifyTime: item.modifyTime,
      expiresAt: item.expiresAt,
      downloadCount: item.downloadCount,
      uploaderId: item.uploaderId,
      uploaderName: item.uploaderName,
      downloadToken: sign({
        kind: 'download',
        platformId: token.platformId,
        platformSessionId: token.platformSessionId,
        conversationId: token.conversationId,
        name: item.name,
        media: item.media,
        exp: nowSeconds() + tokenTtlSeconds,
      }),
    }))
    res.headers.set('cache-control', 'no-store')
    res.json({ title: token.title, items, nextCursor: page.nextCursor, total: page.total })
  })

  ctx.server.get(`${routePath}/api/download`, async (req, res) => {
    const token = verify(requestSearchParams(req.url).get('token'))
    if (!token || token.kind !== 'download') return jsonError(res, 401, 'TOKEN_INVALID')
    const binding = activeBinding(platforms, token)
    if (!binding?.platform.downloadMedia) return jsonError(res, 503, 'DOWNLOAD_UNAVAILABLE')
    const range = parseGroupFilesRange(req.headers.get('range'), token.media.size)
    if (range === false) {
      res.status = 416
      res.headers.set('content-range', `bytes */${token.media.size ?? '*'}`)
      return
    }
    const offset = range?.offset ?? 0
    const limit = range?.limit
    const source = binding.platform.downloadMedia(binding.session, token.media, { offset, limit })
    res.status = range ? 206 : 200
    res.headers.set('content-type', token.media.mimeType ?? 'application/octet-stream')
    res.headers.set('content-disposition', contentDisposition(token.name))
    res.headers.set('accept-ranges', 'bytes')
    res.headers.set('cache-control', 'private, no-store')
    if (range && token.media.size !== undefined) {
      res.headers.set('content-range', `bytes ${range.offset}-${range.offset + range.limit - 1}/${token.media.size}`)
      res.headers.set('content-length', String(range.limit))
    } else if (token.media.size !== undefined) {
      res.headers.set('content-length', String(token.media.size))
    }
    res.body = asyncIterableStream(source)
  })
}

function activeBinding(platforms: IMPlatformService, token: Pick<BrowseToken, 'platformId' | 'platformSessionId'>) {
  return platforms.sessions.find((binding) =>
    binding.session.platformId === token.platformId
    && binding.session.platformSessionId === token.platformSessionId)
}

function isGroupFilesBot(bot: InputUser): boolean {
  return bot._ === 'inputUser' && bot.userId === BOT_ID
}

function normalizePath(value: string): string {
  const path = `/${value}`.replace(/\/+/g, '/').replace(/\/$/, '')
  return path === '' ? '/group-files' : path
}

function resolveMiniAppPublicUrl(value: string, baseUrl: string | URL): string {
  const url = new URL(value, baseUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('groupFilesMiniApp.publicUrl must use HTTP or HTTPS')
  }
  return url.toString()
}

function requestSearchParams(value: unknown): URLSearchParams {
  return new URL(String(value), 'http://localhost').searchParams
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000)
}

export function signGroupFilesMiniAppToken(payload: MiniAppToken, secret: Uint8Array): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${signature}`
}

export function verifyGroupFilesMiniAppToken(token: string | null, secret: Uint8Array): MiniAppToken | undefined {
  if (!token || token.length > 32_768) return
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra) return
  const expected = createHmac('sha256', secret).update(body).digest()
  let actual: Buffer
  try {
    actual = Buffer.from(signature, 'base64url')
  } catch {
    return
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as MiniAppToken
    if (!payload || typeof payload !== 'object' || payload.exp < nowSeconds()) return
    if (payload.kind !== 'browse' && payload.kind !== 'download') return
    if (!payload.platformId || !payload.platformSessionId || !payload.conversationId) return
    return payload
  } catch {
    return
  }
}

function clampInteger(value: string | null, min: number, max: number, fallback: number): number {
  if (value === null || value === '') return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

export function parseGroupFilesRange(value: string | null, size: number | undefined): { offset: number, limit: number } | undefined | false {
  if (!value) return
  const match = /^bytes=(\d+)-(\d*)$/.exec(value.trim())
  if (!match) return false
  const offset = Number(match[1])
  if (!Number.isSafeInteger(offset) || offset < 0 || (size !== undefined && offset >= size)) return false
  const requestedEnd = match[2] ? Number(match[2]) : size === undefined ? offset + 1024 * 1024 - 1 : size - 1
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < offset) return false
  const end = size === undefined ? requestedEnd : Math.min(requestedEnd, size - 1)
  return { offset, limit: end - offset + 1 }
}

function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download'
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function asyncIterableStream(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]()
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel() {
      await iterator.return?.()
    },
  })
}

function jsonError(res: { status: number, json(value: unknown): void }, status: number, error: string): void {
  res.status = status
  res.json({ error })
}

export const GROUP_FILES_MINI_APP_HTML = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>群文件</title><script src="https://telegram.org/js/telegram-web-app.js"></script><style>
:root{color-scheme:light dark;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--tg-theme-bg-color,#f4f5f7);color:var(--tg-theme-text-color,#17191c)}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--tg-theme-bg-color,#f4f5f7)}header{position:sticky;top:0;z-index:3;padding:calc(12px + env(safe-area-inset-top)) 16px 12px;background:color-mix(in srgb,var(--tg-theme-bg-color,#fff) 92%,transparent);backdrop-filter:blur(18px);border-bottom:1px solid color-mix(in srgb,var(--tg-theme-hint-color,#999) 20%,transparent)}.titlebar{display:flex;align-items:center;gap:10px}.back{border:0;background:transparent;color:var(--tg-theme-link-color,#2481cc);font-size:22px;padding:4px 8px;visibility:hidden}.title{font-weight:720;font-size:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.crumb{font-size:12px;color:var(--tg-theme-hint-color,#707579);margin:4px 0 0 46px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.search{display:flex;margin-top:12px;background:var(--tg-theme-secondary-bg-color,#e9ebee);border-radius:12px;padding:9px 12px;gap:8px}.search input{width:100%;border:0;outline:0;background:transparent;color:inherit;font-size:15px}.list{padding:10px 12px 28px}.item{display:grid;grid-template-columns:48px minmax(0,1fr) auto;gap:12px;align-items:center;padding:11px 12px;margin-bottom:8px;border-radius:16px;background:var(--tg-theme-secondary-bg-color,#fff);box-shadow:0 1px 2px rgba(0,0,0,.04);cursor:pointer}.icon{width:48px;height:48px;border-radius:14px;display:grid;place-items:center;font-size:24px;background:color-mix(in srgb,var(--tg-theme-button-color,#2481cc) 14%,transparent)}.folder .icon{background:color-mix(in srgb,#f2b134 20%,transparent)}.name{font-size:15px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta{font-size:12px;color:var(--tg-theme-hint-color,#707579);margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.arrow{color:var(--tg-theme-hint-color,#999);font-size:20px}.state{text-align:center;color:var(--tg-theme-hint-color,#707579);padding:56px 24px}.more{display:block;margin:12px auto;border:0;border-radius:12px;padding:10px 18px;background:var(--tg-theme-button-color,#2481cc);color:var(--tg-theme-button-text-color,#fff);font-weight:650}.hidden{display:none!important}
</style></head><body><header><div class="titlebar"><button class="back" id="back">‹</button><div class="title" id="title">群文件</div></div><div class="crumb" id="crumb">根目录</div><label class="search">⌕<input id="search" placeholder="搜索当前文件夹"></label></header><main class="list" id="list"><div class="state">正在加载群文件…</div></main><button class="more hidden" id="more">加载更多</button><script>
const token=new URL(location.href).searchParams.get('token');const api=new URL('./api/files',location.href);const list=document.querySelector('#list'),more=document.querySelector('#more'),back=document.querySelector('#back'),title=document.querySelector('#title'),crumb=document.querySelector('#crumb'),search=document.querySelector('#search');let stack=[],items=[],cursor;const tg=window.Telegram?.WebApp;tg?.ready();tg?.expand();
function size(n){if(!Number.isFinite(n)||n<=0)return'0 B';const u=['B','KB','MB','GB','TB'];const i=Math.min(u.length-1,Math.floor(Math.log(n)/Math.log(1024)));return(n/1024**i).toFixed(i?1:0)+' '+u[i]}function date(n){return n?new Date(n*1000).toLocaleDateString():''}function esc(v){const d=document.createElement('div');d.textContent=v??'';return d.innerHTML}
function render(){const q=search.value.trim().toLocaleLowerCase();const visible=items.filter(x=>!q||x.name.toLocaleLowerCase().includes(q));list.innerHTML=visible.length?visible.map(x=>x.type==='folder'?'<article class="item folder" data-folder="'+esc(x.id)+'"><div class="icon">📁</div><div><div class="name">'+esc(x.name)+'</div><div class="meta">'+(x.fileCount??0)+' 个文件</div></div><div class="arrow">›</div></article>':'<article class="item" data-download="'+esc(x.downloadToken)+'"><div class="icon">'+(/\.(png|jpe?g|gif|webp)$/i.test(x.name)?'🖼️':'📄')+'</div><div><div class="name">'+esc(x.name)+'</div><div class="meta">'+size(x.size)+' · '+esc(x.uploaderName||x.uploaderId||'未知')+' · '+date(x.uploadTime)+'</div></div><div class="arrow">↓</div></article>').join(''):'<div class="state">这个文件夹里没有匹配的文件</div>';list.querySelectorAll('[data-folder]').forEach(el=>el.onclick=()=>openFolder(el.dataset.folder,el.querySelector('.name').textContent));list.querySelectorAll('[data-download]').forEach(el=>el.onclick=()=>{const u=new URL('./api/download',location.href);u.searchParams.set('token',el.dataset.download);location.href=u});more.classList.toggle('hidden',!cursor)}
async function load(append=false){if(!token){list.innerHTML='<div class="state">链接无效或已过期</div>';return}if(!append)list.innerHTML='<div class="state">正在加载群文件…</div>';const folder=stack.at(-1)?.id;const u=new URL(api);u.searchParams.set('token',token);if(folder)u.searchParams.set('folderId',folder);if(append&&cursor)u.searchParams.set('cursor',cursor);try{const r=await fetch(u);const data=await r.json();if(!r.ok)throw new Error(data.error||'加载失败');title.textContent=data.title||'群文件';items=append?items.concat(data.items):data.items;cursor=data.nextCursor;render()}catch(e){list.innerHTML='<div class="state">'+esc(e.message)+'<br><br><button class="more" onclick="load(false)">重试</button></div>'}}
function openFolder(id,name){stack.push({id,name});items=[];cursor=undefined;crumb.textContent=['根目录',...stack.map(x=>x.name)].join(' / ');back.style.visibility='visible';search.value='';load(false)}back.onclick=()=>{if(!stack.length)return;stack.pop();items=[];cursor=undefined;crumb.textContent=['根目录',...stack.map(x=>x.name)].join(' / ');back.style.visibility=stack.length?'visible':'hidden';search.value='';load(false)};search.oninput=render;more.onclick=()=>load(true);load(false);
</script></body></html>`
