// Pure pieces of the release script: stage order, the state it keeps between stages,
// the CHANGELOG section that becomes the release notes, and SHA-256 sum files.

import { createHash } from 'node:crypto';

// Each stage needs every stage before it, recorded for the same version and commit.
export const STAGES = ['preflight', 'build', 'notes', 'publish'];
// Optional stages that need a build and don't block publishing.
export const EXTRA_STAGES = { live: 'build' };

export const ASSETS = ['hushfacebook-web.user.js', 'hushfacebook-web.meta.js'];
export const SUMS_FILE = 'SHA256SUMS.txt';
export const NOTES_FILE = 'release-notes.txt';

export function isStage(name) {
  return STAGES.includes(name) || Object.hasOwn(EXTRA_STAGES, name);
}

const sameHead = (state, head) => state?.version === head.version && state?.commit === head.commit;

// Returns why a stage can't run yet, or null when it can.
export function refusal(stage, state, head) {
  if (!isStage(stage)) return `There's no "${stage}" stage. Stages: ${[...STAGES, ...Object.keys(EXTRA_STAGES)].join(', ')}.`;
  const needed = Object.hasOwn(EXTRA_STAGES, stage) ? [EXTRA_STAGES[stage]] : STAGES.slice(0, STAGES.indexOf(stage));
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
