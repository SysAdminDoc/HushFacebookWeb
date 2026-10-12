// Where settings are kept.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGmStorage, createLocalStorage, UNKEPT_SETTINGS } from '../src/core/storage.js';

test('without GM storage the settings fall back to the page, and the warning says why that fails', () => {
  assert.equal(typeof globalThis.GM_getValue, 'undefined');
  assert.equal(createGmStorage().kind, 'localStorage');
  assert.match(UNKEPT_SETTINGS, /clears them within seconds/);
  assert.match(UNKEPT_SETTINGS, /Tampermonkey and Violentmonkey/);
  assert.doesNotMatch(UNKEPT_SETTINGS, /[–—;]/);
});

test('with GM storage the manager keeps them', () => {
  const saved = new Map();
  globalThis.GM_getValue = (key, fallback) => (saved.has(key) ? saved.get(key) : fallback);
  globalThis.GM_setValue = (key, value) => saved.set(key, value);
  try {
    const storage = createGmStorage();
    assert.equal(storage.kind, 'gm');
    storage.set('a', 1);
    assert.equal(storage.get('a', 0), 1);
  } finally {
    delete globalThis.GM_getValue;
    delete globalThis.GM_setValue;
  }
});

test('the page fallback keeps its keys under its own prefix', () => {
  const data = new Map();
  globalThis.localStorage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
  try {
    const storage = createLocalStorage();
    storage.set('settings', { on: true });
    assert.deepEqual([...data.keys()], ['hfw:settings']);
    assert.deepEqual(storage.get('settings', null), { on: true });
    storage.remove('settings');
    assert.equal(storage.get('settings', 'gone'), 'gone');
  } finally {
    delete globalThis.localStorage;
  }
});
