// Turns a raw capture from captures/ (never committed) into a scrubbed fixture under
// tests/fixtures/. See scripts/lib/scrub.mjs for what gets replaced.
//
//   node scripts/scrub-fixture.mjs <body.txt> --out tests/fixtures/<name>.jsonl
//        [--lines 0,6,22] [--trim data.results.edges=0,1,2]...
//   node scripts/scrub-fixture.mjs <page.html> --html --match CometModernHomeFeedQuery
//        [--index 0,3] --out tests/fixtures/<name>.jsonl
//   node scripts/scrub-fixture.mjs <network.jsonl> --request --friendly <name>
//        --out tests/fixtures/<name>.request.jsonl
//
// A body file holds one JSON document per line (Facebook streams @defer and @stream
// chunks that way). A page gives one line per data-sjs block that mentions --match. A
// request fixture keeps the fields of each matching network.jsonl record that a request
// rule can see: method, path, friendly name, doc_id and variables.

import { readFile, writeFile } from 'node:fs/promises';
import { extractDataSjs, findLeftovers, scrubLine, scrubValue } from './lib/scrub.mjs';

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
  console.error('usage: scrub-fixture.mjs <capture> --out <fixture.jsonl> [--lines a,b] [--trim path=a,b] | --html --match <text> [--index a,b] | --request --friendly <name>');
  process.exit(2);
}

const raw = await readFile(input, 'utf8');
let lines;

if (flag('html')) {
  const blocks = extractDataSjs(raw, option('match'));
  const picked = option('index') === undefined ? blocks : list(option('index')).map((i) => blocks[i]);
  lines = picked.map((block) => scrubLine(block, { trims }));
} else if (flag('request')) {
  const friendly = option('friendly');
  lines = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => record.friendly === friendly)
    .map(({ method, path, friendly: name, doc_id, variables }) => JSON.stringify(scrubValue({ method, path, friendly: name, doc_id, variables })));
} else {
  const all = raw.split('\n').filter((line) => line.replace(/\r$/, '') !== '');
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
await writeFile(option('out'), text);
console.log(`wrote ${option('out')}: ${lines.length} line(s), ${(text.length / 1024).toFixed(1)} KiB (from ${(raw.length / 1024).toFixed(1)} KiB)`);
