import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountFromCookie, buildSchema, createSettings, EXPORT_SCHEMA, isValid, olderThan, storageKeyFor } from '../src/core/settings.js';
import { applyObjectMutation, createMemoryStorage } from '../src/core/storage.js';

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

function createAcknowledgedStorage(initial = {}) {
  const data = new Map(Object.entries(structuredClone(initial)));
  const listeners = new Map();
  const mutations = [];
  const storage = {
    kind: 'extension',
    get: (key, fallback) => (data.has(key) ? structuredClone(data.get(key)) : fallback),
    mutate(key, mutation) {
      let accept;
      let reject;
      const promise = new Promise((resolve, fail) => {
        accept = resolve;
        reject = fail;
      });
      mutations.push({
        key,
        mutation: structuredClone(mutation),
        accept(value) {
          const committed = arguments.length ? value : applyObjectMutation(data.get(key), mutation);
          if (committed === undefined) data.delete(key);
          else data.set(key, structuredClone(committed));
          accept(committed === undefined ? undefined : structuredClone(committed));
        },
        reject,
      });
      return promise;
    },
    onChange(key, listener) {
      listeners.set(key, listener);
    },
  };
  return {
    storage,
    mutations,
    dump: () => Object.fromEntries(structuredClone([...data.entries()])),
    remote(key, value) {
      if (value === undefined) data.delete(key);
      else data.set(key, structuredClone(value));
      listeners.get(key)?.(structuredClone(value), { source: 'remote' });
    },
  };
}

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

test('failed writes leave saved and running preferences unchanged and can be retried', () => {
  for (const mutate of [
    (settings) => settings.set('alpha', false),
    (settings) => settings.restore({ alpha: false }),
    (settings) => settings.reset(),
    (settings) => settings.importJson('{"alpha":false,"beta":false}'),
  ]) {
    const storage = createMemoryStorage({ settings: { beta: true } });
    const save = storage.set;
    const settings = createSettings({ storage, features });
    const heard = [];
    settings.subscribe((change) => heard.push(change));
    storage.set = () => { throw new Error('Storage unavailable'); };
    assert.throws(() => mutate(settings), /Storage unavailable/);
    assert.deepEqual(settings.snapshot(), { beta: true });
    assert.equal(settings.display('alpha'), true, 'synchronous manager failures roll the visible choice back');
    assert.deepEqual(settings.saveStatus(), { state: 'idle', error: null, pending: [] });
    assert.deepEqual(storage.dump().settings, { beta: true });
    assert.equal(settings.enabled('beta'), true);
    assert.deepEqual(heard, []);
    storage.set = save;
    mutate(settings);
    assert.equal(heard.length, 1);
    assert.deepEqual(settings.snapshot(), storage.dump().settings);
  }
});

test('a synchronous migration failure leaves manager settings at the committed value', () => {
  const storage = createMemoryStorage();
  storage.mutate = () => { throw new Error('Storage unavailable'); };
  const errors = [];
  const settings = createSettings({
    storage,
    features: [{ id: 'alpha', title: 'Alpha', default: true }],
    migrations: [{ id: 'one', run: (raw) => { raw.alpha = false; } }],
    log: { error: (message, error) => errors.push([message, error]) },
  });

  assert.equal(settings.get('alpha'), true);
  assert.equal(settings.display('alpha'), false, 'the rejected migration remains visible as a retryable draft');
  assert.deepEqual(settings.snapshot(), {});
  assert.deepEqual(settings.saveStatus().pending, ['alpha']);
  assert.equal(storage.dump().settings, undefined);
  assert.equal(storage.dump()['settings.migrated'], undefined);
  assert.equal(errors.length, 1);
});

test('a manager can retry a migration whose settings saved before its receipt failed', () => {
  const storage = createMemoryStorage({ settings: { alpha: false }, 'settings.migrated': [] });
  const mutate = storage.mutate;
  let rejectReceipt = true;
  storage.mutate = (key, mutation) => {
    if (key === 'settings.migrated' && rejectReceipt) throw new Error('receipt unavailable');
    return mutate(key, mutation);
  };
  const settings = createSettings({
    storage,
    features,
    migrations: [{ id: 'one', run: (raw) => { raw.beta = true; } }],
    log: { error() {} },
  });

  assert.deepEqual(settings.snapshot(), { alpha: false }, 'runtime behavior stays on the committed pre-migration record');
  assert.deepEqual(storage.dump().settings, { alpha: false, beta: true }, 'the first settings mutation did commit');
  assert.deepEqual(storage.dump()['settings.migrated'], []);

  rejectReceipt = false;
  settings.retry();
  assert.deepEqual(settings.snapshot(), { alpha: false, beta: true });
  assert.deepEqual(storage.dump()['settings.migrated'], ['one']);
});

test('a committed-value choice overrides a manager migration awaiting its receipt', () => {
  const storage = createMemoryStorage({ settings: {}, 'settings.migrated': [] });
  const mutate = storage.mutate;
  let rejectReceipt = true;
  storage.mutate = (key, mutation) => {
    if (key === 'settings.migrated' && rejectReceipt) throw new Error('receipt unavailable');
    return mutate(key, mutation);
  };
  const settings = createSettings({
    storage,
    features,
    migrations: [{ id: 'one', run: (raw) => { raw.beta = true; } }],
    log: { error() {} },
  });

  assert.equal(settings.get('beta'), false);
  assert.equal(settings.display('beta'), true);
  assert.deepEqual(storage.dump().settings, { beta: true });

  rejectReceipt = false;
  settings.set('beta', false);
  assert.equal(settings.get('beta'), false);
  assert.equal(settings.display('beta'), false);
  assert.deepEqual(storage.dump().settings, {});
  assert.deepEqual(storage.dump()['settings.migrated'], ['one']);
});

test('a synchronous migration receipt failure is reported to the settings caller', () => {
  const account = '615000000000021';
  const accountKey = storageKeyFor(account);
  const receiptKey = `${accountKey}.migrated`;
  const storage = createMemoryStorage({ settings: { source: false }, 'settings.migrated': [] });
  const mutate = storage.mutate;
  let rejectCopy = true;
  let rejectReceipt = true;
  storage.mutate = (key, mutation) => {
    if (key === accountKey && rejectCopy) {
      rejectCopy = false;
      throw new Error('copy unavailable');
    }
    if (key === receiptKey && rejectReceipt) throw new Error('receipt unavailable');
    return mutate(key, mutation);
  };
  const settings = createSettings({
    storage,
    account,
    features: [
      { id: 'source', title: 'Source', default: true },
      { id: 'migrated', title: 'Migrated', default: true },
      { id: 'other', title: 'Other', default: false },
    ],
    migrations: [{ id: 'one', run: (raw) => { raw.migrated = false; } }],
    log: { error() {} },
  });

  assert.throws(() => settings.set('other', true), /receipt unavailable/);
  assert.equal(settings.saveStatus().state, 'error');
  assert.deepEqual(storage.dump()[receiptKey], undefined);

  rejectReceipt = false;
  settings.retry();
  assert.deepEqual(settings.snapshot(), { source: false, migrated: false, other: true });
  assert.deepEqual(storage.dump()[receiptKey], ['one']);
});

test('account inheritance and migration use one manager mutation', () => {
  const inherited = [
    { id: 'source', title: 'Source', default: true },
    { id: 'keep', title: 'Keep', default: false },
    { id: 'migrated', title: 'Migrated', default: true },
    { id: 'other', title: 'Other', default: false },
  ];
  const account = '615000000000020';
  const accountKey = storageKeyFor(account);
  const storage = createMemoryStorage({ settings: { source: false, keep: true } });
  const mutate = storage.mutate;
  let fail = true;
  storage.mutate = (...args) => {
    if (fail) {
      fail = false;
      throw new Error('Storage unavailable');
    }
    return mutate(...args);
  };
  const migrations = [{ id: 'one', run: (raw) => { raw.migrated = false; } }];

  const first = createSettings({ storage, features: inherited, account, migrations, log: { error() {} } });
  assert.deepEqual(first.snapshot(), { source: false, keep: true }, 'failed atomic copy keeps inherited committed behavior');
  assert.equal(storage.dump()[accountKey], undefined);
  assert.equal(storage.dump()[`${accountKey}.migrated`], undefined);

  first.set('other', true);
  assert.deepEqual(first.snapshot(), { source: false, keep: true, migrated: false, other: true });
  assert.deepEqual(storage.dump()[accountKey], { source: false, keep: true, migrated: false, other: true });
  assert.deepEqual(storage.dump()[`${accountKey}.migrated`], ['one']);
  assert.deepEqual(createSettings({ storage, features: inherited, account, migrations }).snapshot(), first.snapshot());
});

test('account inheritance unions source and orphan receipts before running pending migrations', () => {
  const account = '615000000000022';
  const accountKey = storageKeyFor(account);
  const storage = createMemoryStorage({
    settings: { alpha: false },
    'settings.migrated': ['one'],
    [`${accountKey}.migrated`]: [],
  });
  const inherited = [
    { id: 'alpha', title: 'Alpha', default: true },
    { id: 'beta', title: 'Beta', default: false },
  ];
  const migrations = [
    { id: 'one', run: (raw) => { raw.alpha = true; } },
    { id: 'two', run: (raw) => { raw.beta = true; } },
  ];

  const settings = createSettings({ storage, features: inherited, account, migrations });

  assert.deepEqual(settings.snapshot(), { alpha: false, beta: true });
  assert.deepEqual(storage.dump()[accountKey], { alpha: false, beta: true });
  assert.deepEqual(storage.dump()[`${accountKey}.migrated`], ['one', 'two']);
});

test('deleting a live account record restores shared settings through the next edit and reload', async () => {
  const account = '615000000000023';
  const accountKey = storageKeyFor(account);
  const acknowledged = createAcknowledgedStorage({
    settings: { beta: true },
    [accountKey]: { alpha: false },
  });
  const settings = createSettings({
    storage: acknowledged.storage,
    features,
    account,
    migrations: [],
  });

  assert.equal(settings.get('alpha'), false);
  assert.equal(settings.get('beta'), false);
  acknowledged.remote(accountKey, undefined);

  assert.equal(settings.get('alpha'), true);
  assert.equal(settings.get('beta'), true);

  const saving = settings.set('alpha', false);
  assert.deepEqual(acknowledged.mutations[0].mutation.initialize, { beta: true });
  acknowledged.mutations[0].accept();
  await saving;
  assert.deepEqual(acknowledged.dump()[accountKey], { alpha: false, beta: true });

  const reloaded = createSettings({
    storage: acknowledged.storage,
    features,
    account,
    migrations: [],
  });
  assert.equal(reloaded.get('alpha'), false);
  assert.equal(reloaded.get('beta'), true);
});

test('an account edit initializes from shared storage even before its deletion callback arrives', async () => {
  const account = '615000000000032';
  const accountKey = storageKeyFor(account);
  const doneKey = `${accountKey}.migrated`;
  const data = new Map(Object.entries({
    settings: { beta: true },
    'settings.migrated': ['shared'],
    [accountKey]: { 'beta.words': 'account' },
    [doneKey]: ['orphan'],
  }));
  const migrations = [];
  const storage = {
    kind: 'extension',
    get: (name, fallback) => (data.has(name) ? structuredClone(data.get(name)) : fallback),
    onChange() {},
    migrate(name, mutation, receiptKey, receipt, options) {
      migrations.push({ name, mutation: structuredClone(mutation), receiptKey, receipt, options });
      const target = data.get(name);
      const source = target === undefined ? data.get(options.sourceKey) : target;
      const effective = target === undefined ? { ...mutation, initialize: structuredClone(source ?? {}) } : mutation;
      const value = applyObjectMutation(target, effective);
      data.set(name, structuredClone(value));
      data.set(receiptKey, [...new Set([
        ...(Array.isArray(data.get(receiptKey)) ? data.get(receiptKey) : []),
        ...(target === undefined && Array.isArray(data.get(options.sourceDoneKey)) ? data.get(options.sourceDoneKey) : []),
        ...receipt,
      ])]);
      return structuredClone(value);
    },
  };
  const settings = createSettings({ storage, features, account, migrations: [] });

  data.delete(accountKey);
  await settings.set('alpha', false);

  assert.equal(migrations.length, 1);
  assert.deepEqual(migrations[0], {
    name: accountKey,
    mutation: { initialize: {}, set: { alpha: false }, remove: [] },
    receiptKey: doneKey,
    receipt: [],
    options: { sourceKey: 'settings', sourceDoneKey: 'settings.migrated' },
  });
  assert.deepEqual(data.get(accountKey), { alpha: false, beta: true });
  assert.deepEqual(data.get(doneKey), ['orphan', 'shared']);
});

test('a newer account deletion supersedes an in-flight replacement and re-arms inheritance', async () => {
  const account = '615000000000025';
  const accountKey = storageKeyFor(account);
  const acknowledged = createAcknowledgedStorage({
    settings: { beta: true },
    [accountKey]: { alpha: false },
  });
  const settings = createSettings({
    storage: acknowledged.storage,
    features,
    account,
    migrations: [],
  });

  const resetting = settings.reset();
  acknowledged.remote(accountKey, undefined);
  acknowledged.mutations[0].accept(undefined);
  await resetting;

  assert.deepEqual(settings.snapshot(), { beta: true });
  const saving = settings.set('alpha', false);
  assert.deepEqual(acknowledged.mutations[1].mutation.initialize, { beta: true });
  acknowledged.mutations[1].accept();
  await saving;
  assert.deepEqual(acknowledged.dump()[accountKey], { alpha: false, beta: true });
});

test('a malformed live account record re-arms shared inheritance before the next edit', async () => {
  const account = '615000000000024';
  const accountKey = storageKeyFor(account);
  const acknowledged = createAcknowledgedStorage({
    settings: { beta: true },
    [accountKey]: { alpha: false },
  });
  const settings = createSettings({
    storage: acknowledged.storage,
    features,
    account,
    migrations: [],
  });

  acknowledged.remote(accountKey, 'bad');
  assert.equal(settings.get('alpha'), true);
  assert.equal(settings.get('beta'), true);

  const saving = settings.set('alpha', false);
  assert.deepEqual(acknowledged.mutations[0].mutation.initialize, { beta: true });
  acknowledged.mutations[0].accept({ alpha: false, beta: true });
  await saving;
  assert.deepEqual(acknowledged.dump()[accountKey], { alpha: false, beta: true });
});

test('a draft queued before account deletion reinitializes when it flushes afterward', async () => {
  const account = '615000000000026';
  const accountKey = storageKeyFor(account);
  const acknowledged = createAcknowledgedStorage({
    settings: { 'beta.words': 'shared' },
    [accountKey]: { alpha: false },
  });
  const settings = createSettings({
    storage: acknowledged.storage,
    features,
    account,
    migrations: [],
  });

  const first = settings.set('alpha', true);
  const second = settings.set('beta', true);
  acknowledged.remote(accountKey, undefined);
  acknowledged.mutations[0].accept(undefined);
  await first;

  assert.deepEqual(acknowledged.mutations[1].mutation.initialize, { 'beta.words': 'shared' });
  assert.deepEqual(acknowledged.mutations[1].mutation.set, { beta: true });
  acknowledged.mutations[1].accept();
  await second;
  assert.deepEqual(acknowledged.dump()[accountKey], { beta: true, 'beta.words': 'shared' });
});

test('retry after account deletion reinitializes a retained failed draft', async () => {
  const account = '615000000000027';
  const accountKey = storageKeyFor(account);
  const acknowledged = createAcknowledgedStorage({
    settings: { beta: true },
    [accountKey]: { alpha: false },
  });
  const settings = createSettings({
    storage: acknowledged.storage,
    features,
    account,
    migrations: [],
  });

  const saving = settings.set('alpha', true);
  const rejected = assert.rejects(saving, /disconnected/);
  acknowledged.mutations[0].reject(new Error('disconnected'));
  await rejected;
  acknowledged.remote(accountKey, undefined);

  const retrying = settings.retry();
  assert.deepEqual(acknowledged.mutations[1].mutation.initialize, { beta: true });
  acknowledged.mutations[1].accept();
  await retrying;
  assert.deepEqual(acknowledged.dump()[accountKey], { beta: true });
});

test('a stale migration conflict after account deletion rederives from shared settings', async () => {
  const account = '615000000000028';
  const accountKey = storageKeyFor(account);
  const acknowledged = createAcknowledgedStorage({
    settings: { beta: true },
    [accountKey]: { alpha: false },
    [`${accountKey}.migrated`]: [],
  });
  acknowledged.storage.getAtLoad = acknowledged.storage.get;
  acknowledged.storage.whenReady = (run) => run();
  const settings = createSettings({
    storage: acknowledged.storage,
    features,
    account,
    migrations: [{ id: 'one', run: (raw) => { raw['beta.words'] = 'migrated'; } }],
  });

  acknowledged.remote(accountKey, undefined);
  const conflict = new Error('changed while saving');
  conflict.code = 'STORAGE_MIGRATION_CONFLICT';
  conflict.current = { alpha: false };
  conflict.receipt = [];
  conflict.copyAll = false;
  acknowledged.mutations[0].reject(conflict);
  await Promise.resolve();

  assert.deepEqual(settings.snapshot(), { beta: true });
  assert.deepEqual(acknowledged.mutations[1].mutation.initialize, { beta: true });
  acknowledged.mutations[1].accept({ beta: true, 'beta.words': 'migrated' });
  await Promise.resolve();
  assert.equal(acknowledged.mutations[2].key, `${accountKey}.migrated`);
  acknowledged.mutations[2].accept(['one']);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(settings.snapshot(), { beta: true, 'beta.words': 'migrated' });
});

test('manual Retry resets an exhausted migration conflict budget', async () => {
  const acknowledged = createAcknowledgedStorage({ settings: {}, 'settings.migrated': [] });
  acknowledged.storage.getAtLoad = acknowledged.storage.get;
  acknowledged.storage.whenReady = (run) => run();
  const settings = createSettings({
    storage: acknowledged.storage,
    features,
    migrations: [{ id: 'one', run: (raw) => { raw['beta.words'] = 'migrated'; } }],
  });
  const rejectConflict = async (index, current) => {
    const conflict = new Error('changed while saving');
    conflict.code = 'STORAGE_MIGRATION_CONFLICT';
    conflict.current = current;
    conflict.receipt = [];
    acknowledged.mutations[index].reject(conflict);
    await Promise.resolve();
  };

  for (let index = 0; index < 4; index++) {
    await rejectConflict(index, index % 2 ? { beta: true } : {});
  }
  assert.equal(settings.saveStatus().state, 'error');
  assert.equal(acknowledged.mutations.length, 4);

  const retrying = settings.retry();
  await rejectConflict(4, { beta: true });
  acknowledged.mutations[5].accept({ beta: true, 'beta.words': 'migrated' });
  await Promise.resolve();
  acknowledged.mutations[6].accept(['one']);
  await retrying;

  assert.deepEqual(settings.snapshot(), { beta: true, 'beta.words': 'migrated' });
  assert.deepEqual(settings.saveStatus(), { state: 'idle', error: null, pending: [] });
});

test('canceling a rejected draft with the committed value notifies consumers and clears recovery', async () => {
  const acknowledged = createAcknowledgedStorage({ settings: {} });
  const settings = createSettings({ storage: acknowledged.storage, features, migrations: [] });
  const heard = [];
  settings.subscribe((change) => heard.push(change.keys));

  const saving = settings.set('beta', true);
  const rejected = assert.rejects(saving, /disconnected/);
  acknowledged.mutations[0].reject(new Error('disconnected'));
  await rejected;
  assert.equal(settings.display('beta'), true);

  settings.set('beta', false);
  assert.equal(settings.display('beta'), false);
  assert.deepEqual(settings.saveStatus(), { state: 'idle', error: null, pending: [] });
  assert.deepEqual(heard, [['beta']], 'the explicit committed-value choice still carries account authority');
});

test('rejected acknowledged saves retain committed choices and drafts until retry succeeds', async () => {
  const acknowledged = createAcknowledgedStorage({ settings: { beta: true } });
  const errors = [];
  const settings = createSettings({
    storage: acknowledged.storage,
    features,
    migrations: [],
    log: { error: (message, error) => errors.push([message, error]) },
  });
  const states = [];
  settings.onSaveStatus((status) => states.push(status.state));

  const saving = settings.set('alpha', false);
  assert.equal(settings.get('alpha'), true, 'running behavior stays on the acknowledged value');
  assert.equal(settings.display('alpha'), false, 'the unsaved draft remains visible');
  assert.deepEqual(settings.saveStatus().pending, ['alpha']);
  assert.equal(settings.saveStatus().state, 'saving');
  const rejected = assert.rejects(saving, /Quota exceeded/);
  acknowledged.mutations[0].reject(new Error('Quota exceeded'));
  await rejected;

  assert.deepEqual(settings.snapshot(), { beta: true });
  assert.equal(settings.display('alpha'), false);
  assert.equal(settings.saveStatus().state, 'error');
  assert.equal(errors.length, 1);

  const retry = settings.retry();
  assert.equal(settings.saveStatus().state, 'saving');
  assert.deepEqual(acknowledged.mutations[1].mutation, { set: { alpha: false }, remove: [] });
  acknowledged.mutations[1].accept();
  await retry;

  assert.equal(settings.get('alpha'), false);
  assert.equal(settings.display('alpha'), false);
  assert.deepEqual(settings.saveStatus(), { state: 'idle', error: null, pending: [] });
  assert.equal(createSettings({ storage: acknowledged.storage, features }).get('alpha'), false, 'reload sees the last acknowledgement');
  assert.deepEqual(states, ['idle', 'saving', 'error', 'saving', 'idle']);
});

test('field mutations remove defaults and merge remote updates without losing a pending draft', async () => {
  const acknowledged = createAcknowledgedStorage({ settings: { beta: true } });
  const settings = createSettings({ storage: acknowledged.storage, features, migrations: [] });

  const remove = settings.set('beta', false);
  assert.deepEqual(acknowledged.mutations[0].mutation, { set: {}, remove: ['beta'] });
  acknowledged.remote('settings', { alpha: false, beta: true });
  assert.equal(settings.get('alpha'), false, 'the unrelated remote field is committed immediately');
  assert.equal(settings.get('beta'), true, 'the pending field is not committed before acknowledgement');
  assert.equal(settings.display('beta'), false, 'the local draft survives the remote record');
  acknowledged.mutations[0].accept({ alpha: false });
  await remove;

  assert.equal(settings.get('beta'), false);
  assert.equal(settings.get('alpha'), false);
  const set = settings.set('beta', true);
  assert.deepEqual(acknowledged.mutations[1].mutation, { set: { beta: true }, remove: [] });
  acknowledged.mutations[1].accept({ alpha: false, beta: true });
  await set;
  assert.deepEqual(settings.snapshot(), { alpha: false, beta: true });
});

test('a newer acknowledged deletion wins over an older local response', async () => {
  const acknowledged = createAcknowledgedStorage({ settings: {} });
  const settings = createSettings({ storage: acknowledged.storage, features, migrations: [] });

  const saving = settings.set('beta', true);
  acknowledged.remote('settings', undefined);
  acknowledged.mutations[0].accept(undefined);
  await saving;

  assert.equal(settings.get('beta'), false);
  assert.equal(settings.display('beta'), false);
  assert.deepEqual(settings.snapshot(), {});
  assert.deepEqual(settings.saveStatus(), { state: 'idle', error: null, pending: [] });
});

test('concurrent preference calls settle with their own browser acknowledgement', async () => {
  const acknowledged = createAcknowledgedStorage({ settings: {} });
  const settings = createSettings({ storage: acknowledged.storage, features, migrations: [] });

  const first = settings.set('alpha', false);
  const second = settings.set('beta', true);
  assert.notEqual(first, second);
  acknowledged.mutations[0].accept({ alpha: false });
  await first;
  assert.equal(settings.get('alpha'), false);
  assert.equal(acknowledged.mutations.length, 2);

  const rejected = assert.rejects(second, /quota/i);
  acknowledged.mutations[1].reject(new Error('quota exceeded'));
  await rejected;
  assert.equal(settings.get('alpha'), false, 'the acknowledged first operation stays committed');
  assert.equal(settings.get('beta'), false);
  assert.equal(settings.display('beta'), true, 'only the rejected second operation remains a draft');
});

test('a failed mutation rejects callers queued behind it and keeps one retryable draft batch', async () => {
  const acknowledged = createAcknowledgedStorage({ settings: {} });
  const settings = createSettings({ storage: acknowledged.storage, features, migrations: [] });

  const first = settings.set('alpha', false);
  const second = settings.set('beta', true);
  const firstRejected = assert.rejects(first, /quota/i);
  const secondRejected = assert.rejects(second, /quota/i);
  acknowledged.mutations[0].reject(new Error('quota exceeded'));
  await Promise.all([firstRejected, secondRejected]);

  assert.equal(acknowledged.mutations.length, 1, 'a failed operation does not start another save behind the error');
  assert.equal(settings.saveStatus().state, 'error');
  assert.match(settings.saveStatus().error.message, /quota/i);
  assert.deepEqual(settings.saveStatus().pending, ['alpha', 'beta']);

  const retry = settings.retry();
  assert.deepEqual(acknowledged.mutations[1].mutation, { set: { alpha: false, beta: true }, remove: [] });
  acknowledged.mutations[1].accept({ alpha: false, beta: true });
  await retry;
  assert.deepEqual(settings.snapshot(), { alpha: false, beta: true });
});

test('reset and complete restore each publish one replacement record and resolve after acknowledgement', async () => {
  const acknowledged = createAcknowledgedStorage({ settings: { beta: true } });
  const settings = createSettings({ storage: acknowledged.storage, features, version: '0.0.1', migrations: [] });

  const reset = settings.reset();
  assert.equal(acknowledged.mutations.length, 1);
  assert.deepEqual(acknowledged.mutations[0].mutation, { replace: {} });
  assert.deepEqual(settings.snapshot(), { beta: true });
  acknowledged.mutations[0].accept();
  assert.deepEqual(await reset, { beta: true });
  assert.deepEqual(settings.snapshot(), {});

  const restore = settings.importJson(JSON.stringify({
    app: 'HushFacebook Web', schema: EXPORT_SCHEMA, version: '0.0.1', settings: { alpha: false, beta: true },
  }));
  assert.equal(acknowledged.mutations.length, 2);
  assert.deepEqual(acknowledged.mutations[1].mutation, { replace: { alpha: false, beta: true } });
  assert.deepEqual(settings.snapshot(), {}, 'the restore is not reported as committed early');
  acknowledged.mutations[1].accept();
  assert.deepEqual(await restore, { applied: ['alpha', 'beta'], skipped: [] });
  assert.deepEqual(settings.snapshot(), { alpha: false, beta: true });
});

test('canceling one field of a rejected replacement keeps it in the retried record', async () => {
  const replacementFeatures = [
    { id: 'alpha', title: 'Alpha', default: false },
    { id: 'beta', title: 'Beta', default: false },
  ];
  const acknowledged = createAcknowledgedStorage({ settings: { alpha: true, beta: true } });
  const settings = createSettings({ storage: acknowledged.storage, features: replacementFeatures, migrations: [] });

  const reset = settings.reset();
  const rejected = assert.rejects(reset, /disconnected/);
  acknowledged.mutations[0].reject(new Error('disconnected'));
  await rejected;

  const keepAlpha = settings.set('alpha', true);
  assert.deepEqual(acknowledged.mutations[1].mutation, { replace: { alpha: true } });
  acknowledged.mutations[1].accept({ alpha: true });
  await keepAlpha;

  assert.equal(settings.get('alpha'), true);
  assert.equal(settings.get('beta'), false);
  assert.deepEqual(settings.snapshot(), { alpha: true });
});

test('backup envelopes reject foreign apps and unsupported schemas without changing preferences', () => {
  const { settings } = make({ beta: true });
  for (const value of [
    { app: 'Another app', schema: 1, settings: { beta: false } },
    { app: 'HushFacebook Web', schema: 2, settings: { beta: false } },
    { app: 'HushFacebook Web', schema: 1, settings: [] },
    { settings: { beta: false } },
    { app: 'HushFacebook Web', schema: 1 },
  ]) {
    assert.throws(() => settings.importJson(JSON.stringify(value)), TypeError);
    assert.deepEqual(settings.snapshot(), { beta: true });
  }
});

test('direct imports reject oversized UTF-8 text before parsing', () => {
  const { settings } = make({ beta: true });
  assert.throws(() => settings.importJson(' '.repeat(1024 * 1024 + 1)), /1 MB/);
  assert.throws(() => settings.importJson('é'.repeat(600000)), /1 MB/);
  assert.deepEqual(settings.snapshot(), { beta: true });
});

test('a complete backup restores defaults too while legacy partial imports keep other choices', () => {
  const { settings } = make();
  const defaults = settings.exportJson();
  settings.set('beta', true);
  const heard = [];
  settings.subscribe(({ keys }) => heard.push(keys));
  settings.importJson(defaults);
  assert.equal(settings.get('beta'), false);
  assert.ok(heard[0].includes('beta'));
  settings.set('beta', true);
  settings.importJson('{"alpha":false}');
  assert.equal(settings.get('beta'), true);
  assert.equal(settings.get('alpha'), false);
});

test('the signed-in account comes from the c_user cookie, and nothing else', () => {
  assert.equal(accountFromCookie('datr=abc; c_user=615000000000017; xs=12%3Aabc'), '615000000000017');
  assert.equal(accountFromCookie('c_user=615000000000017'), '615000000000017');
  assert.equal(accountFromCookie('datr=abc; xs=1'), null);
  assert.equal(accountFromCookie('not_c_user=615000000000017'), null);
  assert.equal(accountFromCookie('c_user=deleted'), null);
  assert.equal(accountFromCookie(undefined), null);
  assert.equal(accountFromCookie('c_user=615000000000017; c_user=615000000000017'), '615000000000017');
  assert.equal(accountFromCookie('c_user=615000000000099; datr=abc; c_user=615000000000017'), null, 'a second account planted on a deeper path picks neither');
  assert.equal(accountFromCookie('c_user=615000000000099;c_user=615000000000017'), null);
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

test('an account inherits a shared migration record even when every shared setting is at its default', () => {
  const account = '615000000000019';
  const accountKey = storageKeyFor(account);
  const storage = createMemoryStorage({ 'settings.migrated': ['split-ad-switch'] });
  const first = createSettings({ storage, features: adSwitches, account });
  first.set('hideSponsoredPosts', false);
  const second = createSettings({ storage, features: adSwitches, account });
  assert.equal(second.get('hideSponsoredSearch'), true);
  assert.equal(second.get('hideSponsoredMarketplace'), true);
  assert.deepEqual(storage.dump()[`${accountKey}.migrated`], ['split-ad-switch']);
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

test('a malformed stored migration receipt is treated as empty', () => {
  for (const receipt of ['junk', [7]]) {
    const storage = createMemoryStorage({ settings: { hideSponsoredPosts: false }, 'settings.migrated': receipt });
    assert.equal(createSettings({ storage, features: adSwitches }).get('hideSponsoredSearch'), false);
    assert.deepEqual(storage.dump()['settings.migrated'], ['split-ad-switch']);
  }
});

test('isValid knows every setting type', () => {
  assert.equal(isValid({ type: 'toggle' }, false), true);
  assert.equal(isValid({ type: 'text', maxLength: 3 }, 'abcd'), false);
  assert.equal(isValid({ type: 'number', min: 1 }, Number.NaN), false);
  assert.equal(isValid({ type: 'mystery' }, 1), false);
});
