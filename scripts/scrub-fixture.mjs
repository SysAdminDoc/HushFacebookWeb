// Turns a raw capture from captures/ (never committed) into a scrubbed fixture under
// tests/fixtures/. See scripts/lib/scrub.mjs for what gets replaced.
//
//   node scripts/scrub-fixture.mjs <body.txt> --out tests/fixtures/<name>.jsonl
//        [--lines 0,6,22] [--trim data.results.edges=0,1,2]...
//   node scripts/scrub-fixture.mjs <page.html> --html --match CometModernHomeFeedQuery
//        [--index 0,3] --out tests/fixtures/<name>.jsonl
//   node scripts/scrub-fixture.mjs <network.jsonl> --request --friendly <name>
//        --out tests/fixtures/<name>.request.jsonl
//   node scripts/scrub-fixture.mjs <run folder>/organic --dom --out tests/fixtures/organic-posts.jsonl.gz
//
// --dom takes the organic-<source>.json post captures in a folder and writes one line per
// post: { source, width, height, html }, the markup rebuilt by scrubDomTree.
//
// A body file holds one JSON document per line (Facebook streams @defer and @stream
// chunks that way). A page gives one line per data-sjs block that mentions --match. A
// request fixture keeps the fields of each matching network.jsonl record that a request
// rule can see: method, path, friendly name, doc_id and variables.

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { extractDataSjs, findLeftovers, scrubDomTree, scrubLine, scrubValue, setScrubKey } from './lib/scrub.mjs';

// Stand-ins are keyed with a secret that stays beside the raw captures, so a committed
// fixture can't be checked against a guessed id or name. HFW_SCRUB_KEY overrides the file.
// Keep one key for every fixture, or ids won't line up between fixtures.
const KEY_FILE = new URL('../captures/.scrub-key', import.meta.url);
async function loadKey() {
  if (process.env.HFW_SCRUB_KEY) return process.env.HFW_SCRUB_KEY;
  try {
    return (await readFile(KEY_FILE, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const key = randomBytes(32).toString('hex');
    await mkdir(new URL('./', KEY_FILE), { recursive: true });
    await writeFile(KEY_FILE, `${key}\n`, { flag: 'wx' });
    console.error('Made a new scrub key in captures/.scrub-key. Keep it out of git.');
    return key;
  }
}
setScrubKey(await loadKey());

const args = process.argv.slice(2);
const VALUE_OPTIONS = new Set(['--out', '--lines', '--trim', '--match', '--index', '--friendly']);
let input;
for (let i = 0; i < args.length; i++) {
  if (VALUE_OPTIONS.has(args[i])) i++;
  else if (!args[i].startsWith('--')) {
    input = args[i];
    break;
  }
}
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const flag = (name) => args.includes(`--${name}`);
const list = (value) => (value === undefined || value === '' ? [] : value.split(',').map((item) => Number(item)));
const trims = args.flatMap((arg, i) => (arg === '--trim' ? [args[i + 1]] : [])).map((spec) => {
  const [path, keep] = spec.split('=');
  return { path, keep: list(keep) };
});

if (!input || !option('out')) {
  console.error('usage: scrub-fixture.mjs <capture> --out <fixture.jsonl> [--lines a,b] [--trim path=a,b] | --html --match <text> [--index a,b] | --request --friendly <name> | <folder> --dom');
  process.exit(2);
}

const raw = flag('dom') ? '' : await readFile(input, 'utf8');
let lines;

if (flag('dom')) {
  // A folder of organic-<source>.json captures, each a list of { marked, width, height, tree }.
  const files = (await readdir(input)).filter((name) => /^organic-[a-z]+\.json$/.test(name)).sort();
  lines = [];
  for (const name of files) {
    const source = name.slice('organic-'.length, -'.json'.length);
    for (const post of JSON.parse(await readFile(join(input, name), 'utf8'))) {
      lines.push(JSON.stringify({ source, width: post.width, height: post.height, html: scrubDomTree(post.tree) }));
    }
  }
} else if (flag('html')) {
  const blocks = extractDataSjs(raw, option('match'));
  const picked = option('index') === undefined ? blocks : list(option('index')).map((i) => blocks[i]);
  lines = picked.map((block) => scrubLine(block, { trims }));
} else if (flag('request')) {
  const friendly = option('friendly');
  lines = raw
    .split(/\r*\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => record.friendly === friendly)
    .map(({ method, path, friendly: name, doc_id, variables }) => JSON.stringify(scrubValue({ method, path, friendly: name, doc_id, variables })));
} else {
  // Captures written on Windows end lines with CRLF, or CR CR LF when Python's text mode
  // wrote lines that already ended in CRLF. Fixtures are LF only.
  const all = raw.split(/\r*\n/).filter((line) => line !== '');
  const picked = option('lines') === undefined ? all : list(option('lines')).map((i) => all[i]);
  lines = picked.map((line) => scrubLine(line, { trims }));
}

if (!lines.length) {
  console.error('nothing matched, so no fixture was written');
  process.exit(1);
}

const text = `${lines.join('\n')}\n`;
const leftovers = findLeftovers(text);
if (leftovers.length) {
  console.error(`the scrub left something behind, so no fixture was written:\n  ${leftovers.join('\n  ')}`);
  process.exit(1);
}
// A .gz name writes the fixture compressed, for page markup too large to keep as plain text.
const out = option('out').endsWith('.gz') ? gzipSync(text, { level: 9 }) : text;
await writeFile(option('out'), out);
console.log(`wrote ${option('out')}: ${lines.length} line(s), ${(out.length / 1024).toFixed(1)} KiB (from ${(raw.length / 1024).toFixed(1)} KiB)`);
