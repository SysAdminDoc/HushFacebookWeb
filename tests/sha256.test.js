import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { sha256Hex } from '../src/core/sha256.js';

const reference = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

test('SHA-256 matches the published test vectors', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  assert.equal(sha256Hex('a'.repeat(1000000)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('SHA-256 agrees with Node across block edges and non-ASCII text', () => {
  const inputs = ['943636461527714', '816007231797254', 'é', '日本語', '😀'.repeat(20)];
  // 55, 56 and 64 bytes are where the padding spills into another block.
  for (let length = 0; length <= 130; length++) inputs.push('x'.repeat(length));
  let seed = 7;
  for (let i = 0; i < 200; i++) {
    let text = '';
    const length = i % 97;
    for (let j = 0; j < length; j++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      text += String.fromCodePoint(seed % 3 === 0 ? 0x4e00 + (seed % 500) : 32 + (seed % 95));
    }
    inputs.push(text);
  }
  for (const text of inputs) assert.equal(sha256Hex(text), reference(text), JSON.stringify(text));
});
