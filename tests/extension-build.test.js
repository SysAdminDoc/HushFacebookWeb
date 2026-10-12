// The extension's manifest and the zip it ships in.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { extensionManifest } from '../scripts/manifest.mjs';
import { zip } from '../scripts/zip.mjs';

test('the manifest runs the isolated half first, the page half in MAIN, at document_start, on the userscript pages', () => {
  const manifest = extensionManifest({ version: '1.2.3' });
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.2.3');
  assert.deepEqual(manifest.permissions, ['storage', 'downloads', 'activeTab', 'alarms']);
  assert.equal(manifest.host_permissions, undefined, 'no host permissions beyond the content scripts');
  const [isolated, main, gameIsolated, gameMain] = manifest.content_scripts;
  assert.deepEqual(isolated.matches, ['https://www.facebook.com/*', 'https://web.facebook.com/*']);
  assert.deepEqual([isolated.js, isolated.world], [['isolated.js'], undefined]);
  assert.deepEqual([main.js, main.world, main.all_frames], [['main.js'], 'MAIN', false]);
  assert.deepEqual(gameIsolated.matches, ['https://*.apps.fbsbx.com/*']);
  assert.deepEqual([gameMain.world, gameMain.all_frames], ['MAIN', true]);
  for (const entry of manifest.content_scripts) assert.equal(entry.run_at, 'document_start');
});

// Reads a zip back through its central directory, the way unzip tools do.
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    files[name] = inflateRawSync(buffer.subarray(start, start + size)).toString('utf8');
    at += 46 + nameLength;
  }
  return files;
}

test('the zip holds every file intact, and the same files give the same zip', () => {
  const files = [
    { name: 'manifest.json', data: Buffer.from('{"version":"1.2.3"}') },
    { name: 'icons/icon-16.png', data: Buffer.from('not really a png') },
    { name: 'main.js', data: Buffer.from('console.log("é");\n'.repeat(50)) },
  ];
  const packed = zip(files);
  assert.deepEqual(unzip(packed), Object.fromEntries(files.map(({ name, data }) => [name, data.toString('utf8')])));
  assert.deepEqual(zip(files), packed);
});
