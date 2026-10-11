import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountFromCookie, buildSchema, createSettings, EXPORT_SCHEMA, isValid, olderThan, storageKeyFor } from '../src/core/settings.js';
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

test('the signed-in account comes from the c_user cookie, and nothing else', () => {
  assert.equal(accountFromCookie('datr=abc; c_user=615000000000017; xs=12%3Aabc'), '615000000000017');
  assert.equal(accountFromCookie('c_user=615000000000017'), '615000000000017');
  assert.equal(accountFromCookie('datr=abc; xs=1'), null);
  assert.equal(accountFromCookie('not_c_user=615000000000017'), null);
  assert.equal(accountFromCookie('c_user=deleted'), null);
  assert.equal(accountFromCookie(undefined), null);
});

test('two accounts in one browser keep their own settings, and signed out uses the shared ones', () => {
  const storage = createMemoryStorage();
  const first = createSettings({ storage, features, account: '615000000000017' });
  const second = createSettings({ storage, features, account: '615000000000018' });
  first.set('beta', true);
  second.set('beta.days', 3);
  assert.equal(createSettings({ storage, features, account: '615000000000017' }).get('beta.days'), 7);
  assert.equal(createSettings({ storage, features, account: '615000000000018' }).get('beta'), false);
  const signedOut = createSettings({ storage, features });
  assert.equal(signedOut.perAccount, false);
  assert.equal(signedOut.get('beta'), false);
  assert.equal(first.perAccount, true);
  // The ids themselves are never written down.
  assert.ok(Object.keys(storage.dump()).every((key) => !key.includes('615000000000')));
  assert.notEqual(storageKeyFor('615000000000017'), storageKeyFor('615000000000018'));
});

test('settings from before the switch carry over once to each account seen for the first time', () => {
  const storage = createMemoryStorage({ settings: { beta: true, 'beta.words': 'crypto', junk: 1 } });
  const account = createSettings({ storage, features, account: '615000000000017' });
  assert.equal(account.get('beta'), true);
  assert.equal(account.get('beta.words'), 'crypto');
  assert.deepEqual(storage.dump()[storageKeyFor('615000000000017')], { beta: true, 'beta.words': 'crypto' });
  // From now on the account's own copy counts: changing the shared settings doesn't reach it.
  account.set('beta.words', 'politics');
  createSettings({ storage, features }).set('beta', false);
  const again = createSettings({ storage, features, account: '615000000000017' });
  assert.equal(again.get('beta'), true);
  assert.equal(again.get('beta.words'), 'politics');
  // An account that cleared everything stays cleared rather than picking the shared ones up again.
  const other = createSettings({ storage, features, account: '615000000000018' });
  other.reset();
  createSettings({ storage, features }).set('beta', true);
  assert.equal(createSettings({ storage, features, account: '615000000000018' }).get('beta'), false);
});

test('an export says which schema it uses', () => {
  const { settings } = make();
  const exported = JSON.parse(settings.exportJson(new Date('2026-10-11T00:00:00Z')));
  assert.equal(exported.schema, EXPORT_SCHEMA);
  assert.equal(EXPORT_SCHEMA, 1);
  assert.deepEqual(Object.keys(exported), ['app', 'schema', 'version', 'exported', 'settings']);
});

const adSwitches = [
  { id: 'hideSponsoredPosts', title: 'Feed ads', default: true },
  { id: 'hideSponsoredSearch', title: 'Search ads', default: true },
  { id: 'hideSponsoredMarketplace', title: 'Marketplace ads', default: true },
];

test('the old ad switch turned off carries over to search and Marketplace once', () => {
  const storage = createMemoryStorage({ settings: { hideSponsoredPosts: false } });
  const settings = createSettings({ storage, features: adSwitches });
  assert.equal(settings.get('hideSponsoredSearch'), false);
  assert.equal(settings.get('hideSponsoredMarketplace'), false);
  assert.deepEqual(storage.dump().settings, { hideSponsoredPosts: false, hideSponsoredSearch: false, hideSponsoredMarketplace: false });
  assert.deepEqual(storage.dump()['settings.migrated'], ['split-ad-switch']);
  // Turning search back on sticks: the change doesn't run a second time.
  settings.set('hideSponsoredSearch', true);
  const again = createSettings({ storage, features: adSwitches });
  assert.equal(again.get('hideSponsoredSearch'), true);
  assert.equal(again.get('hideSponsoredMarketplace'), false);
});

test('the ad switch change leaves people who had it on, and new installs, alone for good', () => {
  const kept = createMemoryStorage({ settings: { hideSponsoredPosts: true } });
  assert.equal(createSettings({ storage: kept, features: adSwitches }).get('hideSponsoredSearch'), true);
  const fresh = createMemoryStorage();
  const settings = createSettings({ storage: fresh, features: adSwitches });
  assert.equal(fresh.dump().settings, undefined, 'nothing is written for someone with no settings');
  assert.deepEqual(fresh.dump()['settings.migrated'], ['split-ad-switch']);
  // Feed ads switched off later, by hand, is just that one switch.
  settings.set('hideSponsoredPosts', false);
  const later = createSettings({ storage: fresh, features: adSwitches });
  assert.equal(later.get('hideSponsoredSearch'), true);
  assert.equal(later.get('hideSponsoredMarketplace'), true);
});

test('an explicit search or Marketplace choice wins over the old ad switch', () => {
  const storage = createMemoryStorage({ settings: { hideSponsoredPosts: false, hideSponsoredMarketplace: true } });
  const settings = createSettings({ storage, features: adSwitches });
  assert.equal(settings.get('hideSponsoredSearch'), false);
  assert.equal(settings.get('hideSponsoredMarketplace'), true);
});

test('each account runs the ad switch change once, and a copy of migrated shared settings is not changed again', () => {
  const storage = createMemoryStorage({ settings: { hideSponsoredPosts: false } });
  const shared = createSettings({ storage, features: adSwitches });
  shared.set('hideSponsoredSearch', true);
  const account = createSettings({ storage, features: adSwitches, account: '615000000000017' });
  assert.equal(account.get('hideSponsoredSearch'), true, 'the shared choice made after the change is kept');
  assert.equal(account.get('hideSponsoredMarketplace'), false);
  // An account whose own v0.0.1 settings had feed ads off gets the change on its own key.
  const ownKey = storageKeyFor('615000000000018');
  const old = createMemoryStorage({ [ownKey]: { hideSponsoredPosts: false } });
  const second = createSettings({ storage: old, features: adSwitches, account: '615000000000018' });
  assert.equal(second.get('hideSponsoredSearch'), false);
  assert.deepEqual(old.dump()[`${ownKey}.migrated`], ['split-ad-switch']);
});

test('importing a v0.0.1 export gets the ad switch change, a newer export does not', () => {
  const exported = (version) => JSON.stringify({ app: 'HushFacebook Web', schema: 1, version, settings: { hideSponsoredPosts: false } });
  const old = createSettings({ storage: createMemoryStorage(), features: adSwitches });
  assert.deepEqual(old.importJson(exported('0.0.1')).applied, ['hideSponsoredPosts', 'hideSponsoredSearch', 'hideSponsoredMarketplace']);
  assert.equal(old.get('hideSponsoredSearch'), false);
  const newer = createSettings({ storage: createMemoryStorage(), features: adSwitches });
  newer.importJson(exported('0.0.2'));
  assert.equal(newer.get('hideSponsoredSearch'), true);
  const plain = createSettings({ storage: createMemoryStorage(), features: adSwitches });
  plain.importJson('{"hideSponsoredPosts":false}');
  assert.equal(plain.get('hideSponsoredSearch'), true, 'a bare settings object has no version to go by');
});

test('olderThan compares release numbers and refuses anything else', () => {
  assert.equal(olderThan('0.0.1', '0.0.2'), true);
  assert.equal(olderThan('0.0.2', '0.0.2'), false);
  assert.equal(olderThan('0.1.0', '0.0.2'), false);
  assert.equal(olderThan('0.0.10', '0.0.9'), false);
  assert.equal(olderThan('dev', '0.0.2'), false);
  assert.equal(olderThan(undefined, '0.0.2'), false);
});

test('a stored migration record that is not a list is treated as empty', () => {
  const storage = createMemoryStorage({ settings: { hideSponsoredPosts: false }, 'settings.migrated': 'junk' });
  assert.equal(createSettings({ storage, features: adSwitches }).get('hideSponsoredSearch'), false);
  assert.deepEqual(storage.dump()['settings.migrated'], ['split-ad-switch']);
});

test('isValid knows every setting type', () => {
  assert.equal(isValid({ type: 'toggle' }, false), true);
  assert.equal(isValid({ type: 'text', maxLength: 3 }, 'abcd'), false);
  assert.equal(isValid({ type: 'number', min: 1 }, Number.NaN), false);
  assert.equal(isValid({ type: 'mystery' }, 1), false);
});
