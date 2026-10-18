// Finding settings by their words, over the real feature list.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { features } from '../src/features/index.js';
import { SECTIONS } from '../src/features/sections.js';
import { findFeatures, matchingAction, searchText } from '../src/ui/search.js';

const ids = (query) => findFeatures(features, SECTIONS, query).map((feature) => feature.id);

test('every word has to appear, in any case and order', () => {
  assert.ok(ids('volume').includes('keepVolume'));
  assert.ok(ids('REMEMBER volume').includes('keepVolume'));
  assert.deepEqual(ids('volume zebra'), []);
  assert.deepEqual(ids('   '), []);
});

test('section names, option labels and choice names are searched too', () => {
  assert.ok(ids('whatsapp').includes('shareSheet'), 'an option label');
  const playback = ids('playback');
  assert.ok(playback.includes('keepSpeed') && playback.includes('keepVolume'), 'the section name');
  assert.ok(searchText({ title: 'Café', description: '', section: 'feed' }, SECTIONS).includes('cafe'), 'accents fold');
});

test("a row's extra words and button words are searched, and the words typed pick its button", () => {
  const row = { id: 'tools', section: 'general', title: 'Back up and restore', description: 'Files.', keywords: ['transfer'], options: [
    { label: 'Open the settings folder' },
    { label: 'Back up settings', focusKey: 'backup', keywords: ['backup', 'export'] },
    { label: 'Reset to defaults', focusKey: 'reset' },
  ] };
  const found = (query) => findFeatures([row], SECTIONS, query).length;
  assert.equal(found('transfer'), 1, "the row's extra words");
  assert.equal(found('EXPORT'), 1, "a button's extra words");
  assert.equal(found('defaults'), 1, 'a button label');
  assert.equal(found('zebra'), 0);
  assert.equal(matchingAction(row, 'backup'), 'backup');
  assert.equal(matchingAction(row, 'reset DEFAULTS'), 'reset');
  assert.equal(matchingAction(row, 'back up restore'), null, 'words spread over the row pick no button');
  assert.equal(matchingAction(row, 'folder'), null, 'a button without its own focus key');
  assert.equal(matchingAction(row, 'settings'), 'backup', 'is passed over for the next one that matches');
  assert.equal(matchingAction(row, '  '), null);
  assert.equal(matchingAction({ id: 'speedy', options: [{ key: 'step', label: 'Speed step' }] }, 'speed'), null, "a feature's options leave its switch focused");
});
