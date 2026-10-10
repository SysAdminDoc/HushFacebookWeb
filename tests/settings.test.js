import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSchema, createSettings, isValid } from '../src/core/settings.js';
import { createMemoryStorage } from '../src/core/storage.js';

const features = [
  { id: 'alpha', title: 'Alpha', default: true },
  {
    id: 'beta',
    title: 'Beta',
    default: false,
    options: [
      { key: 'order', type: 'select', default: 'newest', choices: [{ value: 'newest', label: 'Newest' }, { value: 'all', label: 'All' }] },
      { key: 'days', type: 'number', default: 7, min: 1, max: 30 },
      { key: 'words', type: 'text', default: '' },
    ],
  },
];

const make = (stored) => {
  const storage = createMemoryStorage(stored ? { settings: stored } : {});
  return { storage, settings: createSettings({ storage, features, version: '0.0.1' }) };
};

test('duplicate keys are refused', () => {
  assert.throws(() => buildSchema([{ id: 'paused', title: 'Clash' }]), /Duplicate setting key: paused/);
});

test('defaults come from the features', () => {
  const { settings } = make();
  assert.equal(settings.get('alpha'), true);
  assert.equal(settings.get('beta'), false);
  assert.equal(settings.get('beta.order'), 'newest');
  assert.equal(settings.get('paused'), false);
  assert.equal(settings.get('ui.launcher'), true);
});

test('only values that differ from the default are stored', () => {
  const { storage, settings } = make();
  settings.set('beta', true);
  settings.set('alpha', true);
  assert.deepEqual(storage.dump().settings, { beta: true });
  settings.set('beta', false);
  assert.deepEqual(storage.dump().settings, {});
});

test('pausing turns every feature off without losing choices', () => {
  const { settings } = make();
  assert.equal(settings.enabled('alpha'), true);
  settings.set('paused', true);
  assert.equal(settings.enabled('alpha'), false);
  assert.equal(settings.get('alpha'), true);
});

test('bad values and unknown keys are refused', () => {
  const { settings } = make();
  assert.throws(() => settings.set('alpha', 'yes'), TypeError);
  assert.throws(() => settings.set('beta.order', 'oldest'), TypeError);
  assert.throws(() => settings.set('beta.days', 31), TypeError);
  assert.throws(() => settings.get('nope'), /Unknown setting/);
});

test('junk in storage is ignored on load', () => {
  const { settings } = make({ alpha: 'broken', beta: true, gone: 1, 'beta.days': 3 });
  assert.equal(settings.get('alpha'), true);
  assert.equal(settings.get('beta'), true);
  assert.equal(settings.get('beta.days'), 3);
});

test('listeners hear which keys changed', () => {
  const { settings } = make();
  const heard = [];
  const stop = settings.subscribe((change) => heard.push(change.keys));
  settings.set('beta', true);
  stop();
  settings.set('beta', false);
  assert.deepEqual(heard, [['beta']]);
});

test('export and import round-trip', () => {
  const first = make().settings;
  first.set('beta', true);
  first.set('beta.words', 'politics\ncrypto');
  const second = make().settings;
  const result = second.importJson(first.exportJson(new Date('2026-10-10T00:00:00Z')));
  assert.deepEqual(result, { applied: ['beta', 'beta.words'], skipped: [] });
  assert.equal(second.get('beta.words'), 'politics\ncrypto');
});

test('import skips what it does not know and refuses non-settings', () => {
  const { settings } = make();
  assert.deepEqual(settings.importJson('{"alpha":false,"zeta":true,"beta.days":0}'), { applied: ['alpha'], skipped: ['zeta', 'beta.days'] });
  assert.equal(settings.get('alpha'), false);
  assert.throws(() => settings.importJson('[1,2]'), TypeError);
  assert.throws(() => settings.importJson('not json'), SyntaxError);
});

test('reset hands back what it cleared so Undo can restore it', () => {
  const { settings } = make();
  settings.set('beta', true);
  const previous = settings.reset();
  assert.equal(settings.get('beta'), false);
  settings.restore(previous);
  assert.equal(settings.get('beta'), true);
});

test('isValid knows every setting type', () => {
  assert.equal(isValid({ type: 'toggle' }, false), true);
  assert.equal(isValid({ type: 'text', maxLength: 3 }, 'abcd'), false);
  assert.equal(isValid({ type: 'number', min: 1 }, Number.NaN), false);
  assert.equal(isValid({ type: 'mystery' }, 1), false);
});
