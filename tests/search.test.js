// Finding settings by their words, over the real feature list.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { features } from '../src/features/index.js';
import { SECTIONS } from '../src/features/sections.js';
import { findFeatures, searchText } from '../src/ui/search.js';

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
