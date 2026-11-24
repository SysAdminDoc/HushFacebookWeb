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
    'Only for your own filters', // a choice of one of the script's own settings
    'Make Facebook feel like yours.', // a section description from a lookup table
    'Reload', // a toast's button, passed from main.js
    'Copying...', // a busyLabel
    'Downloads', // a Diagnostics row label
    'Show seen posts in this tab', // a card button's label that follows state
    'Keep hiding the paused lines', // one that only shows now and then
    'it took too long', // an error message a toast shows
    "Couldn't find this photo's file.", // a plan's error, from the file it's imported from
    'always-show sites', // a property in the same file
    'Back a frame', // a floating button's text, through a const in another file
    'Pop out', // one a function gives, called with the video
    'Opening', // a floating button's busyText
    'Saving', // the busyText it has when it's given none
    "Saved activity couldn't be changed in the extension", // a logged error picked from a table by what was written
    'A post/remove listener failed', // one picked by the event
    'A seen-post drop listener failed',
    'shared posts', // a kind of post a filter note names
  ]) assert.equal(template[phrase], phrase, phrase);
  assert.deepEqual(template['{count} settings changed'], { one: '{count} setting changed', other: '{count} settings changed' });
  assert.ok(!('{count} setting changed' in template), 'a plural phrase is keyed by its plural form only');
  for (const name of ['English', 'WhatsApp', 'Ad']) assert.ok(!(name in template), name);
});

test('translations/template.json is current (npm run phrases writes it)', async () => {
  const committed = await readFile(new URL('../translations/template.json', import.meta.url), 'utf8');
  assert.ok(committed === templateJson(found), 'out of date, run npm run phrases');
});

test('settings action failures remain available to translators through the feedback helper', () => {
  for (const phrase of [
    "Couldn't back up settings. Try again",
    "Couldn't restore settings. Choose a valid backup and try again",
    'This activity save is still unconfirmed. Your recovery copy stays here.',
  ]) assert.ok(found.phrases.includes(phrase), phrase);
});

test('fixed validation errors remain in the template when their caller forwards an Error message', () => {
  for (const phrase of [
    'Choose a HushFacebook Web backup in format 1',
    'Choose a settings file smaller than 1 MB',
    'That file has no HushFacebook Web settings in it',
  ]) assert.ok(found.phrases.includes(phrase), phrase);
});
