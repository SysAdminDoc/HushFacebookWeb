// Writes translations/template.json, the English phrases a translation starts from
// (scripts/lib/phrases.mjs says how they're found), and lists any t() call it couldn't follow.
//   npm run phrases              write it
//   npm run phrases -- --check   exit 1 when the committed one is out of date

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { collectPhrases, templateJson } from './lib/phrases.mjs';

const target = new URL('../translations/template.json', import.meta.url);
const found = await collectPhrases();
const json = templateJson(found);
for (const at of found.unresolved) console.warn(`phrases: can't follow the words at ${at}`);

if (process.argv.includes('--check')) {
  const committed = await readFile(target, 'utf8').catch(() => '');
  if (committed !== json) {
    console.error('phrases: translations/template.json is out of date, run npm run phrases');
    process.exit(1);
  }
  console.log('phrases: translations/template.json is current');
} else {
  await mkdir(new URL('../translations/', import.meta.url), { recursive: true });
  await writeFile(target, json);
  console.log(`phrases: wrote ${found.phrases.length} phrases and ${found.plurals.size} plural phrases to translations/template.json`);
}
