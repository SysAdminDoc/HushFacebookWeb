// Release in stages, each one refusing to run before the ones it depends on:
//
//   npm run release -- --stage preflight   clean main, unreleased version, notes, lint, tests
//   npm run release -- --stage build       fresh dist/ with SHA256SUMS.txt
//   npm run release -- --stage notes       dist/release-notes.txt from the CHANGELOG section
//   npm run release -- --stage live        the release walk of the build on Facebook, through the build queue
//   npm run release -- --stage publish     needs notes and live, then gh release create and checks what GitHub serves
//
// Add --dry-run to publish to see the gh command without creating anything. Live runs the
// RELEASE_WALK scenarios unless HFW_ONLY names others, and --full runs every one. State lives in
// .release/state.json and is tied to the version and commit, so a new commit starts over.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS, LIVE_BUDGET_MS, NOTES_FILE, PUBLISHED, SUMS_FILE, bannerVersion, changelogSection, isStage, liveCommand, record, refusal, servedProblems, sha256, sumsText, testCommand } from './lib/release.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = path.join(ROOT, 'dist');
const STATE_FILE = path.join(ROOT, '.release', 'state.json');
const PREFLIGHT_BUDGET_MS = 60_000;
const LIVE_SCRIPT = path.join(ROOT, '.claude', 'live-review', 'inject.py');
const LIVE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

class Refused extends Error {}

function parseArgs(argv) {
  const args = { stage: null, dryRun: false, full: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--full') args.full = true;
    else if (arg === '--stage') args.stage = argv[++i] ?? null;
    else if (arg.startsWith('--stage=')) args.stage = arg.slice('--stage='.length);
    else throw new Refused(`Unknown argument: ${arg}`);
  }
  if (!args.stage) throw new Refused('Pick a stage: npm run release -- --stage preflight|build|notes|live|publish');
  if (!isStage(args.stage)) throw new Refused(`There's no "${args.stage}" stage.`);
  return args;
}

function exec(command, args, { allowFail = false } = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    throw new Refused(`${command} ${args.join(' ')} failed:\n${(result.stderr || result.stdout).trim()}`);
  }
  return { status: result.status, out: (result.stdout ?? '').trim() };
}

const git = (...args) => exec('git', args).out;

// A command line runs in a shell. A command with an args list runs as is.
function runVisible(label, command, args) {
  console.log(`\n> ${args ? [command, ...args].join(' ') : command}`);
  const result = args
    ? spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true })
    : spawnSync(command, { cwd: ROOT, stdio: 'inherit', shell: true, windowsHide: true });
  if (result.error) throw new Refused(`${label} couldn't start: ${result.error.message}`);
  if (result.status !== 0) throw new Refused(`${label} failed (exit ${result.status}).`);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function currentHead() {
  const pkg = await readJson(path.join(ROOT, 'package.json'));
  const slug = pkg.repository?.url?.match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1];
  if (!slug) throw new Refused('package.json has no GitHub repository URL');
  return { version: pkg.version, commit: git('rev-parse', 'HEAD'), repo: slug, tag: `v${pkg.version}` };
}

function requireCleanMain() {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') throw new Refused(`Releases come from main, and this is ${branch}.`);
  const dirty = git('status', '--porcelain', '--untracked-files=no');
  if (dirty) throw new Refused(`Commit or drop these changes first:\n${dirty}`);
}

function requireUnreleased(head) {
  if (git('tag', '--list', head.tag)) throw new Refused(`${head.tag} is already tagged here. Bump the version first.`);
  if (exec('git', ['ls-remote', '--tags', 'origin', `refs/tags/${head.tag}`]).out) throw new Refused(`${head.tag} is already tagged on origin. Bump the version first.`);
}

async function hashFiles(names) {
  const sums = {};
  for (const name of names) sums[name] = sha256(await readFile(path.join(DIST, name)));
  return sums;
}

async function requireBuildUnchanged(state) {
  const built = state.stages.build.sums;
  const now = await hashFiles(Object.keys(built));
  const changed = Object.keys(built).filter((name) => built[name] !== now[name]);
  if (changed.length) throw new Refused(`dist/ changed since the build stage (${changed.join(', ')}). Run --stage build again.`);
}

// ---- stages ----

async function preflight(head) {
  requireCleanMain();
  requireUnreleased(head);
  changelogSection(await readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), head.version);
  runVisible('The version check and lint', 'npm run check');
  const capped = process.env.NODE_CAPPED_SCRIPT;
  if (capped && !existsSync(capped)) throw new Refused(`NODE_CAPPED_SCRIPT points at ${capped}, which isn't there.`);
  runVisible('The tests', ...testCommand(process.env, path.resolve(ROOT)));
  return {};
}

async function build(head) {
  requireCleanMain();
  await rm(DIST, { recursive: true, force: true });
  runVisible('The build', 'node scripts/build.mjs');
  for (const name of ASSETS) {
    const found = bannerVersion(await readFile(path.join(DIST, name), 'utf8'));
    if (found !== head.version) throw new Refused(`dist/${name} says @version ${found}, package.json says ${head.version}.`);
  }
  const manifest = await readJson(path.join(DIST, 'extension', 'manifest.json'), {});
  if (manifest.version !== head.version) throw new Refused(`The extension's manifest says version ${manifest.version}, package.json says ${head.version}.`);
  const sums = await hashFiles(PUBLISHED);
  await writeFile(path.join(DIST, SUMS_FILE), sumsText(PUBLISHED.map((name) => ({ name, hash: sums[name] }))));
  console.log(`\n${SUMS_FILE}:\n${PUBLISHED.map((name) => `  ${sums[name]}  ${name}`).join('\n')}`);
  return { sums: { ...sums, [SUMS_FILE]: sha256(await readFile(path.join(DIST, SUMS_FILE))) } };
}

async function notes(head, state) {
  await requireBuildUnchanged(state);
  const text = changelogSection(await readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), head.version);
  await writeFile(path.join(DIST, NOTES_FILE), text);
  console.log(`\ndist/${NOTES_FILE}:\n${text}`);
  return { hash: sha256(text) };
}

async function live(head, state, { full }) {
  await requireBuildUnchanged(state);
  if (!existsSync(LIVE_SCRIPT)) throw new Refused('The live check needs .claude/live-review/inject.py and its signed-in browser profile, which stay on the maintainer\'s PC.');
  const queue = process.env.BUILD_QUEUE_SCRIPT;
  if (!queue || !existsSync(queue)) throw new Refused('Set BUILD_QUEUE_SCRIPT to build-queue.ps1 so the browser check waits its turn.');
  const out = path.join(ROOT, 'captures', `${new Date().toISOString().slice(0, 10)}-release-${head.tag}`);
  await mkdir(out, { recursive: true });
  const only = full ? '' : process.env.HFW_ONLY ?? '';
  let inner;
  try {
    inner = liveCommand({ script: LIVE_SCRIPT, out, userAgent: LIVE_USER_AGENT, only, full });
  } catch (error) {
    throw new Refused(error.message);
  }
  console.log(`\n> build-queue: ${inner}`);
  const started = Date.now();
  const result = spawnSync('pwsh', ['-NoProfile', '-File', queue, '-Label', `hushfacebook-web ${head.tag} live check`, '-Run', inner], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Refused(`The live check failed (exit ${result.status}). Verdicts are in ${path.join(out, 'walk.json')}.`);
  const walk = full ? 'every scenario' : only ? `HFW_ONLY ${only}` : 'release walk';
  if (!full && !only && Date.now() - started > LIVE_BUDGET_MS) console.warn('The release walk went over its 15 minute budget. Find what got slow before the next release.');
  console.log(`\nWalk passed (${walk}). Verdicts: ${path.join(out, 'walk.json')}, results: ${path.join(out, 'results.json')}.`);
  return { out, walk };
}

async function publish(head, state, { dryRun }) {
  requireCleanMain();
  requireUnreleased(head);
  exec('git', ['fetch', '--quiet', 'origin', 'main']);
  if (git('rev-parse', 'origin/main') !== head.commit) throw new Refused('Push main first. GitHub tags the release at the commit that was built.');
  await requireBuildUnchanged(state);
  const notesPath = path.join(DIST, NOTES_FILE);
  if (sha256(await readFile(notesPath, 'utf8')) !== state.stages.notes.hash) throw new Refused(`dist/${NOTES_FILE} changed since the notes stage. Run --stage notes again.`);
  console.log(`Live check for this build: ${state.stages.live.out}`);

  // gh runs from the repo root, so short relative paths keep the printed command readable.
  const files = [...PUBLISHED, SUMS_FILE].map((name) => `dist/${name}`);
  const args = ['release', 'create', head.tag, ...files, '--title', head.tag, '--notes-file', `dist/${NOTES_FILE}`, '--target', head.commit, '--repo', head.repo];
  if (dryRun) {
    console.log(`\nDry run. This would run:\ngh ${args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')}`);
    return null;
  }
  exec('gh', args);

  const names = [...PUBLISHED, SUMS_FILE];
  const listed = JSON.parse(exec('gh', ['release', 'view', head.tag, '--repo', head.repo, '--json', 'assets']).out).assets.map((asset) => asset.name);
  const missing = names.filter((name) => !listed.includes(name));
  if (missing.length) throw new Refused(`${head.tag} is up but GitHub doesn't list ${missing.join(', ')}.`);
  const scratch = await mkdtemp(path.join(tmpdir(), 'hfw-release-'));
  try {
    exec('gh', ['release', 'download', head.tag, '--repo', head.repo, ...names.flatMap((name) => ['--pattern', name]), '--dir', scratch]);
    const served = {};
    for (const name of names) served[name] = existsSync(path.join(scratch, name)) ? await readFile(path.join(scratch, name)) : undefined;
    const problems = servedProblems(served, { sums: state.stages.build.sums, version: head.version });
    if (problems.length) throw new Refused(`${head.tag} is up, but what GitHub serves isn't the build:\n  ${problems.join('\n  ')}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  exec('git', ['fetch', '--quiet', '--tags', 'origin']);
  console.log(`\n${head.tag} is published and GitHub serves the built files.`);
  return { url: `https://github.com/${head.repo}/releases/tag/${head.tag}` };
}

const RUN = { preflight, build, notes, live, publish };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const head = await currentHead();
  const state = await readJson(STATE_FILE, null);
  const why = refusal(args.stage, state, head);
  if (why) throw new Refused(why);
  const started = Date.now();
  const data = await RUN[args.stage](head, state, args);
  const ms = Date.now() - started;
  const seconds = (ms / 1000).toFixed(1);
  if (!data) {
    console.log(`\nDry run of ${args.stage} for ${head.tag} finished in ${seconds} s. Nothing was recorded.`);
    return;
  }
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(record(state, args.stage, head, { ...data, ms }), null, 2)}\n`);
  console.log(`\n${args.stage} for ${head.tag} done in ${seconds} s.`);
  if (args.stage === 'preflight' && ms > PREFLIGHT_BUDGET_MS) console.warn(`Preflight went over its one-minute budget. Find what got slow before the next release.`);
}

main().catch((error) => {
  console.error(error instanceof Refused ? `\nrelease: ${error.message}` : error);
  process.exitCode = 1;
});
