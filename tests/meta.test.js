import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileName, renderMetaBlock } from '../scripts/meta.mjs';

test('the metadata block is well formed and carries the version', () => {
  const block = renderMetaBlock('1.2.3');
  const lines = block.split('\n');
  assert.equal(lines[0], '// ==UserScript==');
  assert.equal(lines.at(-2), '// ==/UserScript==');
  assert.equal(lines.at(-1), '');
  for (const line of lines.slice(1, -2)) assert.match(line, /^\/\/ @[\w-]+(\s+\S.*)?$/);
  const keys = lines.slice(1, -2).map((line) => line.split(/\s+/)[1]);
  assert.equal(keys[keys.indexOf('@namespace') + 1], '@version');
  assert.match(block, /^\/\/ @version\s+1\.2\.3$/m);
});

test('the script starts at document-start and updates from the release assets', () => {
  const block = renderMetaBlock('1.2.3');
  assert.match(block, /^\/\/ @run-at\s+document-start$/m);
  assert.match(block, new RegExp(`^// @updateURL\\s+\\S+/releases/latest/download/${fileName}\\.meta\\.js$`, 'm'));
  assert.match(block, new RegExp(`^// @downloadURL\\s+\\S+/releases/latest/download/${fileName}\\.user\\.js$`, 'm'));
});
