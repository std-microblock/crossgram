#!/usr/bin/env node
'use strict';
/**
 * patch-tdesktop.cjs — redirect a Telegram Desktop fork to a custom MTProto server.
 *
 * Patches three things in the binary, in-place:
 *   1. RSA public keys  — trust the relay and reject Telegram Special Config
 *   2. DC address strings — all built-in IPv4 and IPv6 addresses → --host
 *   3. DC port values   — every production/test BuiltInDc port → --port
 *
 * Supports: Telegram Desktop, AyuGram, MaterialGram, and any TDLib-based fork.
 * Platforms: macOS (.app bundle or raw binary), Linux (ELF), Windows (PE/exe).
 *
 * Usage:
 *   node patch-tdesktop.cjs [options] <binary>
 *
 * Options:
 *   --key  <file>   RSA public key PEM (PKCS#1 "BEGIN RSA PUBLIC KEY")
 *                   Default: auto-detect data/rsa-key.json.pem near this script
 *   --host <ip>     IPv4 address to redirect all DCs to  (default: 127.0.0.1)
 *   --port <n>      Port to redirect all DCs to          (default: 4430)
 *   --no-resign     Skip ad-hoc codesign step (non-macOS or manual signing)
 *   --no-backup     Skip creating <binary>.original backup
 *   --dry-run       Print what would be patched without writing anything
 *   -h, --help      Show this help
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

// ── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    key:    null,
    host:   '127.0.0.1',
    port:   4430,
    resign: true,
    backup: true,
    dryRun: false,
    binary: null,
  };
  const positional = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else if (a === '--key')       { opts.key    = argv[++i]; }
    else if (a === '--host')      { opts.host   = argv[++i]; }
    else if (a === '--port')      { opts.port   = parseInt(argv[++i], 10); }
    else if (a === '--no-resign') { opts.resign = false; }
    else if (a === '--no-backup') { opts.backup = false; }
    else if (a === '--dry-run')   { opts.dryRun = true; }
    else if (a.startsWith('-'))   { die(`Unknown option: ${a}`); }
    else                          { positional.push(a); }
    i++;
  }
  if (positional.length !== 1) { printHelp(); process.exit(1); }
  opts.binary = positional[0];
  return opts;
}

function printHelp() {
  console.log(`
Usage: node patch-tdesktop.cjs [options] <binary>

  <binary>  Path to the app binary, .app bundle (macOS), or .exe (Windows)

Options:
  --key  <file>   RSA public key PEM (PKCS#1 "BEGIN RSA PUBLIC KEY")
                  Default: auto-detect data/rsa-key.json.pem near this script
  --host <ip>     IPv4 to redirect all production DCs to  [127.0.0.1]
  --port <n>      Port to redirect all production DCs to  [4430]
  --no-resign     Skip ad-hoc codesign (Linux/Windows, or sign manually)
  --no-backup     Skip creating <binary>.original backup
  --dry-run       Show what would be patched without writing
  -h, --help      Show this help

Examples:
  # macOS .app bundle, auto-detect key from ./data/rsa-key.json.pem
  node patch-tdesktop.cjs /Applications/materialgram.app

  # Linux binary, custom port
  node patch-tdesktop.cjs --port 1234 /usr/bin/telegram-desktop

  # Windows, external server
  node patch-tdesktop.cjs --host 192.168.1.10 --port 4430 --no-resign "Telegram.exe"
`.trim());
}

function die(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }

// ── Binary path resolution ───────────────────────────────────────────────────

function resolveBinary(supplied) {
  const abs  = path.resolve(supplied);
  if (!fs.existsSync(abs)) die(`Path not found: ${abs}`);
  const stat = fs.statSync(abs);

  // macOS .app bundle
  if (stat.isDirectory() && abs.endsWith('.app')) {
    const appName   = path.basename(abs, '.app');
    const candidate = path.join(abs, 'Contents', 'MacOS', appName);
    if (fs.existsSync(candidate)) return { appRoot: abs, binaryPath: candidate };
    // Binary name differs from bundle name — scan MacOS dir
    const macosDir = path.join(abs, 'Contents', 'MacOS');
    const entries  = fs.readdirSync(macosDir).filter(e => {
      const full = path.join(macosDir, e);
      return fs.statSync(full).isFile() && !e.endsWith('.original');
    });
    if (entries.length === 0) die(`No binary found in ${macosDir}`);
    if (entries.length > 1)  console.warn(`  Warning: multiple files in MacOS dir, using "${entries[0]}"`);
    return { appRoot: abs, binaryPath: path.join(macosDir, entries[0]) };
  }

  // Regular file (Linux ELF, Windows PE, raw Mach-O)
  if (stat.isFile()) return { appRoot: abs, binaryPath: abs };

  die(`${abs} is neither a file nor a .app bundle`);
}

// ── RSA key auto-detection ───────────────────────────────────────────────────

function findKeyFile(scriptDir) {
  const candidates = [
    path.join(scriptDir, '..', 'data', 'rsa-key.json.pem'),
    path.join(scriptDir, 'data', 'rsa-key.json.pem'),
    path.join(process.cwd(), 'data', 'rsa-key.json.pem'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return path.resolve(c);
  return null;
}

// ── Patch helpers ────────────────────────────────────────────────────────────

const RSA_BEGIN = '-----BEGIN RSA PUBLIC KEY-----\n';
const RSA_END   = '-----END RSA PUBLIC KEY-----';

function findRsaKeys(buf) {
  const beginBuf = Buffer.from(RSA_BEGIN, 'ascii');
  const endBuf   = Buffer.from(RSA_END,   'ascii');
  const keys = [];
  let pos = 0;
  while (true) {
    const start = buf.indexOf(beginBuf, pos);
    if (start === -1) break;
    const endStart = buf.indexOf(endBuf, start);
    if (endStart === -1) break;
    const end      = endStart + endBuf.length;
    const keyStr   = buf.slice(start, end).toString('ascii');
    const lines    = keyStr.split('\n');
    const b64Lines = lines.slice(1, -1).filter(l => l.length > 0);
    const base64   = b64Lines.join('');
    keys.push({ offset: start, length: end - start, base64, lineLengths: b64Lines.map(l => l.length) });
    pos = start + 1;
  }
  return keys;
}

function reformatPem(base64, lineLengths) {
  const lines = [RSA_BEGIN.trimEnd()];
  let p = 0;
  for (const len of lineLengths) { lines.push(base64.slice(p, p + len)); p += len; }
  lines.push(RSA_END);
  return lines.join('\n');
}

function findIpStrings(buf, ips) {
  const hits = [];
  for (const ip of ips) {
    const needle = Buffer.from(ip + '\0', 'ascii');
    let pos = 0;
    while (true) {
      const idx = buf.indexOf(needle, pos);
      if (idx === -1) break;
      hits.push({ offset: idx, original: ip, length: needle.length });
      pos = idx + 1;
    }
  }
  hits.sort((a, b) => a.offset - b.offset);
  return hits;
}

/**
 * Find BuiltInDc struct arrays matching dcId sequence [1,2,2,3,4,5] with all ports == oldPort.
 * Struct layout (64-bit): int dcId[0] int _pad[4] ptr ip[8] int port[16] int _pad[20] = 24 bytes
 */
function findDcStructs(buf, expectedDcIds, oldPort) {
  const ENTRY    = 24;
  const PORT_OFF = 16;
  const results  = [];
  const anchor   = Buffer.alloc(8);
  anchor.writeInt32LE(expectedDcIds[0], 0);  // dcId=1, padding=0
  let pos = 0;
  while (true) {
    const base = buf.indexOf(anchor, pos);
    if (base === -1) break;
    pos = base + 1;
    if (base + expectedDcIds.length * ENTRY > buf.length) continue;
    let valid = true;
    const entries = [];
    for (let i = 0; i < expectedDcIds.length; i++) {
      const eb   = base + i * ENTRY;
      const dcId = buf.readInt32LE(eb);
      const pad  = buf.readInt32LE(eb + 4);
      const port = buf.readInt32LE(eb + PORT_OFF);
      const pad2 = buf.readInt32LE(eb + 20);
      if (dcId !== expectedDcIds[i] || pad !== 0 || port !== oldPort || pad2 !== 0) {
        valid = false; break;
      }
      entries.push({ entryOffset: eb, dcId, port });
    }
    if (valid) results.push({ offset: base, entries });
  }
  return results;
}

const BUILT_IN_IPS = [
  // Production IPv4.
  '149.154.175.50', '149.154.167.51', '95.161.76.100',
  '149.154.175.100', '149.154.167.91', '149.154.171.5',
  // Production IPv6. Leaving these intact lets an IPv6-capable client bypass
  // the patched IPv4 entries and connect directly to Telegram.
  '2001:0b28:f23d:f001:0000:0000:0000:000a',
  '2001:067c:04e8:f002:0000:0000:0000:000a',
  '2001:0b28:f23d:f003:0000:0000:0000:000a',
  '2001:067c:04e8:f004:0000:0000:0000:000a',
  '2001:0b28:f23f:f005:0000:0000:0000:000a',
  // Test IPv4 and IPv6.
  '149.154.175.10', '149.154.167.40', '149.154.175.117',
  '2001:0b28:f23d:f001:0000:0000:0000:000e',
  '2001:067c:04e8:f002:0000:0000:0000:000e',
  '2001:0b28:f23d:f003:0000:0000:0000:000e',
];

// Match exact Telegram keys rather than every RSA-2048 PEM in a fork. The
// Special Config key decrypts cloud-fetched help.configSimple payloads; replacing
// it prevents those payloads from injecting fresh official DC addresses.
const ROUTING_RSA_KEYS = [
  { label: 'special config', prefix: 'MIIBCgKCAQEAyr+18Rex2ohtVy8sroGPBwXD3DOo' },
  { label: 'test MTProto', prefix: 'MIIBCgKCAQEAyMEdY1aR+sCR3ZSJrtztKTKqigvO' },
  { label: 'production MTProto', prefix: 'MIIBCgKCAQEA6LszBcC1LGzyr992NzE0ieY+BSaO' },
];

// Longest sequences go first. Patching them before [1,2,3] prevents the test
// pattern from also matching the prefix of the production IPv6 array.
const DC_STRUCT_LAYOUTS = [
  { label: 'production IPv4', dcIds: [1, 2, 2, 3, 4, 5] },
  { label: 'production IPv6', dcIds: [1, 2, 3, 4, 5] },
  { label: 'test IPv4/IPv6', dcIds: [1, 2, 3] },
];
const OLD_PORT = 443;

function keyKind(base64) {
  return ROUTING_RSA_KEYS.find(({ prefix }) => base64.startsWith(prefix));
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);

  const { appRoot, binaryPath } = resolveBinary(opts.binary);
  console.log(`Binary: ${binaryPath}`);

  const keyFile = opts.key || findKeyFile(__dirname);
  if (!keyFile) die('RSA public key not found. Pass --key <file> or place it at data/rsa-key.json.pem');
  console.log(`RSA key: ${keyFile}`);

  const newPem    = fs.readFileSync(keyFile, 'utf8').trim();
  const newBase64 = newPem.split('\n').filter(l => !l.startsWith('-----')).join('');
  if (newBase64.length !== 360)
    die(`Key at ${keyFile} has ${newBase64.length} base64 chars; expected 360 (RSA-2048 PKCS#1)`);

  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(opts.host)) die(`--host must be an IPv4 address, got: ${opts.host}`);
  if (Buffer.byteLength(opts.host + '\0') > 14)    die(`--host "${opts.host}" too long (max 13 chars + null)`);
  if (isNaN(opts.port) || opts.port < 1 || opts.port > 65535) die(`--port must be 1–65535`);

  console.log(`Redirecting to: ${opts.host}:${opts.port}`);
  if (opts.dryRun) console.log('(dry-run — no files will be modified)');

  const buf = Buffer.from(fs.readFileSync(binaryPath));
  let totalPatches = 0;

  // ── 1. RSA key ───────────────────────────────────────────────────────────────

  console.log('\n=== 1. RSA keys ===');
  const rsaKeys = findRsaKeys(buf);
  console.log(`  Found ${rsaKeys.length} RSA PEM block(s) total`);
  let rsaCount = 0;
  for (const k of rsaKeys) {
    const kind = keyKind(k.base64);
    const alreadyPatched = k.base64 === newBase64;
    const description = kind?.label ?? (alreadyPatched ? 'relay key (already patched)' : `skip (${k.base64.slice(0, 20)}...)`);
    console.log(`  0x${k.offset.toString(16).padStart(9, '0')}: ${k.base64.length}-char b64 — ${description}`);
    if (!kind) continue;
    if (k.base64.length !== newBase64.length)
      die(`Key length mismatch: original ${k.base64.length} vs new ${newBase64.length} chars`);
    const replacement = Buffer.from(reformatPem(newBase64, k.lineLengths), 'ascii');
    if (replacement.length !== k.length)
      die(`PEM byte size mismatch: ${k.length} vs ${replacement.length}`);
    replacement.copy(buf, k.offset);
    rsaCount++;
    totalPatches++;
  }
  console.log(`  Patched: ${rsaCount}`);

  // ── 2. DC address strings ────────────────────────────────────────────────────

  console.log('\n=== 2. DC address strings ===');
  const ipHits = findIpStrings(buf, BUILT_IN_IPS);
  let ipCount = 0;
  for (const h of ipHits) {
    const newBytes = Buffer.alloc(h.length, 0);
    Buffer.from(opts.host + '\0', 'ascii').copy(newBytes);
    console.log(`  0x${h.offset.toString(16).padStart(9, '0')}: "${h.original}" → "${opts.host}"`);
    newBytes.copy(buf, h.offset);
    ipCount++;
    totalPatches++;
  }
  console.log(`  Patched: ${ipCount}`);

  // ── 3. DC port in struct ─────────────────────────────────────────────────────

  console.log(`\n=== 3. DC port (${OLD_PORT} → ${opts.port}) ===`);
  let portCount = 0;
  let structCount = 0;
  for (const layout of DC_STRUCT_LAYOUTS) {
    const structs = findDcStructs(buf, layout.dcIds, OLD_PORT);
    for (const s of structs) {
      console.log(`  ${layout.label} @ 0x${s.offset.toString(16).padStart(9, '0')}: ${s.entries.map(e => `dc${e.dcId}`).join(',')}`);
      for (const e of s.entries) {
        buf.writeInt32LE(opts.port, e.entryOffset + 16);
        portCount++;
        totalPatches++;
      }
      structCount++;
    }
  }
  console.log(`  Patched: ${portCount} port field(s) across ${structCount} struct array(s)`);

  // Verify the in-memory result even during --dry-run. A successful run must not
  // leave any known static or cloud-config route back to Telegram.
  const remainingRoutingKeys = findRsaKeys(buf).filter(k => keyKind(k.base64));
  const remainingIps = findIpStrings(buf, BUILT_IN_IPS);
  const remainingPortStructs = DC_STRUCT_LAYOUTS.flatMap(layout => findDcStructs(buf, layout.dcIds, OLD_PORT));
  const relayKeyCount = findRsaKeys(buf).filter(k => k.base64 === newBase64).length;
  if (remainingRoutingKeys.length || remainingIps.length || remainingPortStructs.length) {
    die(`Verification failed: ${remainingRoutingKeys.length} routing key(s), ${remainingIps.length} address(es), and ${remainingPortStructs.length} port array(s) remain`);
  }
  if (relayKeyCount === 0) {
    die('No Telegram routing RSA key was found; unsupported or already modified binary');
  }
  console.log(`  Verified: no known Telegram route remains (${relayKeyCount} relay key block(s))`);

  // ── Write + sign ─────────────────────────────────────────────────────────────

  if (opts.dryRun) {
    console.log(`\n(dry-run) Would patch ${totalPatches} location(s). No files written.`);
    process.exit(0);
  }

  if (totalPatches === 0) {
    console.log('\nNothing to patch — binary may already be up to date.');
    process.exit(0);
  }

  if (opts.backup) {
    const backupPath = binaryPath + '.original';
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(binaryPath, backupPath);
      console.log(`\nBackup: ${backupPath}`);
    } else {
      console.log(`\nBackup already exists, skipping: ${backupPath}`);
    }
  }

  fs.writeFileSync(binaryPath, buf);
  console.log('Binary written.');

  if (opts.resign && os.platform() === 'darwin') {
    console.log('Re-signing with ad-hoc signature...');
    try {
      execSync(`codesign --force --deep --sign - ${JSON.stringify(appRoot)}`, { stdio: 'inherit' });
      console.log('Signed OK.');
    } catch {
      console.error('codesign failed. Try running with sudo, or pass --no-resign and sign manually.');
      process.exit(1);
    }
    try { execSync(`xattr -dr com.apple.quarantine ${JSON.stringify(appRoot)}`, { stdio: 'pipe' }); } catch {}
  } else if (opts.resign && os.platform() !== 'darwin') {
    console.log('(--resign ignored on non-macOS)');
  }

  console.log(`\n=== Done ===`);
  console.log(`  RSA keys : ${rsaCount}`);
  console.log(`  IPs      : ${ipCount}`);
  console.log(`  Ports    : ${portCount}`);
}

if (require.main === module) main();

module.exports = {
  BUILT_IN_IPS,
  DC_STRUCT_LAYOUTS,
  OLD_PORT,
  ROUTING_RSA_KEYS,
  findDcStructs,
  findIpStrings,
  findRsaKeys,
  keyKind,
  main,
  reformatPem,
};
