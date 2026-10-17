import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSchema, createSettings } from '../src/core/settings.js';
import { createMemoryStorage } from '../src/core/storage.js';
import { features } from '../src/features/index.js';
import { applyQuickSetup, QUICK_SETUPS } from '../src/ui/quick-setups.js';

function acknowledgedStorage(initial = {}) {
  const data = new Map([['settings', structuredClone(initial)]]);
  const mutations = [];
  return {
    data,
    mutations,
    storage: {
      kind: 'extension',
      get: (key, fallback) => data.has(key) ? structuredClone(data.get(key)) : fallback,
      mutate(key, mutation) {
        let resolve;
        let reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        mutations.push({ key, mutation: structuredClone(mutation), resolve, reject });
        return promise;
      },
      onChange() {},
    },
  };
}

test('Quick setup lists contain only real switches', () => {
  const schema = buildSchema(features);
  for (const setup of QUICK_SETUPS.filter((entry) => !entry.reset)) {
    assert.ok(setup.keys.length > 0, `${setup.label} is not empty`);
    for (const key of setup.keys) assert.equal(schema.get(key)?.type, 'toggle', `${setup.label}: ${key}`);
  }
});

test('Quiet and Privacy turn on their switches without changing unrelated choices', () => {
  const settings = createSettings({ storage: createMemoryStorage(), features });
  settings.set('forceDarkMode', true);
  for (const id of ['quiet', 'privacy']) {
    const setup = QUICK_SETUPS.find((entry) => entry.id === id);
    const expected = setup.keys.filter((key) => settings.get(key) !== true).length;
    assert.equal(applyQuickSetup(settings, id), expected);
    assert.ok(setup.keys.every((key) => settings.get(key) === true));
    assert.equal(applyQuickSetup(settings, id), 0, 'reapplying makes no changes');
  }
  assert.equal(settings.get('forceDarkMode'), true);
});

test('Back to defaults resets every changed setting and reports the count', () => {
  const settings = createSettings({ storage: createMemoryStorage(), features });
  settings.set('paused', true);
  settings.set('forceDarkMode', true);
  settings.set('hideTabs.video', false);
  const expected = [...settings.schema].filter(([key, spec]) => settings.get(key) !== spec.default).length;
  assert.equal(applyQuickSetup(settings, 'defaults'), expected);
  assert.ok([...settings.schema].every(([key, spec]) => settings.get(key) === spec.default));
  assert.equal(applyQuickSetup(settings, 'defaults'), 0);
  assert.throws(() => applyQuickSetup(settings, 'missing'), /Unknown Quick setup/);
});

test('Back to defaults clears a rejected acknowledged draft when committed values are defaults', async () => {
  const acknowledged = acknowledgedStorage();
  const settings = createSettings({ storage: acknowledged.storage, features: [{ id: 'alpha', title: 'Alpha', default: false }], migrations: [] });
  const saving = settings.set('alpha', true);
  const rejected = assert.rejects(saving, /quota/i);
  acknowledged.mutations[0].reject(new Error('quota exceeded'));
  await rejected;
  assert.equal(settings.display('alpha'), true);

  const resetting = applyQuickSetup(settings, 'defaults');
  assert.equal(acknowledged.mutations[1].mutation.replace.alpha, undefined);
  acknowledged.data.set('settings', {});
  acknowledged.mutations[1].resolve({});
  assert.equal(await resetting, 1);
  assert.equal(settings.display('alpha'), false);
  assert.deepEqual(settings.saveStatus(), { state: 'idle', error: null, pending: [] });
});

test('a Quick setup clears a rejected opposite draft even when its committed switch is already on', async () => {
  const quiet = QUICK_SETUPS.find((setup) => setup.id === 'quiet');
  const schema = buildSchema(features);
  const acknowledged = acknowledgedStorage(Object.fromEntries(quiet.keys.filter((key) => schema.get(key).default !== true).map((key) => [key, true])));
  const settings = createSettings({ storage: acknowledged.storage, features, migrations: [] });
  const key = quiet.keys[0];
  const saving = settings.set(key, false);
  const rejected = assert.rejects(saving, /quota/i);
  acknowledged.mutations[0].reject(new Error('quota exceeded'));
  await rejected;
  assert.equal(settings.display(key), false);

  assert.equal(applyQuickSetup(settings, 'quiet'), 1);
  assert.equal(settings.display(key), true);
  assert.deepEqual(settings.saveStatus(), { state: 'idle', error: null, pending: [] });
  assert.equal(acknowledged.mutations.length, 1, 'the already-committed value needs no second write');
});
