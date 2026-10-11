import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ASSETS, STAGES, bannerVersion, changelogSection, parseSums, record, refusal, sha256, sumsText } from '../scripts/lib/release.mjs';
import { renderMetaBlock } from '../scripts/meta.mjs';

const head = { version: '1.2.3', commit: 'a'.repeat(40) };
const run = (...stages) => stages.reduce((state, stage) => record(state, stage, head), null);

test('the first stage needs nothing, and every later one needs all before it', () => {
  assert.equal(refusal('preflight', null, head), null);
  assert.match(refusal('build', null, head), /--stage preflight for v1\.2\.3 at aaaaaaa first/);
  assert.match(refusal('publish', run('preflight'), head), /--stage build, then --stage notes/);
  assert.equal(refusal('notes', run('preflight', 'build'), head), null);
  assert.equal(refusal('publish', run('preflight', 'build', 'notes'), head), null);
});

test('the live stage needs a build and publish does not need it', () => {
  assert.match(refusal('live', run('preflight'), head), /--stage build/);
  assert.equal(refusal('live', run('preflight', 'build'), head), null);
  assert.equal(refusal('publish', run('preflight', 'build', 'notes'), head), null);
});

test('stages recorded for another commit or version count for nothing', () => {
  const state = run('preflight', 'build', 'notes');
  const moved = { ...head, commit: 'b'.repeat(40) };
  assert.match(refusal('publish', state, moved), /--stage preflight, then --stage build, then --stage notes .* The last run was for v1\.2\.3 at aaaaaaa\./);
  assert.match(refusal('build', state, { ...head, version: '1.2.4' }), /--stage preflight for v1\.2\.4/);
  assert.deepEqual(Object.keys(record(state, 'preflight', moved).stages), ['preflight']);
});

test('running a stage again forgets the ones after it', () => {
  const state = record(run('preflight', 'build', 'live', 'notes'), 'build', head, { sums: { x: 'y' } });
  assert.deepEqual(Object.keys(state.stages).sort(), ['build', 'preflight']);
  assert.deepEqual(state.stages.build.sums, { x: 'y' });
  assert.deepEqual(Object.keys(record(run('preflight', 'build', 'live'), 'notes', head).stages).sort(), ['build', 'live', 'notes', 'preflight']);
});

test('unknown stages are refused by name', () => {
  assert.match(refusal('deploy', null, head), /no "deploy" stage\. Stages: preflight, build, notes, publish, live/);
  assert.deepEqual(STAGES, ['preflight', 'build', 'notes', 'publish']);
});

test('release notes are the whole CHANGELOG section for the version', () => {
  const text = [
    '# Changelog', '', '## Unreleased', '', '* Not yet.', '',
    '## v1.2.3 (2026-10-11)', '', '* First thing.', '* Second thing,', '  wrapped.', '',
    '## v1.2.2 (2026-10-01)', '', '* Older.',
  ].join('\r\n');
  assert.equal(changelogSection(text, '1.2.3'), '* First thing.\n* Second thing,\n  wrapped.\n');
  assert.equal(changelogSection(text, '1.2.2'), '* Older.\n');
  assert.throws(() => changelogSection(text, '1.2'), /no "## v1\.2" section/);
  assert.throws(() => changelogSection(text, '1.2.4'), /no "## v1\.2\.4" section/);
  assert.throws(() => changelogSection('## v1.2.3\n\nNothing listed.\n', '1.2.3'), /has no entries/);
});

test('the real CHANGELOG yields notes for v0.0.1 with every bullet', async () => {
  const text = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const notes = changelogSection(text, '0.0.1');
  const bullets = text.split('## v0.0.1')[1].split('\n## ')[0].split('\n').filter((line) => line.startsWith('* '));
  assert.ok(bullets.length > 3);
  for (const bullet of bullets) assert.ok(notes.includes(bullet), bullet);
});

test('sum files use sha256sum format and read back', () => {
  const entries = ASSETS.map((name) => ({ name, hash: sha256(name) }));
  const text = sumsText(entries);
  assert.match(text, /^[0-9a-f]{64} {2}hushfacebook-web\.user\.js\n[0-9a-f]{64} {2}hushfacebook-web\.meta\.js\n$/);
  assert.deepEqual(parseSums(text), Object.fromEntries(entries.map(({ name, hash }) => [name, hash])));
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('the banner version is read from the metadata block only', () => {
  assert.equal(bannerVersion(`${renderMetaBlock('1.2.3')}\n// @version 9.9.9 in a comment\n`), '1.2.3');
  assert.equal(bannerVersion('(() => {})();'), null);
});
