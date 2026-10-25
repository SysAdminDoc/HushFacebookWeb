// Where settings are kept.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGmStorage, createLocalStorage, UNKEPT_SETTINGS } from '../src/core/storage.js';
import { ACTIVITY_KEYS, activityKeyFor, createActivityStorage } from '../src/core/activity.js';

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

test('the GM private flag isolates activity before manager reads or watched journal operations', async () => {
  const names = ['GM_info', 'GM', 'GM_getValue', 'GM_setValue', 'GM_listValues'];
  const originals = new Map(names.filter((name) => Object.hasOwn(globalThis, name)).map((name) => [name, globalThis[name]]));
  try {
    for (const flag of [true, undefined, false]) {
      const account = '615000000000041';
      const saved = new Map(ACTIVITY_KEYS.flatMap((key) => [[key, 1], [activityKeyFor(key, account), 2]]));
      const touched = [];
      globalThis.GM_info = flag === undefined ? { scriptHandler: 'Unknown manager' } : { scriptHandler: 'Violentmonkey', isIncognito: flag };
      globalThis.GM_getValue = (key, fallback) => { touched.push(['get', key]); return saved.has(key) ? structuredClone(saved.get(key)) : fallback; };
      globalThis.GM_setValue = (key, value) => { touched.push(['set', key]); saved.set(key, structuredClone(value)); };
      globalThis.GM_listValues = () => { touched.push(['list']); return [...saved.keys()]; };
      globalThis.GM = {
        async setValue(key, value) { touched.push(['async set', key]); saved.set(key, structuredClone(value)); },
        async deleteValue(key) { touched.push(['delete', key]); saved.delete(key); },
      };
      const storage = createGmStorage();
      const activity = createActivityStorage({ storage, account });
      assert.equal(activity.context(), flag === true ? 'private' : flag === false ? 'normal' : 'unknown');
      if (flag === false) {
        assert.equal(storage.watchedSupported, true);
        assert.equal(activity.storage.get('keepSpeed.rate'), 2);
        continue;
      }
      for (const key of ACTIVITY_KEYS) {
        assert.equal(activity.storage.get(key, 'empty'), 'empty');
        activity.storage.set(key, 3);
        await activity.storage.remove(key);
      }
      await activity.storage.mutate('rememberWatched.list', { watched: { add: { kind: 'video', id: '1234567890', at: 100 } } });
      assert.equal(activity.legacy(), null);
      assert.deepEqual(touched, [], 'GM activity values and journal keys never get read or changed');
      activity.storage.set('settings', { paused: true });
      assert.deepEqual(storage.get('settings'), { paused: true }, 'the manager still saves settings');
    }
  } finally {
    for (const name of names) {
      if (originals.has(name)) globalThis[name] = originals.get(name);
      else delete globalThis[name];
    }
  }
});

test('legacy activity deletion propagates a modern GM rejection and retries its missing cached key', async () => {
  const names = ['GM_info', 'GM', 'GM_getValue', 'GM_setValue', 'GM_deleteValue'];
  const originals = new Map(names.filter((name) => Object.hasOwn(globalThis, name)).map((name) => [name, globalThis[name]]));
  const backend = new Map([['keepSpeed.rate', 1.5]]);
  const cache = new Map(backend);
  let legacyDeletes = 0;
  let modernDeletes = 0;
  let rejectDelete = true;
  try {
    globalThis.GM_info = { scriptHandler: 'Violentmonkey', isIncognito: false };
    globalThis.GM_getValue = (key, fallback) => cache.has(key) ? cache.get(key) : fallback;
    globalThis.GM_setValue = (key, value) => { cache.set(key, value); backend.set(key, value); };
    globalThis.GM_deleteValue = (key) => { legacyDeletes++; cache.delete(key); backend.delete(key); };
    globalThis.GM = { async deleteValue(key) {
      modernDeletes++;
      cache.delete(key);
      if (rejectDelete) throw new Error('manager storage unavailable');
      backend.delete(key);
    } };
    const activity = createActivityStorage({ storage: createGmStorage(), account: '615000000000041' });
    await assert.rejects(async () => activity.clearLegacy(), /manager storage unavailable/);
    assert.equal(modernDeletes, 1);
    assert.equal(legacyDeletes, 0, 'the void API cannot confirm the operation');
    assert.equal(backend.get('keepSpeed.rate'), 1.5);
    assert.equal(activity.legacy().speed, true, 'the cached deletion never hides the retry control');
    rejectDelete = false;
    const undo = await activity.clearLegacy();
    assert.equal(modernDeletes, 2, 'the missing cached key is explicitly retried');
    assert.equal(backend.has('keepSpeed.rate'), false);
    await undo();
    assert.equal(backend.get('keepSpeed.rate'), 1.5);
  } finally {
    for (const name of names) {
      if (originals.has(name)) globalThis[name] = originals.get(name);
      else delete globalThis[name];
    }
  }
});

test('a cache-first GM restore failure never turns into a false successful Undo', async () => {
  const names = ['GM_info', 'GM', 'GM_getValue', 'GM_setValue'];
  const originals = new Map(names.filter((name) => Object.hasOwn(globalThis, name)).map((name) => [name, globalThis[name]]));
  const backend = new Map([['keepSpeed.rate', 1.5]]);
  const cache = new Map(backend);
  let fail = true;
  let writes = 0;
  try {
    globalThis.GM_info = { scriptHandler: 'Violentmonkey', isIncognito: false };
    globalThis.GM_getValue = (key, fallback) => cache.has(key) ? cache.get(key) : fallback;
    globalThis.GM_setValue = (key, value) => { cache.set(key, value); backend.set(key, value); };
    globalThis.GM = {
      async deleteValue(key) { cache.delete(key); backend.delete(key); },
      async setValue(key, value) {
        if (JSON.stringify(cache.get(key)) === JSON.stringify(value)) return;
        cache.set(key, structuredClone(value));
        writes++;
        if (fail) throw new Error('manager storage unavailable');
        backend.set(key, structuredClone(value));
      },
    };
    const activity = createActivityStorage({ storage: createGmStorage(), account: '615000000000041' });
    const undo = await activity.clearLegacy();
    await assert.rejects(undo, /manager storage unavailable/);
    fail = false;
    await assert.rejects(undo, /unconfirmed/i, 'a cached no-op must not dismiss Undo');
    assert.equal(backend.has('keepSpeed.rate'), false);
    assert.equal(writes, 1, 'the manager would skip an unchanged cached write');
    cache.delete('keepSpeed.rate'); // A genuine cache refresh permits a new acknowledged write.
    await undo();
    assert.equal(writes, 2);
    assert.equal(backend.get('keepSpeed.rate'), 1.5);
  } finally {
    for (const name of names) {
      if (originals.has(name)) globalThis[name] = originals.get(name);
      else delete globalThis[name];
    }
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
