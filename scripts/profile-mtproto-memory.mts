/** Local-only real TCP/MTProto memory profile. Never run load generation on production. */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { Context, type Fiber } from 'cordis';
import { Bytes } from '@fuman/io';
import { u8, typed } from '@fuman/utils';
import { IntermediatePacketCodec, ObfuscatedPacketCodec } from '@mtcute/core';
import { NodeCryptoProvider } from '@mtcute/node/utils.js';
import { NodePlatform } from '@mtcute/node';
import { LogManager, createAesIgeForMessage, __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js';
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime';
import Long from 'long';
import { CURRENT_API_LAYER } from '../packages/mtproto/src/rpc/api-layer.js';
import { Mtproto } from '../packages/mtproto/src/service.js';
import { MemoryAuthKeyStore } from '../packages/mtproto/src/session/auth-key-store.js';
const devices = Number(process.env.PROFILE_DEVICES ?? 8);
const rounds = Number(process.env.PROFILE_ROUNDS ?? 64);
const partBytes = Number(process.env.PROFILE_PART_BYTES ?? 524288);
const fullApp = process.env.PROFILE_FULL_APP === '1';
for (const [name, value, maximum] of [['devices', devices, 32], ['rounds', rounds, 512], ['partBytes', partBytes, 1024 * 1024]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new Error('Invalid profile ' + name);
}
const crypto = new NodeCryptoProvider();
await crypto.initialize();
const logs = new LogManager('memory-profile', new NodePlatform());
logs.level = LogManager.OFF;
const log = logs.create('wire');
function keyFor(device: number) { return Uint8Array.from({ length: 256 }, (_, i) => (i + device * 17) & 255); }
function keyId(key: Uint8Array) { return crypto.sha1(key).slice(-8); }
async function server() {
    const store = new MemoryAuthKeyStore();
    for (let i = 0; i < devices; i++) {
        const key = keyFor(i);
        store.save(keyId(key), { key, apiLayer: CURRENT_API_LAYER });
    }
    const ctx = new Context();
    const fiber = ctx.plugin(Mtproto, { port: 0, host: '127.0.0.1', authKeyStore: store, log: logs });
    await fiber;
    const fibers: Fiber[] = [fiber];
    let temporaryDirectory: string | undefined;
    if (fullApp) {
        const [{ default: Database }, { default: SQLite }, { default: Http }, { default: WebUI }, bridge, mergedForward, resources, platform, { default: UpdateStore }] = await Promise.all([
            import('@cordisjs/plugin-database'), import('@cordisjs/plugin-database-sqlite'),
            import('@cordisjs/plugin-server'), import('@cordisjs/plugin-webui'),
            import('../packages/bridge/src/index.js'), import('../packages/merged-forward/src/index.js'),
            import('../packages/telegram-resources/src/index.js'), import('../packages/platform-static/src/index.js'),
            import('../packages/update-store-database/src/index.js'),
        ]);
        const directory = resolve('work/memory-profile');
        await mkdir(directory, { recursive: true });
        temporaryDirectory = await mkdtemp(join(directory, 'wire-app-'));
        fibers.push(ctx.plugin(Database), ctx.plugin(SQLite, { path: ':memory:' }), ctx.plugin(Http, { host: '127.0.0.1', port: 0 }), ctx.plugin(WebUI, { devMode: false, uiPath: '', apiPath: '/api', selfUrl: '' }), ctx.plugin(UpdateStore, { retention: 10000 }), ctx.plugin(bridge, { uploadPath: join(temporaryDirectory, 'uploads') }), ctx.plugin(mergedForward), ctx.plugin(resources), ctx.plugin(platform, { eventIntervalMs: 0, historySize: 10000, mediaPath: join(temporaryDirectory, 'media') }));
        await Promise.all(fibers);
        await sleep(100);
        let identity: any;
        for (let attempt = 0; attempt < 200; attempt++) {
            ;
            [identity] = await ctx.database.get('mtproto_auth_session', { platformId: 'static' });
            if (identity)
                break;
            await sleep(25);
        }
        assert(identity, 'static account was not provisioned');
        for (let i = 0; i < devices; i++) {
            await ctx.database.create('mtproto_auth_binding', {
                authKeyId: Buffer.from(keyId(keyFor(i))).toString('hex'),
                platformId: identity.platformId, platformSessionId: identity.platformSessionId,
            });
        }
    }
    let received = 0, bytes = 0;
    const verifyUpload = (request: any) => {
        const req = request as any;
        assert.equal(req.bytes.length, partBytes);
        const device = req.fileId.toNumber() - 1;
        assert.equal(req.bytes[0], (device + req.filePart) & 255);
        assert.equal(req.bytes[req.bytes.length - 1], (device + req.filePart) & 255);
        received++;
        bytes += req.bytes.length;
    };
    if (fullApp) {
        ctx.on('mtproto/rpc', async (request, next) => {
            const result = await next();
            if (request._ === 'upload.saveFilePart' && (result as any)?._ === 'boolTrue')
                verifyUpload(request);
            return result;
        });
    }
    else {
        ctx.mtproto.register('upload.saveFilePart', async (_rpc, request) => {
            verifyUpload(request);
            return { _: 'boolTrue' } as any;
        });
    }
    const delay = monitorEventLoopDelay({ resolution: 20 });
    delay.enable();
    const sample = (phase: string) => ({ phase, memory: process.memoryUsage(), cpu: process.cpuUsage(), maxRssKiB: process.resourceUsage().maxRSS, received, bytes,
        connections: ctx.mtproto.activeConnectionCount, eventLoopP99Ms: delay.percentile(99) / 1e6,
        obfuscationBuffers: [...(ctx.mtproto as any)._sessions].map((s: any) => { const b = s.connection._codec?._decodeBuf; return b ? { capacity: b.capacity, written: b.written, available: b.available } : null; }) });
    const timer = setInterval(() => process.send?.({ type: 'sample', ...sample('traffic') }), 250);
    let stopping = false;
    const stop = async () => {
        if (stopping) return;
        stopping = true;
        clearInterval(timer);
        delay.disable();
        for (const f of fibers.reverse()) await f.dispose();
        if (temporaryDirectory) {
            const target = await realpath(temporaryDirectory);
            const allowed = await realpath(resolve('work/memory-profile'));
            assert.equal(dirname(target), allowed, 'refusing cleanup outside benchmark workspace');
            await rm(target, { recursive: true, force: true });
        }
        if (process.connected) process.disconnect();
    };
    process.on('disconnect', () => { void stop(); });
    process.on('message', async (message: any) => {
        if (message.type === 'sample')
            process.send?.({ type: 'checkpoint', id: message.id, ...sample(message.phase) });
        if (message.type === 'stop') await stop();
    });
    process.send?.({ type: 'ready', port: ctx.mtproto.port, ...sample('ready') });
}
class Client {
    codec = new ObfuscatedPacketCodec(new IntermediatePacketCodec());
    recv = Bytes.alloc(65536);
    processing = Promise.resolve();
    resolve?: (value: any) => void;
    reject?: (error: Error) => void;
    seq = 0;
    constructor(readonly socket: Socket, readonly device: number) {
        this.codec.setup(crypto, log);
        socket.on('data', (data: Buffer) => {
            this.processing = this.processing.then(async () => {
                this.recv.writeSync(data.length).set(data);
                for (;;) {
                    const frame = await this.codec.decode(this.recv, false);
                    if (!frame)
                        break;
                    this.response(frame);
                }
                this.recv.reclaim();
            }).catch(error => this.reject?.(error));
        });
        socket.on('error', error => this.reject?.(error));
    }
    static async open(port: number, device: number) {
        const socket = connect({ host: '127.0.0.1', port });
        await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
        const c = new Client(socket, device);
        socket.write(await c.codec.tag());
        return c;
    }
    response(frame: Uint8Array) {
        const key = keyFor(this.device), msgKey = frame.subarray(8, 24);
        const plain = createAesIgeForMessage(crypto, key, msgKey, false).decrypt(frame.subarray(24));
        assert(typed.equal(crypto.sha256(u8.concat2(key.subarray(96, 128), plain)).subarray(8, 24), msgKey));
        const reader = new TlBinaryReader(__tlReaderMap, plain, 32);
        if (reader.uint() === 0xf35c6d01) {
            reader.long();
            const kind = reader.uint();
            if (kind === 0x2144ca19)
                throw new Error('RPC error ' + reader.int() + ': ' + reader.string());
            if (kind === 0x997275b5)
                this.resolve?.(true);
            else {
                reader.pos -= 4;
                this.resolve?.(reader.object());
            }
        }
    }
    async upload(round: number) {
        const payload = new Uint8Array(partBytes).fill((this.device + round) & 255);
        assert.equal(await this.rpc({ _: 'upload.saveFilePart', fileId: Long.fromInt(this.device + 1), filePart: round, bytes: payload }), true);
    }
    async rpc(request: any): Promise<any> {
        const body = TlBinaryWriter.serializeObject(__tlWriterMap, request);
        const key = keyFor(this.device), now = Date.now();
        const padding = 12 + ((16 - (32 + body.length + 12) % 16) % 16);
        const writer = TlBinaryWriter.manual(32 + body.length + padding);
        writer.long(Long.ZERO);
        writer.long(Long.fromInt(this.device + 1));
        writer.long(Long.fromBits(((now % 1000) << 21) | ((++this.seq) * 4), Math.floor(now / 1000)));
        writer.uint(this.seq * 2 - 1);
        writer.uint(body.length);
        writer.raw(body);
        writer.raw(crypto.randomBytes(padding));
        const plain = writer.result(), msgKey = crypto.sha256(u8.concat2(key.subarray(88, 120), plain)).subarray(8, 24);
        const encrypted = u8.concat3(keyId(key), msgKey, createAesIgeForMessage(crypto, key, msgKey, true).encrypt(plain));
        const out = Bytes.alloc(encrypted.length + 64);
        await this.codec.encode(encrypted, out);
        return new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('RPC timed out')), 15000);
            this.resolve = value => { clearTimeout(timer); resolve(value); };
            this.reject = e => { clearTimeout(timer); reject(e); };
            this.socket.write(out.result());
        });
    }
}
async function main() {
    const child = fork(fileURLToPath(import.meta.url), ['--server'], { execArgv: ['--import', 'tsx', '--import', '@cordisjs/unyaml'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const samples: any[] = [];
    const checkpoints = new Map<number, (v: any) => void>();
    let checkpointId = 0;
    const startupTimeout = setTimeout(() => child.kill(), 30000);
    const ready = await new Promise<any>((resolve, reject) => {
        child.once('error', error => { clearTimeout(startupTimeout); reject(error); });
        child.once('exit', code => { clearTimeout(startupTimeout); reject(new Error('server exited ' + code)); });
        child.on('message', (msg: any) => { if (msg.type === 'ready') {
            clearTimeout(startupTimeout);
            resolve(msg);
        } if (msg.type === 'sample')
            samples.push(msg); if (msg.type === 'checkpoint') {
            checkpoints.get(msg.id)?.(msg);
            checkpoints.delete(msg.id);
        } });
    });
    const checkpoint = (phase: string) => new Promise<any>(resolve => { const id = ++checkpointId; checkpoints.set(id, resolve); child.send({ type: 'sample', id, phase }); });
    const clients: Client[] = [];
    try {
        for (let i = 0; i < devices; i++)
            clients.push(await Client.open(ready.port, i));
        if (fullApp) {
            for (const client of clients) {
                const dialogs = await client.rpc({ _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
                    offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO });
                assert(dialogs.dialogs?.length > 0, 'dialog hydration failed');
            }
        }
        const started = performance.now();
        for (let round = 0; round < rounds; round++) {
            await Promise.all(clients.map(c => c.upload(round)));
            await sleep(20);
        }
        const elapsedMs = performance.now() - started;
        const loaded = await checkpoint('loaded');
        await sleep(2000);
        const idle = await checkpoint('idle');
        assert.equal(loaded.received, devices * rounds);
        assert.equal(idle.connections, devices);
        console.log(JSON.stringify({ node: process.version, platform: process.platform, fullApp, devices, rounds, partBytes, elapsedMs, ready, loaded, idle, peakRss: Math.max(ready.memory.rss, loaded.memory.rss, idle.memory.rss, idle.maxRssKiB * 1024, ...samples.map(s => s.memory.rss)), samples }, null, 2));
    }
    finally {
        clients.forEach(c => c.socket.destroy());
        if (child.connected)
            child.send({ type: 'stop' });
        const timeout = setTimeout(() => child.kill(), 10000);
        timeout.unref();
        child.once('exit', () => clearTimeout(timeout));
    }
}
if (process.argv.includes('--server'))
    await server();
else
    await main();
