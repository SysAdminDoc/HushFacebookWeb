// The extension's service worker (extension/background.js), run in a vm context with a stand-in
// for the chrome APIs and fetch, the way Chrome runs it as a classic script.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { availableUpdate, UPDATE_KEY } from '../src/core/extension.js';
import { createMemoryStorage } from '../src/core/storage.js';

const SOURCE = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const DAY = 24 * 60 * 60 * 1000;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
};

function worker({ version = '0.0.4', saved = {}, session = {}, release = null, tabs = {}, writeError = null } = {}) {
  const data = structuredClone(saved);
  const calls = { fetch: 0, badge: [], created: [], reloaded: [], sent: [], downloads: [] };
  const listeners = { updated: [], downloadChanged: [], messages: [], storageChanged: [] };
  const tellStorage = (changes) => queueMicrotask(() => (
    listeners.storageChanged.forEach((listener) => listener(changes, 'local'))
  ));
  const chrome = {
    runtime: { getManifest: () => ({ version }), onMessage: { addListener: (fn) => listeners.messages.push(fn) } },
    storage: { local: {
      get: async (keys) => {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.filter((key) => key in data).map((key) => [key, structuredClone(data[key])]));
      },
      set: async (items) => {
        if (writeError) throw writeError;
        const changes = {};
        for (const [key, value] of Object.entries(items)) {
          if (JSON.stringify(data[key]) !== JSON.stringify(value)) {
            changes[key] = { oldValue: structuredClone(data[key]), newValue: structuredClone(value) };
          }
          data[key] = structuredClone(value);
        }
        if (Object.keys(changes).length) tellStorage(changes);
      },
      remove: async (key) => {
        if (writeError) throw writeError;
        if (!Object.hasOwn(data, key)) return;
        const changes = { [key]: { oldValue: structuredClone(data[key]) } };
        delete data[key];
        tellStorage(changes);
      },
    }, session: {
      get: async (key) => (Object.hasOwn(session, key) ? { [key]: structuredClone(session[key]) } : {}),
      set: async (items) => void Object.assign(session, structuredClone(items)),
    }, onChanged: { addListener: (fn) => listeners.storageChanged.push(fn) } },
    action: {
      onClicked: { addListener() {} },
      setBadgeText: async ({ text }) => void calls.badge.push(text),
      setBadgeBackgroundColor: async () => {},
    },
    alarms: { onAlarm: { addListener() {} }, get: async () => ({ name: 'update-check' }), create() {} },
    tabs: {
      query: async () => Object.keys(tabs).map((id) => ({ id: Number(id) })),
      create: async ({ url }) => (calls.created.push(url), { id: 99 }),
      reload: async (id) => void calls.reloaded.push(id),
      sendMessage: async (id, message) => {
        calls.sent.push([id, message.type]);
        if (!tabs[id]) throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      onUpdated: { addListener: (fn) => listeners.updated.push(fn), removeListener: (fn) => listeners.updated.splice(listeners.updated.indexOf(fn), 1) },
    },
    downloads: {
      download: async (options) => (calls.downloads.push(options), 7),
      onChanged: { addListener: (fn) => listeners.downloadChanged.push(fn), removeListener() {} },
    },
  };
  const fetch = async () => {
    calls.fetch++;
    if (release instanceof Error) throw release;
    return { ok: release !== null && !release.status, json: async () => release };
  };
  const context = vm.createContext({
    chrome,
    crypto: globalThis.crypto,
    fetch,
    URL,
    Date,
    structuredClone,
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(SOURCE, context);
  return { context, chrome, data, calls, listeners };
}

test('a newer release is saved, lights the badge, and the page reads it as an update', async () => {
  const { context, data, calls } = worker({ release: { tag_name: 'v0.0.10', html_url: 'https://github.com/SysAdminDoc/HushFacebookWeb/releases/tag/v0.0.10' } });
  const record = await context.checkForUpdate(1000);
  assert.equal(record.newer, true);
  assert.deepEqual(calls.badge, ['NEW']);
  assert.deepEqual(availableUpdate(createMemoryStorage(data)), { version: '0.0.10', url: 'https://github.com/SysAdminDoc/HushFacebookWeb/releases/tag/v0.0.10' });
});

test('the same or an older release shows nothing', async () => {
  for (const tag of ['v0.0.4', '0.0.3', 'v0.0.4.0']) {
    const { context, data, calls } = worker({ release: { tag_name: tag } });
    await context.checkForUpdate(1000);
    assert.deepEqual(calls.badge, [''], tag);
    assert.equal(availableUpdate(createMemoryStorage(data)), null, tag);
  }
});

test('one check a day: a fresh record is reused without asking GitHub, and a new install asks again', async () => {
  const saved = { [UPDATE_KEY]: { at: 1000, current: '0.0.4', latest: '0.0.5', url: null, newer: true } };
  const fresh = worker({ saved, release: { tag_name: 'v0.0.6' } });
  await fresh.context.checkForUpdate(1000 + DAY - 1);
  assert.equal(fresh.calls.fetch, 0);
  assert.deepEqual(fresh.calls.badge, ['NEW']);

  const stale = worker({ saved, release: { tag_name: 'v0.0.6' } });
  await stale.context.checkForUpdate(1000 + DAY);
  assert.equal(stale.calls.fetch, 1);
  assert.equal(stale.data[UPDATE_KEY].latest, '0.0.6');

  const updated = worker({ version: '0.0.5', saved, release: { tag_name: 'v0.0.5' } });
  await updated.context.checkForUpdate(2000);
  assert.equal(updated.calls.fetch, 1, 'a new version of the extension checks at once');
  assert.deepEqual(updated.calls.badge, ['']);
});

test('offline, rate limited or an odd tag keeps what was known and waits a day', async () => {
  const saved = { [UPDATE_KEY]: { at: 1, current: '0.0.4', latest: '0.0.5', url: null, newer: true } };
  for (const release of [new Error('offline'), { status: 403 }, { tag_name: 'nightly' }]) {
    const { context, data } = worker({ saved, release });
    const record = await context.checkForUpdate(1 + DAY * 2);
    assert.equal(record.latest, '0.0.5');
    assert.equal(record.newer, true);
    assert.equal(data[UPDATE_KEY].at, 1 + DAY * 2);
  }
});

test("the page only links to this repo's releases", () => {
  const record = (url) => createMemoryStorage({ [UPDATE_KEY]: { latest: '0.0.9', newer: true, url } });
  assert.equal(availableUpdate(record('https://evil.example/x')).url, 'https://github.com/SysAdminDoc/HushFacebookWeb/releases/latest');
  assert.equal(availableUpdate(createMemoryStorage({ [UPDATE_KEY]: { latest: '<b>', newer: true } })), null);
});

test('the toolbar button opens settings on Facebook, reloads a tab without the script, and opens Facebook from elsewhere', async () => {
  const { context, calls, listeners } = worker({ tabs: { 1: true } });
  assert.equal(await context.openSettings({ id: 1, index: 0, url: 'https://www.facebook.com/groups/feed/' }), 'opened');
  assert.equal(await context.openSettings({ id: 2, index: 1, url: 'https://web.facebook.com/' }), 'reloaded');
  assert.deepEqual(calls.reloaded, [2]);
  listeners.updated.forEach((fn) => fn(2, { status: 'complete' }));
  assert.equal(await context.openSettings({ id: 3, index: 4, url: 'https://example.com/' }), 'new tab');
  assert.equal(await context.openSettings({ id: 4, index: 5, url: undefined }), 'new tab');
  assert.deepEqual(calls.created, ['https://www.facebook.com/', 'https://www.facebook.com/']);
  assert.equal(await context.openSettings({ id: 5, index: 0, url: 'https://www.facebook.com.evil.example/' }), 'new tab');
});

test('downloads take only Facebook files and wait for the browser to finish', async () => {
  const { context, calls, listeners } = worker();
  await assert.rejects(context.save({ url: 'https://example.com/a.jpg', name: 'a.jpg' }), /not a Facebook file/);
  await assert.rejects(context.save({ url: 'http://scontent.xx.fbcdn.net/a.jpg', name: 'a.jpg' }), /not a Facebook file/);
  const saving = context.save({ url: 'https://scontent.xx.fbcdn.net/v/a.jpg', name: 'Pat photo.jpg' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(JSON.parse(JSON.stringify(calls.downloads)), [{ url: 'https://scontent.xx.fbcdn.net/v/a.jpg', filename: 'Pat photo.jpg', saveAs: false, conflictAction: 'uniquify' }]);
  listeners.downloadChanged.forEach((fn) => fn({ id: 7, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } }));
  await assert.rejects(saving, /USER_CANCELED/);
});

test('downloads refuse a file name with a control character or a path in it', async () => {
  const { context, calls } = worker();
  const url = 'https://scontent.xx.fbcdn.net/v/a.jpg';
  for (const code of [0x00, 0x1f, 0x7f, 0x9f, 0x202e]) {
    await assert.rejects(context.save({ url, name: `Pat${String.fromCodePoint(code)}photo.jpg` }), /not safe/, `U+${code.toString(16)}`);
  }
  await assert.rejects(context.save({ url, name: 'Pat/photo.jpg' }), /not safe/);
  assert.equal(calls.downloads.length, 0);
});

test('settings mutations from two tabs merge at the worker and same-field requests use accepted order', async () => {
  const { context, data } = worker({ saved: { settings: { existing: true } } });
  const [first, second] = await Promise.all([
    context.mutateStorage({ key: 'settings', mutation: { set: { alpha: true } } }),
    context.mutateStorage({ key: 'settings', mutation: { set: { beta: true } } }),
  ]);
  assert.deepEqual({ ...first.value }, { existing: true, alpha: true });
  assert.equal(first.revision, 1);
  assert.deepEqual({ ...second.value }, { existing: true, alpha: true, beta: true });
  assert.equal(second.revision, 2);
  assert.equal(first.epoch, second.epoch, 'ordinary commits stay in one storage generation');
  assert.deepEqual(data.settings, { existing: true, alpha: true, beta: true });
  assert.equal(data['hushfacebookWeb.storageRevisions'].settings, 2);
  assert.equal(data['hushfacebookWeb.storageRevisions'].__epoch, second.epoch);
  assert.equal(data['hushfacebookWeb.storageRevisions'].__order, 2);

  await Promise.all([
    context.mutateStorage({ key: 'settings', mutation: { set: { alpha: false } } }),
    context.mutateStorage({ key: 'settings', mutation: { set: { alpha: 'last' } } }),
  ]);
  assert.equal(data.settings.alpha, 'last', 'the last request accepted by the worker wins one field');
  assert.equal(data['hushfacebookWeb.storageRevisions'].settings, 4);
  assert.equal(data['hushfacebookWeb.storageRevisions'].__order, 4);
});

test('an ordinary settings mutation repairs a malformed stored record', async () => {
  const { context, data } = worker({ saved: { settings: 'bad' } });

  const result = await context.mutateStorage({
    key: 'settings',
    mutation: { set: { alpha: true }, remove: [] },
  });

  assert.deepEqual(result.value, { alpha: true });
  assert.deepEqual(data.settings, { alpha: true });
  assert.equal(Number.isSafeInteger(data['hushfacebookWeb.storageRevisions'].settings), true);
});

test('different keys share commit order without replacing their generation', async () => {
  const { context, data } = worker();
  const settings = await context.mutateStorage({ key: 'settings', mutation: { set: { alpha: true } } });
  const receipt = await context.mutateStorage({ key: 'settings.migrated', mutation: { replace: ['one'] } });

  assert.equal(receipt.epoch, settings.epoch);
  assert.equal(settings.revision, 1);
  assert.equal(receipt.revision, 2);
  assert.equal(data['hushfacebookWeb.storageRevisions'].settings, 1);
  assert.equal(data['hushfacebookWeb.storageRevisions']['settings.migrated'], 2);
  assert.equal(data['hushfacebookWeb.storageRevisions'].__order, 2);
});

test('account initialization applies its snapshot only while the record is absent', async () => {
  const { context, data } = worker();
  await context.mutateStorage({
    key: 'account-settings',
    mutation: { initialize: { inherited: true }, set: { alpha: true }, remove: [] },
  });
  await context.mutateStorage({
    key: 'account-settings',
    mutation: { initialize: { inherited: false }, set: { beta: true }, remove: [] },
  });

  assert.deepEqual(data['account-settings'], { inherited: true, alpha: true, beta: true });
});

test('logical account recovery inherits the current shared record', async () => {
  const accountKey = 'settings@abc';
  const doneKey = `${accountKey}.migrated`;
  const recoveryKey = 'hushfacebookWeb.pendingPreferenceRecovery';
  const { context, data } = worker({
    saved: {
      settings: { fresh: true },
      'settings.migrated': [],
      [accountKey]: 'bad',
    },
    session: {
      [recoveryKey]: {
        [accountKey]: {
          missing: false,
          expected: 'bad',
          mutation: { removeRecord: true, expected: 'bad' },
        },
      },
    },
  });

  const result = await context.migrateStorage({
    key: accountKey,
    doneKey,
    sourceKey: 'settings',
    sourceDoneKey: 'settings.migrated',
    receipt: ['one'],
    mutation: {
      initialize: { stale: true },
      set: { explicit: true },
      remove: [],
      guard: { fresh: { exists: true, value: true }, explicit: { exists: false } },
      conditions: {},
      guarded: [],
      migrationOwners: {},
    },
  });

  assert.equal(result.conflict, undefined);
  assert.deepEqual(data[accountKey], { fresh: true, explicit: true });
  assert.deepEqual(data[doneKey], ['one']);
});

test('commit-order overflow starts a fresh generation with a safe first revision', async () => {
  const oldEpoch = 'full-generation';
  const { context, data } = worker({
    saved: {
      settings: { old: true },
      'hushfacebookWeb.storageRevisions': {
        __epoch: oldEpoch,
        __order: Number.MAX_SAFE_INTEGER,
        settings: Number.MAX_SAFE_INTEGER,
      },
    },
  });

  const result = await context.mutateStorage({ key: 'settings', mutation: { set: { current: true } } });
  assert.notEqual(result.epoch, oldEpoch);
  assert.equal(result.revision, 1);
  assert.equal(Number.isSafeInteger(result.revision), true);
  assert.deepEqual(data.settings, { old: true, current: true });
  assert.deepEqual(JSON.parse(JSON.stringify(data['hushfacebookWeb.storageRevisions'])), {
    __epoch: result.epoch,
    __order: 1,
    settings: 1,
  });
});

test('a same-generation rollback observed during the worker read starts a fresh generation', async () => {
  const epoch = 'before-reset';
  const baseRevisions = { __epoch: epoch, __order: 5, settings: 5 };
  const { context, data } = worker({
    saved: {
      settings: { direct: true },
      'hushfacebookWeb.storageRevisions': { __epoch: epoch, __order: 2, settings: 2 },
    },
  });

  const result = await context.mutateStorage({
    key: 'settings',
    mutation: { set: { current: true } },
    generation: epoch,
    baseRevisions,
  });

  assert.notEqual(result.epoch, epoch);
  assert.equal(result.revision, 1);
  assert.deepEqual(data.settings, { direct: true, current: true });
  assert.deepEqual(JSON.parse(JSON.stringify(data['hushfacebookWeb.storageRevisions'])), {
    __epoch: result.epoch,
    __order: 1,
    settings: 1,
  });
});

test('a rejected settings mutation reports the storage error and retains the committed record', async () => {
  const { context, data } = worker({ saved: { settings: { alpha: true } }, writeError: new Error('QUOTA_BYTES quota exceeded') });
  await assert.rejects(
    context.mutateStorage({ key: 'settings', mutation: { set: { beta: true } } }),
    /quota exceeded/i,
  );
  assert.deepEqual(data.settings, { alpha: true });
  assert.equal(data['hushfacebookWeb.storageRevisions'], undefined, 'a rejected write does not advance accepted order');
});

test('an acknowledged mutation atomically unions migration receipts', async () => {
  const { context, data } = worker({ saved: { 'settings.migrated': ['two'] } });
  const result = await context.mutateStorage({
    key: 'settings.migrated',
    mutation: { union: ['one', 'two'] },
  });

  assert.deepEqual([...result.value], ['two', 'one']);
  assert.deepEqual(data['settings.migrated'], ['two', 'one']);
  assert.equal(result.revision, 1);
  assert.equal(data['hushfacebookWeb.storageRevisions']['settings.migrated'], 1);
});

test('a migration commits settings and its receipt in one accepted order', async () => {
  const { context, data } = worker({
    saved: { settings: { source: false }, 'settings.migrated': [] },
  });

  const result = await context.migrateStorage({
    key: 'settings',
    doneKey: 'settings.migrated',
    receipt: ['one'],
    mutation: {
      set: { target: false },
      remove: [],
      conditions: { target: { exists: false } },
      guard: { source: { exists: true, value: false }, target: { exists: false } },
      guarded: ['target'],
    },
  });

  assert.deepEqual({ ...result.previous }, { source: false });
  assert.deepEqual([...result.completedBefore], []);
  assert.deepEqual(data.settings, { source: false, target: false });
  assert.deepEqual(data['settings.migrated'], ['one']);
  assert.equal(data['hushfacebookWeb.storageRevisions'].settings, 1);
  assert.equal(data['hushfacebookWeb.storageRevisions']['settings.migrated'], 1);
});

test('a completed migration skips stale derived fields but keeps an explicit draft', async () => {
  const { context, data } = worker({
    saved: { settings: { source: true }, 'settings.migrated': ['one'] },
  });

  await context.migrateStorage({
    key: 'settings',
    doneKey: 'settings.migrated',
    receipt: ['one'],
    mutation: {
      set: { target: false, explicit: true },
      remove: [],
      conditions: { target: { exists: false } },
      guard: { source: { exists: true, value: false }, target: { exists: false } },
      guarded: ['target'],
    },
  });

  assert.deepEqual(data.settings, { source: true, explicit: true });
  assert.deepEqual(data['settings.migrated'], ['one']);
});

test('a pending receipt recovery is committed before migration classification', async () => {
  const doneKey = 'settings.migrated';
  const recoveryKey = 'hushfacebookWeb.pendingPreferenceRecovery';
  const { context, data } = worker({
    saved: { settings: { hideSponsoredPosts: false }, [doneKey]: [] },
    session: {
      [recoveryKey]: {
        [doneKey]: {
          missing: false,
          expected: [],
          mutation: { union: ['split-ad-switch'] },
        },
      },
    },
  });

  const result = await context.migrateStorage({
    key: 'settings',
    doneKey,
    receipt: ['split-ad-switch'],
    mutation: {
      set: { hideSponsoredSearch: false },
      remove: [],
      conditions: { hideSponsoredSearch: { exists: false } },
      guard: { hideSponsoredPosts: { exists: true, value: false } },
      guarded: ['hideSponsoredSearch'],
      migrationOwners: { hideSponsoredSearch: 'split-ad-switch' },
    },
  });

  assert.deepEqual(data.settings, { hideSponsoredPosts: false });
  assert.deepEqual(data[doneKey], ['split-ad-switch']);
  assert.equal(result.committed, true, 'the no-op migration still acknowledges its receipt recovery');
  assert.equal(result.revisions.__order, 1);
});

test('a partially completed migration applies only fields owned by pending receipts', async () => {
  const { context, data } = worker({
    saved: { settings: {}, 'settings.migrated': ['one', 7] },
  });

  await context.migrateStorage({
    key: 'settings',
    doneKey: 'settings.migrated',
    receipt: ['one', 'two'],
    mutation: {
      set: { fromOne: false, fromTwo: true, explicit: true },
      remove: [],
      conditions: { fromOne: { exists: false }, fromTwo: { exists: false } },
      guard: { fromOne: { exists: false }, fromTwo: { exists: false } },
      guarded: ['fromOne', 'fromTwo'],
      migrationOwners: { fromOne: 'one', fromTwo: 'two' },
    },
  });

  assert.deepEqual(data.settings, { fromTwo: true, explicit: true });
  assert.deepEqual(data['settings.migrated'], ['one', 'two']);
});

test('a pending migration conflicts when it was derived from a stale completed field', async () => {
  const { context, data } = worker({
    saved: { settings: { fromOne: true }, 'settings.migrated': ['one'] },
  });

  const result = await context.migrateStorage({
    key: 'settings',
    doneKey: 'settings.migrated',
    receipt: ['one', 'two'],
    mutation: {
      set: { fromOne: false, fromTwo: 'derived-from-false' },
      remove: [],
      conditions: { fromOne: { exists: false }, fromTwo: { exists: false } },
      guard: { fromOne: { exists: false }, fromTwo: { exists: false } },
      guarded: ['fromOne', 'fromTwo'],
      migrationOwners: { fromOne: 'one', fromTwo: 'two' },
    },
  });

  assert.equal(result.conflict, true);
  assert.deepEqual(data.settings, { fromOne: true });
  assert.deepEqual(data['settings.migrated'], ['one']);
});

test('account initialization does not replay a migration already completed by its source', async () => {
  const { context, data } = worker({
    saved: { settings: { source: false }, 'settings.migrated': ['one'] },
  });

  await context.migrateStorage({
    key: 'settings@account',
    doneKey: 'settings@account.migrated',
    sourceKey: 'settings',
    sourceDoneKey: 'settings.migrated',
    receipt: ['one'],
    mutation: {
      initialize: { source: false },
      set: { target: false, explicit: true },
      remove: [],
      conditions: { target: { exists: false } },
      guard: { source: { exists: true, value: false }, target: { exists: false } },
      guarded: ['target'],
    },
  });

  assert.deepEqual(data['settings@account'], { source: false, explicit: true });
  assert.deepEqual(data['settings@account.migrated'], ['one']);
});

test('account initialization preserves both orphaned and source migration receipts', async () => {
  const { context, data } = worker({
    saved: {
      settings: { source: false },
      'settings.migrated': ['one', 'legacy'],
      'settings@account.migrated': ['one'],
    },
  });

  await context.migrateStorage({
    key: 'settings@account',
    doneKey: 'settings@account.migrated',
    sourceKey: 'settings',
    sourceDoneKey: 'settings.migrated',
    receipt: ['one'],
    mutation: {
      initialize: { source: false },
      set: {},
      remove: [],
      guard: { source: { exists: true, value: false } },
    },
  });

  assert.deepEqual(data['settings@account'], { source: false });
  assert.deepEqual(data['settings@account.migrated'], ['one', 'legacy']);
});

test('account initialization repairs a malformed target and preserves every receipt', async () => {
  const { context, data } = worker({
    saved: {
      settings: { beta: true },
      'settings.migrated': ['shared'],
      'settings@abc': 'bad',
      'settings@abc.migrated': ['orphan'],
    },
  });

  await context.migrateStorage({
    key: 'settings@abc',
    doneKey: 'settings@abc.migrated',
    sourceKey: 'settings',
    sourceDoneKey: 'settings.migrated',
    receipt: [],
    mutation: { initialize: {}, set: { alpha: true }, remove: [] },
  });

  assert.deepEqual(data['settings@abc'], { beta: true, alpha: true });
  assert.deepEqual([...data['settings@abc.migrated']].sort(), ['orphan', 'shared']);
});

test('account initialization treats a malformed shared source as an empty record', async () => {
  const { context, data } = worker({
    saved: { settings: 'bad', 'settings.migrated': ['shared'] },
  });

  await context.migrateStorage({
    key: 'settings@abc',
    doneKey: 'settings@abc.migrated',
    sourceKey: 'settings',
    sourceDoneKey: 'settings.migrated',
    receipt: [],
    mutation: { initialize: {}, set: { alpha: true }, remove: [] },
  });

  assert.deepEqual(data['settings@abc'], { alpha: true });
  assert.deepEqual(data['settings@abc.migrated'], ['shared']);
});

test('a migration whose source record changed reports conflict without recording its receipt', async () => {
  const { context, data } = worker({
    saved: { settings: { source: true }, 'settings.migrated': [] },
  });

  const result = await context.migrateStorage({
    key: 'settings',
    doneKey: 'settings.migrated',
    receipt: ['one'],
    mutation: {
      set: { target: false },
      remove: [],
      conditions: { target: { exists: false } },
      guard: { source: { exists: true, value: false }, target: { exists: false } },
      guarded: ['target'],
    },
  });

  assert.equal(result.conflict, true);
  assert.equal(result.committed, false);
  assert.deepEqual(data.settings, { source: true });
  assert.deepEqual(data['settings.migrated'], []);
  assert.equal(data['hushfacebookWeb.storageRevisions'], undefined);
});

test('a direct preference write between worker read and commit is merged back conditionally', async () => {
  const { context, chrome, data } = worker({ saved: { settings: { base: true } } });
  const read = chrome.storage.local.get;
  const readStarted = deferred();
  const resume = deferred();
  let pauseRead = true;
  chrome.storage.local.get = async (keys) => {
    const snapshot = await read(keys);
    if (pauseRead) {
      pauseRead = false;
      readStarted.resolve();
      await resume.promise;
    }
    return snapshot;
  };

  const local = context.mutateStorage({ key: 'settings', mutation: { set: { local: true } } });
  await readStarted.promise;
  await chrome.storage.local.set({ settings: { base: true, direct: true } });
  resume.resolve();
  await local;
  await settle();
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  assert.deepEqual(data.settings, { base: true, local: true, direct: true });
});

test('a later direct same-field write wins over a worker commit that read first', async () => {
  const { context, chrome, data } = worker({ saved: { settings: { alpha: 0 } } });
  const read = chrome.storage.local.get;
  const readStarted = deferred();
  const resume = deferred();
  let pauseRead = true;
  chrome.storage.local.get = async (keys) => {
    const snapshot = await read(keys);
    if (pauseRead) {
      pauseRead = false;
      readStarted.resolve();
      await resume.promise;
    }
    return snapshot;
  };

  const local = context.mutateStorage({ key: 'settings', mutation: { set: { alpha: 1 } } });
  await readStarted.promise;
  await chrome.storage.local.set({ settings: { alpha: 2 } });
  resume.resolve();
  await local;
  await settle();
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  assert.deepEqual(data.settings, { alpha: 2 });
});

test('a later direct whole-record deletion wins over a worker commit that read first', async () => {
  const { context, chrome, data } = worker({ saved: { settings: { base: true } } });
  const read = chrome.storage.local.get;
  const readStarted = deferred();
  const resume = deferred();
  let pauseRead = true;
  chrome.storage.local.get = async (keys) => {
    const snapshot = await read(keys);
    if (pauseRead) {
      pauseRead = false;
      readStarted.resolve();
      await resume.promise;
    }
    return snapshot;
  };

  const local = context.mutateStorage({ key: 'settings', mutation: { set: { local: true } } });
  await readStarted.promise;
  await chrome.storage.local.remove('settings');
  resume.resolve();
  await local;
  await settle();
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  assert.equal(Object.hasOwn(data, 'settings'), false);
  assert.equal(Number.isSafeInteger(data['hushfacebookWeb.storageRevisions'].settings), true);
});

test('out-of-order direct callbacks cannot roll a newer field value back', async () => {
  const { context, data, listeners } = worker({ saved: { settings: { alpha: 0 } } });
  data.settings = { alpha: 2 };
  for (const listener of listeners.storageChanged) {
    listener({ settings: { oldValue: { alpha: 1 }, newValue: { alpha: 2 } } }, 'local');
    listener({ settings: { oldValue: { alpha: 0 }, newValue: { alpha: 1 } } }, 'local');
  }
  await settle();
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  assert.deepEqual(data.settings, { alpha: 2 });
  assert.equal(Number.isSafeInteger(data['hushfacebookWeb.storageRevisions'].settings), true);
});

test('a direct whole-record deletion stays absent while entering the revision stream', async () => {
  const { context, chrome, data } = worker({
    saved: {
      settings: { shared: true },
      'settings@abc': { account: true },
    },
  });

  await chrome.storage.local.remove('settings@abc');
  await settle();
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  assert.equal(Object.hasOwn(data, 'settings@abc'), false);
  assert.equal(Number.isSafeInteger(data['hushfacebookWeb.storageRevisions']['settings@abc']), true);
});

test('a direct migration-receipt replacement keeps every completed migration', async () => {
  const { context, chrome, data } = worker({ saved: { 'settings.migrated': ['one'] } });

  await chrome.storage.local.set({ 'settings.migrated': ['two'] });
  await settle();
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  assert.deepEqual([...data['settings.migrated']].sort(), ['one', 'two']);
  assert.equal(Number.isSafeInteger(data['hushfacebookWeb.storageRevisions']['settings.migrated']), true);
});

test('overtaken direct replacements preserve confirmed settings and every migration receipt', async () => {
  const { context, chrome, data } = worker({
    saved: {
      settings: { alpha: 0, beta: 2 },
      'settings.migrated': ['one'],
    },
  });
  const read = chrome.storage.local.get;
  const blocked = new Map();
  chrome.storage.local.get = async (keys) => {
    const key = Array.isArray(keys) && keys.length === 1 ? keys[0] : null;
    const gate = blocked.get(key);
    if (gate && !gate.started) {
      gate.started = true;
      gate.entered.resolve();
      await gate.resume.promise;
    }
    return read(keys);
  };

  for (const [key, first, second] of [
    ['settings', 7, { alpha: 1 }],
    ['settings.migrated', ['two'], ['three']],
  ]) {
    const gate = { started: false, entered: deferred(), resume: deferred() };
    blocked.set(key, gate);
    await chrome.storage.local.set({ [key]: first });
    await gate.entered.promise;
    await chrome.storage.local.set({ [key]: second });
    gate.resume.resolve();
    await settle();
  }
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  assert.deepEqual(data.settings, { alpha: 1, beta: 2 });
  assert.deepEqual([...data['settings.migrated']].sort(), ['one', 'three', 'two']);
});

test('consecutive malformed writes preserve the last valid record or receipt absence', async () => {
  const { context, chrome, data } = worker({ saved: { settings: { alpha: true, beta: true } } });
  const read = chrome.storage.local.get;
  const blocked = new Map();
  chrome.storage.local.get = async (keys) => {
    const key = Array.isArray(keys) && keys.length === 1 ? keys[0] : null;
    const gate = blocked.get(key);
    if (gate && !gate.started) {
      gate.started = true;
      gate.entered.resolve();
      await gate.resume.promise;
    }
    return read(keys);
  };

  for (const key of ['settings', 'settings@abc.migrated']) {
    const gate = { started: false, entered: deferred(), resume: deferred() };
    blocked.set(key, gate);
    await chrome.storage.local.set({ [key]: 7 });
    await gate.entered.promise;
    await chrome.storage.local.set({ [key]: 8 });
    gate.resume.resolve();
    await settle();
  }
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  assert.deepEqual(data.settings, { alpha: true, beta: true });
  assert.equal(Object.hasOwn(data, 'settings@abc.migrated'), false);
});

test('an empty valid successor advances a malformed-record recovery chain', async () => {
  const { context, chrome, data } = worker({ saved: { settings: { alpha: true, beta: true } } });
  const read = chrome.storage.local.get;
  const entered = deferred();
  const resume = deferred();
  let block = true;
  chrome.storage.local.get = async (keys) => {
    if (block && Array.isArray(keys) && keys.length === 1 && keys[0] === 'settings') {
      block = false;
      entered.resolve();
      await resume.promise;
    }
    return read(keys);
  };

  await chrome.storage.local.set({ settings: 7 });
  await entered.promise;
  await chrome.storage.local.set({ settings: {} });
  resume.resolve();
  await settle();
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  assert.deepEqual(data.settings, { alpha: true, beta: true });
});

test('a stale callback cannot replace durable recovery for the current direct value', async () => {
  const { context, chrome, data, listeners } = worker({ saved: { settings: { alpha: 0 } } });
  const write = chrome.storage.local.set;
  data.settings = { alpha: 2 };
  chrome.storage.local.set = async () => { throw new Error('commit unavailable'); };
  listeners.storageChanged.forEach((listener) => listener({
    settings: { oldValue: { alpha: 1 }, newValue: { alpha: 2 } },
  }, 'local'));
  await new Promise((resolve) => setTimeout(resolve, 225));

  chrome.storage.local.set = write;
  listeners.storageChanged.forEach((listener) => listener({
    settings: { oldValue: { alpha: 0 }, newValue: { alpha: 1 } },
  }, 'local'));
  await settle();
  await context.recoverDirectPreferences();

  assert.deepEqual(data.settings, { alpha: 2 });
  assert.equal(Number.isSafeInteger(data['hushfacebookWeb.storageRevisions'].settings), true);
});

test('an unreadable stale callback cannot replace durable recovery for the current value', async () => {
  const { context, chrome, data, listeners } = worker({ saved: { settings: { alpha: 0 } } });
  const read = chrome.storage.local.get;
  const write = chrome.storage.local.set;
  data.settings = { alpha: 2 };
  chrome.storage.local.set = async () => { throw new Error('commit unavailable'); };
  listeners.storageChanged.forEach((listener) => listener({
    settings: { oldValue: { alpha: 1 }, newValue: { alpha: 2 } },
  }, 'local'));
  await new Promise((resolve) => setTimeout(resolve, 225));

  chrome.storage.local.set = write;
  chrome.storage.local.get = async () => { throw new Error('read unavailable'); };
  listeners.storageChanged.forEach((listener) => listener({
    settings: { oldValue: { alpha: 0 }, newValue: { alpha: 1 } },
  }, 'local'));
  await new Promise((resolve) => setTimeout(resolve, 225));
  chrome.storage.local.get = read;
  await context.recoverDirectPreferences();

  assert.deepEqual(data.settings, { alpha: 2 });
  assert.equal(Number.isSafeInteger(data['hushfacebookWeb.storageRevisions'].settings), true);
});

test('a retained receipt union survives a later direct replacement', async () => {
  const { context, chrome, data, listeners } = worker({ saved: { 'settings.migrated': ['one'] } });
  const write = chrome.storage.local.set;
  data['settings.migrated'] = ['two'];
  chrome.storage.local.set = async () => { throw new Error('commit unavailable'); };
  listeners.storageChanged.forEach((listener) => listener({
    'settings.migrated': { oldValue: ['one'], newValue: ['two'] },
  }, 'local'));
  await new Promise((resolve) => setTimeout(resolve, 225));

  chrome.storage.local.set = write;
  data['settings.migrated'] = ['three'];
  listeners.storageChanged.forEach((listener) => listener({
    'settings.migrated': { oldValue: ['two'], newValue: ['three'] },
  }, 'local'));
  await settle();
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  assert.deepEqual([...data['settings.migrated']].sort(), ['one', 'three', 'two']);
});

test('multiple durable receipt failures merge before recovery', async () => {
  const { context, data } = worker({ saved: { 'settings.migrated': ['three'] } });

  await context.rememberDirectRecovery('settings.migrated', ['two'], { union: ['one', 'two'] });
  await context.rememberDirectRecovery('settings.migrated', ['three'], { union: ['two', 'three'] });
  await context.recoverDirectPreferences();

  assert.deepEqual([...data['settings.migrated']].sort(), ['one', 'three', 'two']);
});

test('a stale receipt callback still joins a newer durable union', async () => {
  const { context, data, listeners } = worker({ saved: { 'settings.migrated': ['two'] } });
  await context.rememberDirectRecovery('settings.migrated', ['two'], { union: ['one', 'two'] });

  listeners.storageChanged.forEach((listener) => listener({
    'settings.migrated': { oldValue: ['zero'], newValue: ['one'] },
  }, 'local'));
  await settle();
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  assert.deepEqual([...data['settings.migrated']].sort(), ['one', 'two', 'zero']);
});

test('a delayed receipt union joins a conditional malformed-value repair', async () => {
  const key = 'settings@abc.migrated';
  const { context, data, listeners } = worker({ saved: { [key]: 7 } });
  await context.rememberDirectRecovery(key, 7, { removeRecord: true });

  listeners.storageChanged.forEach((listener) => listener({
    [key]: { oldValue: ['one'], newValue: undefined },
  }, 'local'));
  await settle();
  await context.recoverDirectPreferences();

  assert.deepEqual(data[key], ['one']);
});

test('a current receipt callback turns a conditional repair into a monotonic union', async () => {
  const key = 'settings@abc.migrated';
  const { context, data, listeners } = worker({ saved: { [key]: ['two'] } });
  await context.rememberDirectRecovery(key, 7, { removeRecord: true });

  listeners.storageChanged.forEach((listener) => listener({
    [key]: { oldValue: ['one'], newValue: ['two'] },
  }, 'local'));
  await settle();
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  assert.deepEqual([...data[key]].sort(), ['one', 'two']);
});

test('a valid empty receipt successor is acknowledged after malformed recovery', async () => {
  const key = 'settings@abc.migrated';
  const { context, data, listeners } = worker({ saved: { [key]: [] } });
  await context.rememberDirectRecovery(key, 7, { removeRecord: true });

  listeners.storageChanged.forEach((listener) => listener({
    [key]: { oldValue: 7, newValue: [] },
  }, 'local'));
  await settle();
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  assert.deepEqual(data[key], []);
  assert.equal(Number.isSafeInteger(data['hushfacebookWeb.storageRevisions'][key]), true);
});

test('a malformed direct preference record is restored and acknowledged immediately', async () => {
  const { context, chrome, data } = worker({ saved: { settings: { alpha: true } } });

  await chrome.storage.local.set({ settings: 7 });
  await settle();
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  assert.deepEqual(data.settings, { alpha: true });
  assert.equal(Number.isSafeInteger(data['hushfacebookWeb.storageRevisions'].settings), true);
});

test('direct empty account records are acknowledged from absence or malformed storage', async () => {
  const { context, chrome, data } = worker({ saved: { 'settings@def': 7 } });

  await chrome.storage.local.set({ 'settings@abc': {}, 'settings@def': {} });
  await settle();
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  assert.deepEqual(data['settings@abc'], {});
  assert.deepEqual(data['settings@def'], {});
  assert.equal(Number.isSafeInteger(data['hushfacebookWeb.storageRevisions']['settings@abc']), true);
  assert.equal(Number.isSafeInteger(data['hushfacebookWeb.storageRevisions']['settings@def']), true);
});

test('direct deletion of malformed preference records stays absent and is acknowledged', async () => {
  const keys = ['settings@abc', 'settings@abc.migrated'];
  const { context, chrome, data } = worker({
    saved: Object.fromEntries(keys.map((key) => [key, 7])),
  });

  for (const key of keys) await chrome.storage.local.remove(key);
  await settle();
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  for (const key of keys) {
    assert.equal(Object.hasOwn(data, key), false, key);
    assert.equal(Number.isSafeInteger(data['hushfacebookWeb.storageRevisions'][key]), true, key);
  }
});

test('direct deletion of valid migration receipts retains their accepted ids', async () => {
  const key = 'settings@abc.migrated';
  const { context, chrome, data } = worker({ saved: { [key]: ['one'] } });

  await chrome.storage.local.remove(key);
  await settle();
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  assert.deepEqual(data[key], ['one']);
  assert.equal(Number.isSafeInteger(data['hushfacebookWeb.storageRevisions'][key]), true);
});

test('a malformed direct record cannot turn an absent account into an empty one', async () => {
  const { context, chrome, data } = worker({
    saved: { settings: { shared: true } },
  });

  await chrome.storage.local.set({ 'settings@abc': 7, 'settings@abc.migrated': [7] });
  await settle();
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  assert.equal(Object.hasOwn(data, 'settings@abc'), false);
  assert.equal(Object.hasOwn(data, 'settings@abc.migrated'), false);
  assert.equal(Number.isSafeInteger(data['hushfacebookWeb.storageRevisions']['settings@abc']), true);
  assert.equal(Number.isSafeInteger(data['hushfacebookWeb.storageRevisions']['settings@abc.migrated']), true);
});

test('a malformed absent-record repair finishes its revision after a partial removal failure', async () => {
  const { context, chrome, data, listeners, calls } = worker({ tabs: { 7: true } });
  const write = chrome.storage.local.set;
  let failRevision = true;
  chrome.storage.local.set = async (items) => {
    if (failRevision && Object.keys(items).length === 1 && Object.hasOwn(items, 'hushfacebookWeb.storageRevisions')) {
      failRevision = false;
      throw new Error('brief revision failure');
    }
    return write(items);
  };
  data['settings@abc'] = 7;
  listeners.storageChanged.forEach((listener) => listener({
    'settings@abc': { oldValue: undefined, newValue: 7 },
  }, 'local'));
  await new Promise((resolve) => setTimeout(resolve, 75));
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

  assert.equal(Object.hasOwn(data, 'settings@abc'), false);
  assert.equal(Number.isSafeInteger(data['hushfacebookWeb.storageRevisions']['settings@abc']), true);
  assert.deepEqual(calls.sent, []);
});

test('malformed absent-record recovery cannot erase a valid worker commit', async () => {
  for (const [key, mutation, expected] of [
    ['settings@abc', { set: { alpha: true } }, { alpha: true }],
    ['settings@abc.migrated', { union: ['one'] }, ['one']],
  ]) {
    const { context, chrome, data } = worker();
    const read = chrome.storage.local.get;
    const readStarted = deferred();
    const resume = deferred();
    let pauseRead = true;
    chrome.storage.local.get = async (keys) => {
      const snapshot = await read(keys);
      if (pauseRead) {
        pauseRead = false;
        readStarted.resolve();
        await resume.promise;
      }
      return snapshot;
    };

    const local = context.mutateStorage({ key, mutation });
    await readStarted.promise;
    await chrome.storage.local.set({ [key]: 7 });
    resume.resolve();
    await local;
    await settle();
    await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });

    assert.deepEqual(data[key], expected, key);
    assert.equal(Number.isSafeInteger(data['hushfacebookWeb.storageRevisions'][key]), true, key);
  }
});

test('direct reconciliation retries transient reads and reports an exhausted failure', async () => {
  const transient = worker({ saved: { settings: { alpha: 0 } } });
  const transientRead = transient.chrome.storage.local.get;
  let transientAttempts = 0;
  transient.chrome.storage.local.get = async (...args) => {
    transientAttempts++;
    if (transientAttempts < 3) throw new Error('brief read failure');
    return transientRead(...args);
  };
  transient.data.settings = { alpha: 1 };
  transient.listeners.storageChanged.forEach((listener) => listener({
    settings: { oldValue: { alpha: 0 }, newValue: { alpha: 1 } },
  }, 'local'));
  await new Promise((resolve) => setTimeout(resolve, 225));
  assert.equal(transientAttempts, 4, 'three event-verification attempts plus the authoritative commit read');
  assert.equal(Number.isSafeInteger(transient.data['hushfacebookWeb.storageRevisions'].settings), true);

  const recoverySession = {};
  const exhausted = worker({
    saved: {
      settings: { alpha: 0, beta: 2 },
      'settings.migrated': ['one'],
    },
    session: recoverySession,
    tabs: { 7: true },
  });
  exhausted.chrome.storage.local.get = async () => { throw new Error('storage unavailable'); };
  exhausted.data.settings = 7;
  exhausted.data['settings@abc'] = 'bad';
  exhausted.data['settings.migrated'] = ['two'];
  exhausted.listeners.storageChanged.forEach((listener) => listener({
    settings: { oldValue: { alpha: 0, beta: 2 }, newValue: 7 },
    'settings@abc': { oldValue: undefined, newValue: 'bad' },
    'settings.migrated': { oldValue: ['one'], newValue: ['two'] },
  }, 'local'));
  await new Promise((resolve) => setTimeout(resolve, 225));
  assert.deepEqual(exhausted.calls.sent, [
    [7, 'storage-error'],
    [7, 'storage-error'],
    [7, 'storage-error'],
  ]);
  assert.equal(exhausted.data['hushfacebookWeb.storageRevisions'], undefined);

  const restarted = worker({ saved: exhausted.data, session: recoverySession });
  await restarted.context.recoverDirectPreferences();
  assert.deepEqual(restarted.data.settings, { alpha: 0, beta: 2 });
  assert.equal(Object.hasOwn(restarted.data, 'settings@abc'), false);
  assert.deepEqual([...restarted.data['settings.migrated']].sort(), ['one', 'two']);
  const recovered = await restarted.context.mutateStorage({
    key: 'settings',
    mutation: { set: { alpha: 2 } },
  });
  assert.deepEqual(recovered.value, { alpha: 2, beta: 2 });
  assert.deepEqual(restarted.data.settings, { alpha: 2, beta: 2 });
  assert.equal(Number.isSafeInteger(restarted.data['hushfacebookWeb.storageRevisions'].settings), true);
});

test('durable direct recovery retries transient session reads and reports journal write failures', async () => {
  const recoveryKey = 'hushfacebookWeb.pendingPreferenceRecovery';
  const session = {
    [recoveryKey]: {
      settings: {
        missing: false,
        expected: 7,
        mutation: { replace: { alpha: true } },
      },
    },
  };
  const recovering = worker({ saved: { settings: 7 }, session });
  const readSession = recovering.chrome.storage.session.get;
  let failRead = true;
  recovering.chrome.storage.session.get = async (...args) => {
    if (failRead) {
      failRead = false;
      throw new Error('brief session read failure');
    }
    return readSession(...args);
  };

  await assert.rejects(recovering.context.recoverDirectPreferences(), /brief session read failure/);
  await recovering.context.recoverDirectPreferences();
  assert.deepEqual(recovering.data.settings, { alpha: true });

  const retaining = worker({ saved: { settings: 7 } });
  const writeSession = retaining.chrome.storage.session.set;
  retaining.chrome.storage.session.set = async () => { throw new Error('session journal unavailable'); };
  await assert.rejects(
    retaining.context.rememberDirectRecovery('settings', 7, { replace: { beta: true } }),
    /session journal unavailable/,
  );
  retaining.chrome.storage.session.set = writeSession;
  await retaining.context.recoverDirectPreferences();
  assert.deepEqual(retaining.data.settings, { beta: true });
});

test('a failed first journal read retains new direct records and receipts for Retry', async () => {
  for (const { key, initial, direct, expected } of [
    { key: 'settings', initial: { alpha: true }, direct: 7, expected: { alpha: true } },
    { key: 'settings.migrated', initial: ['one'], direct: ['two'], expected: ['one', 'two'] },
  ]) {
    const failed = deferred();
    const current = worker({ saved: { [key]: initial } });
    const readSession = current.chrome.storage.session.get;
    current.chrome.storage.session.get = async () => {
      failed.resolve();
      throw new Error('brief session read failure');
    };

    await current.chrome.storage.local.set({ [key]: direct });
    await failed.promise;
    await settle();
    current.chrome.storage.session.get = readSession;
    await current.context.recoverDirectPreferences();

    const actual = key.endsWith('.migrated') ? [...current.data[key]].sort() : current.data[key];
    assert.deepEqual(actual, expected, key);
    assert.equal(Number.isSafeInteger(current.data['hushfacebookWeb.storageRevisions'][key]), true, key);
  }
});

test('a deferred direct change composes with recovery loaded on Retry', async () => {
  const recoveryKey = 'hushfacebookWeb.pendingPreferenceRecovery';
  for (const { key, saved, recovery, direct, expected } of [
    {
      key: 'settings',
      saved: 7,
      recovery: { missing: false, expected: 7, mutation: { replace: { alpha: true } } },
      direct: 8,
      expected: { alpha: true },
    },
    {
      key: 'settings.migrated',
      saved: ['two'],
      recovery: { missing: false, expected: ['two'], mutation: { union: ['one', 'two'] } },
      direct: ['three'],
      expected: ['one', 'three', 'two'],
    },
  ]) {
    const failed = deferred();
    const current = worker({
      saved: { [key]: saved },
      session: { [recoveryKey]: { [key]: recovery } },
    });
    const readSession = current.chrome.storage.session.get;
    current.chrome.storage.session.get = async () => {
      failed.resolve();
      throw new Error('brief session read failure');
    };

    await current.chrome.storage.local.set({ [key]: direct });
    await failed.promise;
    await settle();
    current.chrome.storage.session.get = readSession;
    await current.context.recoverDirectPreferences();

    const actual = key.endsWith('.migrated') ? [...current.data[key]].sort() : current.data[key];
    assert.deepEqual(actual, expected, key);
  }
});

test('deferred direct changes stay bounded per key without losing fields or receipts', async () => {
  const { context, data } = worker({ saved: { settings: {}, 'settings.migrated': [] } });
  let record = {};
  let receipt = [];
  for (let index = 0; index < 100; index++) {
    const nextRecord = { ...record, [`field${index}`]: index };
    const recordChange = { oldValue: record, newValue: nextRecord };
    context.deferDirectChange(
      'settings',
      recordChange,
      context.directPreferenceMutation('settings', recordChange),
      index === 99,
    );
    record = nextRecord;

    const nextReceipt = [`migration${index}`];
    const receiptChange = { oldValue: receipt, newValue: nextReceipt };
    context.deferDirectChange(
      'settings.migrated',
      receiptChange,
      context.directPreferenceMutation('settings.migrated', receiptChange),
      index === 99,
    );
    receipt = nextReceipt;
  }
  data.settings = structuredClone(record);
  data['settings.migrated'] = structuredClone(receipt);

  assert.equal(vm.runInContext('deferredDirectChanges.size', context), 2);
  await context.recoverDirectPreferences();

  assert.deepEqual(data.settings, record);
  assert.equal(data['settings.migrated'].length, 100);
  assert.deepEqual(new Set(data['settings.migrated']), new Set(Array.from({ length: 100 }, (_, i) => `migration${i}`)));
  assert.equal(vm.runInContext('deferredDirectChanges.size', context), 0);
});

test('a failed direct-write verification reports an older worker overwrite instead of dropping it', async () => {
  const { context, chrome, data, calls } = worker({
    saved: { settings: { alpha: 0 } },
    tabs: { 7: true },
  });
  const read = chrome.storage.local.get;
  const workerRead = deferred();
  const resumeWorker = deferred();
  const verificationFailed = deferred();
  let reads = 0;
  chrome.storage.local.get = async (keys) => {
    reads++;
    if (reads === 1) {
      const snapshot = await read(keys);
      workerRead.resolve();
      await resumeWorker.promise;
      return snapshot;
    }
    if (reads === 2) {
      verificationFailed.resolve();
      throw new Error('brief verification failure');
    }
    return read(keys);
  };

  const local = context.mutateStorage({ key: 'settings', mutation: { set: { alpha: 1 } } });
  await workerRead.promise;
  await chrome.storage.local.set({ settings: { alpha: 2 } });
  await verificationFailed.promise;
  resumeWorker.resolve();
  await local;
  await new Promise((resolve) => setTimeout(resolve, 75));
  await context.mutateStorage({ key: 'drain', mutation: { set: { done: true } } });
  await context.recoverDirectPreferences();

  assert.deepEqual(data.settings, { alpha: 1 });
  assert.deepEqual(calls.sent, [[7, 'storage-error']]);
});

// Facebook's top frame, as Chrome describes the sender of the isolated script's messages.
const topFrame = (id = 1, url = 'https://www.facebook.com/') => ({
  tab: { id }, frameId: 0, origin: new URL(url).origin, url, documentId: `document-${id}`,
});
// One message through the worker's listener. Null means it never answered.
function ask({ listeners }, message, sender = topFrame()) {
  return new Promise((resolve) => {
    let answered = false;
    const kept = listeners.messages[0](message, sender, (answer) => {
      answered = true;
      resolve(answer);
    });
    if (!kept && !answered) resolve(null);
  });
}

test('the worker answers only the isolated script in a Facebook top frame', async () => {
  const current = worker({ saved: { settings: { alpha: true } } });
  const recover = { type: 'storage:recover' };
  assert.equal(await ask(current, recover, { id: 'popup', url: 'chrome-extension://abc/popup.html' }), null);
  for (const sender of [
    { ...topFrame(), frameId: 3 },
    { ...topFrame(), frameId: 3, documentLifecycle: 'active' },
    { tab: { id: 1 }, frameId: 2, origin: 'https://game1.apps.fbsbx.com', url: 'https://game1.apps.fbsbx.com/' },
    topFrame(1, 'http://www.facebook.com/'),
    topFrame(1, 'https://www.facebook.com.evil.example/'),
    { ...topFrame(), origin: 'https://evil.example' },
    { ...topFrame(), url: 'https://evil.example/' },
    { ...topFrame(), tab: { id: '1' } },
  ]) {
    const answer = await ask(current, recover, sender);
    assert.equal(answer.ok, false, JSON.stringify(sender));
    assert.match(answer.error, /cannot ask the extension/);
  }
  assert.equal((await ask(current, recover, topFrame(2, 'https://web.facebook.com/groups/feed/'))).ok, true);
  // Chrome gives a prerendered page's top frame its own frameId until the page is shown.
  const prerendered = { ...topFrame(3), frameId: 41, documentLifecycle: 'prerender' };
  assert.equal((await ask(current, recover, prerendered)).ok, true, 'a prerendered Facebook page loads its settings');
});

test('the worker refuses request shapes, keys and file names it does not know', async () => {
  const current = worker({ saved: { settings: { alpha: true }, other: 'x' } });
  for (const message of [
    { type: 'storage:remove', key: 'other' },
    { type: 'storage:set', key: 'settings', value: {} },
    { type: 'storage:recover', extra: true },
    { type: 'storage:mutate', key: 'hushfacebookWeb.storageRevisions', mutation: { set: {} } },
    { type: 'storage:mutate', key: 'other', mutation: { set: {} } },
    { type: 'storage:mutate', key: 'settings', mutation: { set: { alpha: { nested: true } } } },
    { type: 'storage:mutate', key: 'settings', mutation: { set: JSON.parse('{"__proto__":true}') } },
    { type: 'storage:mutate', key: 'settings', mutation: { set: { css: 'x'.repeat(70000) } } },
    { type: 'storage:mutate', key: 'settings.migrated', mutation: { union: ['Bad id'] } },
    { type: 'storage:migrate', key: 'settings@abc', doneKey: 'settings@abc.migrated', mutation: { set: {} }, receipt: [], sourceKey: 'other', sourceDoneKey: 'settings.migrated' },
    { type: 'download', url: 'https://scontent.xx.fbcdn.net/v/a.jpg', name: '../a.jpg' },
    { type: 'download', url: 'https://scontent.xx.fbcdn.net/v/a.jpg', name: 'CON.jpg' },
    { type: 'download', url: 'https://scontent.xx.fbcdn.net/v/a.jpg', name: 'flag \u{e0067}\u{e0062}.jpg' },
    { type: 'download', url: 'https://scontent.xx.fbcdn.net/v/a.jpg', name: 'photo.jpg‮gpj' },
    { type: 'download', url: 'https://scontent.xx.fbcdn.net/v/a.jpg', name: '.hidden.jpg' },
    { type: 'download', url: 'https://scontent.xx.fbcdn.net/v/a.jpg', name: 'no extension' },
    { type: 'download', url: 'https://scontent.xx.fbcdn.net/v/a.jpg', name: 'a.jpg', saveAs: true },
  ]) {
    const answer = await ask(current, message);
    assert.equal(answer.ok, false, JSON.stringify(message));
    assert.match(answer.error, /not allowed/, JSON.stringify(message));
  }
  assert.equal(current.data.other, 'x');
  assert.deepEqual(current.calls.downloads, []);

  const css = await ask(current, { type: 'storage:mutate', key: 'settings', mutation: { set: { customCss: 'x'.repeat(50000) } } });
  assert.equal(css.ok, true, 'the longest text setting still saves');
  assert.equal(current.data.settings.customCss.length, 50000);
  for (const [url, error] of [
    ['https://example.com/a.jpg', /not a Facebook file/],
    ['https://user:pass@scontent.xx.fbcdn.net/a.jpg', /not a Facebook file/],
    ['https://scontent.xx.fbcdn.net:8443/a.jpg', /not a Facebook file/],
  ]) {
    const answer = await ask(current, { type: 'download', url, name: 'a.jpg' });
    assert.equal(answer.ok, false, url);
    assert.match(answer.error, error, url);
  }
});

test('downloads stop at eight a window for each page, and another page keeps its own allowance', async () => {
  const current = worker();
  const download = { type: 'download', url: 'https://scontent.xx.fbcdn.net/v/a.jpg', name: 'Pat photo.jpg' };
  const saving = Array.from({ length: 8 }, () => ask(current, download));
  await settle();
  assert.equal(current.calls.downloads.length, 8);
  const ninth = await ask(current, download);
  assert.equal(ninth.ok, false);
  assert.match(ninth.error, /too many extension requests/);
  assert.equal(current.calls.downloads.length, 8, 'the ninth never reached chrome.downloads');
  current.listeners.downloadChanged.forEach((fn) => fn({ id: 7, state: { current: 'complete' } }));
  for (const answer of await Promise.all(saving)) assert.equal(answer.ok, true);

  const other = ask(current, download, topFrame(2));
  await settle();
  assert.equal(current.calls.downloads.length, 9);
  current.listeners.downloadChanged.forEach((fn) => fn({ id: 7, state: { current: 'complete' } }));
  assert.equal((await other).ok, true);
});
