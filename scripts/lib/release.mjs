// Pure pieces of the release script: stage order, the state it keeps between stages,
// the CHANGELOG section that becomes the release notes, SHA-256 sum files, and the check
// of what a published release serves.

import { createHash } from 'node:crypto';
import { unzipFile } from '../zip.mjs';

// Each stage needs every stage before it, recorded for the same version and commit.
export const STAGES = ['preflight', 'build', 'notes', 'publish'];
// Stages off that line, each with the one stage it needs.
export const EXTRA_STAGES = { live: 'build' };
// Nothing goes public until the whole script has been walked on Facebook with this build, so
// publish needs the live check too.
export const PUBLISH_NEEDS = ['live'];

export const ASSETS = ['hushfacebook-web.user.js', 'hushfacebook-web.meta.js'];
// The Chrome extension, built from the same source. Its version is in its manifest.
export const EXTENSION_ZIP = 'hushfacebook-web-extension.zip';
// Everything a release carries besides the sums.
export const PUBLISHED = [...ASSETS, EXTENSION_ZIP];
export const SUMS_FILE = 'SHA256SUMS.txt';
export const NOTES_FILE = 'release-notes.txt';

export function isStage(name) {
  return STAGES.includes(name) || Object.hasOwn(EXTRA_STAGES, name);
}

const sameHead = (state, head) => state?.version === head.version && state?.commit === head.commit;

// Returns why a stage can't run yet, or null when it can.
export function refusal(stage, state, head) {
  if (!isStage(stage)) return `There's no "${stage}" stage. Stages: ${[...STAGES, ...Object.keys(EXTRA_STAGES)].join(', ')}.`;
  const needed = Object.hasOwn(EXTRA_STAGES, stage)
    ? [EXTRA_STAGES[stage]]
    : [...STAGES.slice(0, STAGES.indexOf(stage)), ...(stage === 'publish' ? PUBLISH_NEEDS : [])];
  if (!needed.length) return null;
  const done = sameHead(state, head) ? state.stages ?? {} : {};
  const missing = needed.filter((name) => !done[name]);
  if (!missing.length) return null;
  const why = state && !sameHead(state, head) ? ` The last run was for v${state.version} at ${String(state.commit).slice(0, 7)}.` : '';
  return `Run ${missing.map((name) => `--stage ${name}`).join(', then ')} for v${head.version} at ${head.commit.slice(0, 7)} first.${why}`;
}

// Records a stage and forgets every stage after it, since they ran against older output.
export function record(state, stage, head, data = {}) {
  const base = sameHead(state, head) ? state : { version: head.version, commit: head.commit, stages: {} };
  const stages = { ...base.stages, [stage]: { at: new Date().toISOString(), ...data } };
  const index = STAGES.indexOf(stage);
  if (index !== -1) {
    for (const later of STAGES.slice(index + 1)) delete stages[later];
    for (const [extra, after] of Object.entries(EXTRA_STAGES)) if (STAGES.indexOf(after) >= index) delete stages[extra];
  }
  return { version: base.version, commit: base.commit, stages };
}

// The body under "## v<version>" up to the next "## " heading, without the heading itself.
export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const heading = new RegExp(`^## v${version.replaceAll('.', '\\.')}(?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) throw new Error(`CHANGELOG.md has no "## v${version}" section`);
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!/^\s*[*-] /m.test(body)) throw new Error(`The "## v${version}" section of CHANGELOG.md has no entries`);
  return `${body}\n`;
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// The preflight's test run as [command, args]. When NODE_CAPPED_SCRIPT names a PowerShell runner
// that holds node under a hard memory ceiling and a time limit, the suite goes through it, since a
// looping test with no cap once ran a PC out of memory. Without one it's plain `npm test` in a shell.
export function testCommand(env, root) {
  const capped = env.NODE_CAPPED_SCRIPT;
  if (!capped) return ['npm test'];
  return ['pwsh', ['-NoProfile', '-File', capped, '-Repo', root, '-Suite', '-MemoryMB', '1536', '-Seconds', '300', '-Tail', '40']];
}

// sha256sum's format, so `sha256sum -c SHA256SUMS.txt` checks a download.
export function sumsText(entries) {
  return entries.map(({ name, hash }) => `${hash}  ${name}`).join('\n') + '\n';
}

export function parseSums(text) {
  const sums = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64}) [ *](.+)$/);
    if (match) sums[match[2]] = match[1];
  }
  return sums;
}

// The @version line of a built userscript's metadata block.
export function bannerVersion(script) {
  const block = script.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
  return block?.[1].match(/^\/\/ @version\s+(\S+)/m)?.[1] ?? null;
}

// The version in the manifest of an extension zip, or why it couldn't be read.
function zippedVersion(packed) {
  try {
    const manifest = unzipFile(packed, 'manifest.json');
    if (!manifest) return { why: 'has no manifest.json' };
    return { version: JSON.parse(manifest.toString('utf8')).version };
  } catch (error) {
    return { why: `can't be read (${error.message})` };
  }
}

// What's wrong with the files a published release serves, against the sums and version the
// build stage recorded. served maps each asset name to the bytes downloaded back, or to
// undefined when nothing came down. An empty list means GitHub serves exactly the build.
export function servedProblems(served, { sums, version }) {
  const problems = [];
  for (const name of [...PUBLISHED, SUMS_FILE]) {
    if (!served[name]) problems.push(`GitHub doesn't serve ${name}.`);
    else if (sha256(served[name]) !== sums[name]) problems.push(`The ${name} GitHub serves doesn't match the build.`);
  }
  for (const name of ASSETS) {
    if (!served[name]) continue;
    const found = bannerVersion(served[name].toString('utf8'));
    if (found !== version) problems.push(`The served ${name} says @version ${found}, not ${version}.`);
  }
  if (served[EXTENSION_ZIP]) {
    const zipped = zippedVersion(served[EXTENSION_ZIP]);
    if (zipped.why) problems.push(`The served ${EXTENSION_ZIP} ${zipped.why}.`);
    else if (zipped.version !== version) problems.push(`The manifest in the served ${EXTENSION_ZIP} says version ${zipped.version}, not ${version}.`);
  }
  if (served[SUMS_FILE]) {
    const listed = parseSums(served[SUMS_FILE].toString('utf8'));
    for (const name of PUBLISHED) {
      if (!listed[name]) problems.push(`The served ${SUMS_FILE} doesn't list ${name}.`);
      else if (served[name] && listed[name] !== sha256(served[name])) problems.push(`The served ${SUMS_FILE} gives a different sum for ${name} than the file GitHub serves.`);
    }
  }
  return problems;
}
