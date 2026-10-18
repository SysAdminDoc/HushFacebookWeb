import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ASSETS, EXTENSION_ZIP, PUBLISHED, STAGES, SUMS_FILE, bannerVersion, changelogSection, parseSums, record, refusal, servedProblems, sha256, sumsText } from '../scripts/lib/release.mjs';
import { renderMetaBlock } from '../scripts/meta.mjs';
import { zip } from '../scripts/zip.mjs';

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

// A release's four files as the build stage makes them, and the sums it records for them.
function built(version) {
  const files = {
    [ASSETS[0]]: Buffer.from(`${renderMetaBlock(version)}\n(() => {})();\n`),
    [ASSETS[1]]: Buffer.from(`${renderMetaBlock(version)}\n`),
    [EXTENSION_ZIP]: zip([
      { name: 'manifest.json', data: Buffer.from(JSON.stringify({ manifest_version: 3, version })) },
      { name: 'main.js', data: Buffer.from('(() => {})();\n') },
    ]),
  };
  files[SUMS_FILE] = Buffer.from(sumsText(PUBLISHED.map((name) => ({ name, hash: sha256(files[name]) }))));
  return { files, sums: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, sha256(data)])) };
}

const flipped = (data) => Buffer.concat([data.subarray(0, -2), Buffer.from([data.at(-2) ^ 1]), data.subarray(-1)]);

test('a release that serves exactly the build passes', () => {
  const { files, sums } = built('1.2.3');
  assert.deepEqual(servedProblems(files, { sums, version: '1.2.3' }), []);
});

test('a corrupted download of any of the four files fails, not just the script', () => {
  const { files, sums } = built('1.2.3');
  for (const name of [...PUBLISHED, SUMS_FILE]) {
    const problems = servedProblems({ ...files, [name]: flipped(files[name]) }, { sums, version: '1.2.3' });
    assert.ok(problems.includes(`The ${name} GitHub serves doesn't match the build.`), `${name}: ${problems.join(' | ')}`);
  }
  assert.deepEqual(servedProblems({ ...files, [ASSETS[1]]: undefined }, { sums, version: '1.2.3' }), [`GitHub doesn't serve ${ASSETS[1]}.`]);
});

test('files from another version fail on their version as well as their sum', () => {
  const { files, sums } = built('1.2.3');
  const old = built('1.2.2').files;
  assert.deepEqual(servedProblems({ ...files, [ASSETS[1]]: old[ASSETS[1]] }, { sums, version: '1.2.3' }), [
    `The ${ASSETS[1]} GitHub serves doesn't match the build.`,
    `The served ${ASSETS[1]} says @version 1.2.2, not 1.2.3.`,
    `The served ${SUMS_FILE} gives a different sum for ${ASSETS[1]} than the file GitHub serves.`,
  ]);
  assert.deepEqual(servedProblems({ ...files, [EXTENSION_ZIP]: old[EXTENSION_ZIP] }, { sums, version: '1.2.3' }), [
    `The ${EXTENSION_ZIP} GitHub serves doesn't match the build.`,
    `The manifest in the served ${EXTENSION_ZIP} says version 1.2.2, not 1.2.3.`,
    `The served ${SUMS_FILE} gives a different sum for ${EXTENSION_ZIP} than the file GitHub serves.`,
  ]);
});

test('a swapped file with a sums file to match still fails against the recorded build', () => {
  const { files, sums } = built('1.2.3');
  const script = Buffer.from(`${renderMetaBlock('1.2.3')}\n(() => { /* not ours */ })();\n`);
  const swapped = { ...files, [ASSETS[0]]: script };
  swapped[SUMS_FILE] = Buffer.from(sumsText(PUBLISHED.map((name) => ({ name, hash: sha256(swapped[name]) }))));
  assert.deepEqual(servedProblems(swapped, { sums, version: '1.2.3' }), [
    `The ${ASSETS[0]} GitHub serves doesn't match the build.`,
    `The ${SUMS_FILE} GitHub serves doesn't match the build.`,
  ]);
});

test('a sums file that leaves a file out, or a zip that will not open, is named in the failure', () => {
  const { files, sums } = built('1.2.3');
  const short = Buffer.from(files[SUMS_FILE].toString('utf8').split('\n').filter((line) => !line.endsWith(EXTENSION_ZIP)).join('\n'));
  assert.ok(servedProblems({ ...files, [SUMS_FILE]: short }, { sums, version: '1.2.3' }).includes(`The served ${SUMS_FILE} doesn't list ${EXTENSION_ZIP}.`));
  const problems = servedProblems({ ...files, [EXTENSION_ZIP]: Buffer.from('<html>Not Found</html>') }, { sums, version: '1.2.3' });
  assert.ok(problems.includes(`The served ${EXTENSION_ZIP} can't be read (no zip directory).`), problems.join(' | '));
});
