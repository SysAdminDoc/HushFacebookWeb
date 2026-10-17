import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSchema, createSettings } from '../src/core/settings.js';
import { createMemoryStorage } from '../src/core/storage.js';
import { features } from '../src/features/index.js';
import { applyQuickSetup, QUICK_SETUPS } from '../src/ui/quick-setups.js';

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
