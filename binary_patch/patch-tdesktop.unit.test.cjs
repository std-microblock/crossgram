'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  ROUTING_RSA_KEYS,
  findDcStructs,
  findIpStrings,
  findRsaKeys,
  keyKind,
  reformatPem,
} = require('./patch-tdesktop.cjs');

const LINE_LENGTHS = [64, 64, 64, 64, 64, 40];

function base64WithPrefix(prefix, fill = 'A') {
  return prefix + fill.repeat(360 - prefix.length);
}

function dcStruct(dcIds, port = 443) {
  const result = Buffer.alloc(dcIds.length * 24);
  dcIds.forEach((dcId, index) => {
    const offset = index * 24;
    result.writeInt32LE(dcId, offset);
    result.writeBigUInt64LE(BigInt(0x1000 + index), offset + 8);
    result.writeInt32LE(port, offset + 16);
  });
  return result;
}

describe('RSA key discovery', () => {
  it('finds every PEM and preserves its original line layout', () => {
    const first = base64WithPrefix(ROUTING_RSA_KEYS[0].prefix);
    const second = base64WithPrefix(ROUTING_RSA_KEYS[1].prefix, 'B');
    const bytes = Buffer.from(`prefix\0${reformatPem(first, LINE_LENGTHS)}\0middle\0${reformatPem(second, LINE_LENGTHS)}\0`, 'ascii');

    const found = findRsaKeys(bytes);
    assert.equal(found.length, 2);
    assert.deepEqual(found.map(key => key.base64), [first, second]);
    assert.deepEqual(found[0].lineLengths, LINE_LENGTHS);
    assert.equal(found[0].offset, 7);
  });

  it('targets only known routing keys', () => {
    for (const expected of ROUTING_RSA_KEYS) {
      assert.equal(keyKind(base64WithPrefix(expected.prefix))?.label, expected.label);
    }
    assert.equal(keyKind(base64WithPrefix('MIIBCgKCAQEAunrelated')), undefined);
  });
});

describe('DC address discovery', () => {
  it('requires null-terminated exact matches', () => {
    const bytes = Buffer.from([
      '149.154.175.10',
      '149.154.175.100',
      '149.154.175.10-extra',
      '',
    ].join('\0'), 'ascii');
    const found = findIpStrings(bytes, ['149.154.175.10', '149.154.175.100']);

    assert.deepEqual(found.map(hit => hit.original), ['149.154.175.10', '149.154.175.100']);
    assert.deepEqual(found.map(hit => hit.offset), [0, 15]);
  });
});

describe('BuiltInDc struct discovery', () => {
  it('finds a complete 64-bit struct array and all port offsets', () => {
    const prefix = Buffer.alloc(17, 0x7f);
    const bytes = Buffer.concat([prefix, dcStruct([1, 2, 2, 3, 4, 5]), Buffer.alloc(11, 0x7f)]);
    const found = findDcStructs(bytes, [1, 2, 2, 3, 4, 5], 443);

    assert.equal(found.length, 1);
    assert.equal(found[0].offset, prefix.length);
    assert.deepEqual(found[0].entries.map(entry => entry.entryOffset + 16), [33, 57, 81, 105, 129, 153]);
  });

  it('rejects arrays with a different port or non-zero padding', () => {
    const wrongPort = dcStruct([1, 2, 3], 444);
    const wrongPadding = dcStruct([1, 2, 3]);
    wrongPadding.writeInt32LE(1, 4);

    assert.deepEqual(findDcStructs(wrongPort, [1, 2, 3], 443), []);
    assert.deepEqual(findDcStructs(wrongPadding, [1, 2, 3], 443), []);
  });
});
