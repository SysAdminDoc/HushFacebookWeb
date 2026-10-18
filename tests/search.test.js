// Finding settings by their words, over the real feature list.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setLanguage } from '../src/core/i18n.js';
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

test('in another language the words shown and the English words both find a setting', (t) => {
  t.after(() => setLanguage('en'));
  setLanguage('long-test');
  const row = { id: 'update', section: 'general', title: 'Version {version}', description: 'Installed {current}.', vars: { version: '9.8.7', current: 'today' }, options: [
    { label: 'Check now', focusKey: 'check', keywords: ['refresh'] },
  ] };
  const found = (query) => findFeatures([row], SECTIONS, query).length;
  assert.equal(found('version 9.8.7'), 1, 'English, with its words filled in');
  assert.equal(found('véršîöñ'), 1, 'accented words fold to the letters typed');
  assert.equal(found('one two'), 1, 'words only the shown text has');
  assert.equal(found('{current}'), 0, 'placeholders are never searched as typed');
  assert.equal(matchingAction(row, 'refresh'), 'check');
  assert.equal(matchingAction(row, 'three'), 'check', "a button's shown words pick it too");
  assert.ok(ids('volume').includes('keepVolume'), 'the real list keeps its English words');
});
