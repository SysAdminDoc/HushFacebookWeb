// The translation template: every phrase the script can show, followed out of src, and the
// committed translations/template.json kept current with it.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { collectPhrases, templateJson } from '../scripts/lib/phrases.mjs';

const found = await collectPhrases();

test('every t(), plural() and english() call is followed to its words', () => {
  assert.deepEqual(found.unresolved, []);
});

test('the template holds what each kind of call shows, and no names that stay as they are', () => {
  const template = JSON.parse(templateJson(found));
  for (const phrase of [
    'Hide the New message button', // a feature title
    'Hide memories', // an option label built from a table
    'Make Facebook feel like yours.', // a section description from a lookup table
    'Reload', // a toast's button, passed from main.js
    'Copying...', // a busyLabel
    'Downloads', // a Diagnostics row label
    'it took too long', // an error message a toast shows
    "Couldn't find this photo's file.", // a plan's error, from the file it's imported from
    'always-show sites', // a property in the same file
  ]) assert.equal(template[phrase], phrase, phrase);
  assert.deepEqual(template['{count} settings'], { one: '{count} setting', other: '{count} settings' });
  assert.ok(!('{count} setting' in template), 'a plural phrase is keyed by its plural form only');
  for (const name of ['English', 'WhatsApp', 'Ad']) assert.ok(!(name in template), name);
});

test('translations/template.json is current (npm run phrases writes it)', async () => {
  const committed = await readFile(new URL('../translations/template.json', import.meta.url), 'utf8');
  assert.ok(committed === templateJson(found), 'out of date, run npm run phrases');
});
