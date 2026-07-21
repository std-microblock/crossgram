'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  BUILT_IN_IPS,
  DC_STRUCT_LAYOUTS,
  ROUTING_RSA_KEYS,
  findIpStrings,
  findRsaKeys,
  keyKind,
  reformatPem,
} = require('./patch-tdesktop.cjs');

const SCRIPT = join(__dirname, 'patch-tdesktop.cjs');
const LINE_LENGTHS = [64, 64, 64, 64, 64, 40];

function base64WithPrefix(prefix, fill) {
  return prefix + fill.repeat(360 - prefix.length);
}

const RELAY_BASE64 = base64WithPrefix('MIIBCgKCAQEArelay', 'R');
const UNRELATED_BASE64 = base64WithPrefix('MIIBCgKCAQEAunrelated', 'U');

function pem(base64) {
  return reformatPem(base64, LINE_LENGTHS);
}

function routingBase64(prefix, copy) {
  return prefix + String(copy).repeat(360 - prefix.length);
}

function dcStruct(dcIds) {
  const result = Buffer.alloc(dcIds.length * 24);
  dcIds.forEach((dcId, index) => {
    const offset = index * 24;
    result.writeInt32LE(dcId, offset);
    result.writeBigUInt64LE(BigInt(0x2000 + index), offset + 8);
    result.writeInt32LE(443, offset + 16);
  });
  return result;
}

function makeFixture(directory, name) {
  const parts = [Buffer.from('synthetic-fat-binary\0', 'ascii')];
  const portOffsets = [];
  let length = parts[0].length;
  const append = (part) => {
    parts.push(part, Buffer.alloc(13, 0x7f));
    const start = length;
    length += part.length + 13;
    return start;
  };

  for (let copy = 1; copy <= 2; copy++) {
    for (const key of ROUTING_RSA_KEYS) {
      append(Buffer.from(`${pem(routingBase64(key.prefix, copy))}\0`, 'ascii'));
    }
  }
  append(Buffer.from(`${pem(UNRELATED_BASE64)}\0`, 'ascii'));

  for (let copy = 0; copy < 2; copy++) {
    for (const ip of BUILT_IN_IPS) append(Buffer.from(`${ip}\0`, 'ascii'));
  }

  for (let copy = 0; copy < 2; copy++) {
    for (const layout of DC_STRUCT_LAYOUTS) {
      const bytes = dcStruct(layout.dcIds);
      const start = append(bytes);
      layout.dcIds.forEach((_, index) => portOffsets.push(start + index * 24 + 16));
      if (layout.label === 'test IPv4/IPv6') {
        const secondStart = append(dcStruct(layout.dcIds));
        layout.dcIds.forEach((_, index) => portOffsets.push(secondStart + index * 24 + 16));
      }
    }
  }

  const binary = join(directory, name);
  writeFileSync(binary, Buffer.concat(parts));
  return { binary, portOffsets };
}

function run(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('patch-tdesktop CLI', () => {
  it('patches every static and dynamic Telegram route in a fat-binary fixture', () => {
    const directory = mkdtempSync(join(tmpdir(), 'patch-tdesktop-'));
    const keyFile = join(directory, 'relay.pem');
    writeFileSync(keyFile, `${pem(RELAY_BASE64)}\n`);
    const { binary, portOffsets } = makeFixture(directory, 'client.bin');

    const output = run(['--key', keyFile, '--host', '10.1.2.3', '--port', '4444', '--no-resign', '--no-backup', binary]);
    const patched = readFileSync(binary);

    assert.match(output, /RSA keys : 6/);
    assert.match(output, /IPs\s+: 34/);
    assert.match(output, /Ports\s+: 34/);
    assert.match(output, /Verified: no known Telegram route remains \(6 relay key block\(s\)\)/);
    assert.equal(findRsaKeys(patched).filter(key => key.base64 === RELAY_BASE64).length, 6);
    assert.equal(findRsaKeys(patched).filter(key => keyKind(key.base64)).length, 0);
    assert.equal(findRsaKeys(patched).filter(key => key.base64 === UNRELATED_BASE64).length, 1);
    assert.equal(findIpStrings(patched, BUILT_IN_IPS).length, 0);
    assert.equal(findIpStrings(patched, ['10.1.2.3']).length, 34);
    for (const offset of portOffsets) assert.equal(patched.readInt32LE(offset), 4444);

    const rerun = run(['--key', keyFile, '--host', '10.1.2.3', '--port', '4444', '--no-resign', '--no-backup', binary]);
    assert.match(rerun, /Nothing to patch — binary may already be up to date/);
  });

  it('performs full verification in dry-run mode without changing the file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'patch-tdesktop-dry-'));
    const keyFile = join(directory, 'relay.pem');
    writeFileSync(keyFile, `${pem(RELAY_BASE64)}\n`);
    const { binary } = makeFixture(directory, 'client.bin');
    const before = readFileSync(binary);

    const output = run(['--key', keyFile, '--host', '10.1.2.3', '--port', '4444', '--no-resign', '--dry-run', binary]);

    assert.match(output, /Verified: no known Telegram route remains/);
    assert.match(output, /Would patch 74 location\(s\)/);
    assert.deepEqual(readFileSync(binary), before);
  });
});
