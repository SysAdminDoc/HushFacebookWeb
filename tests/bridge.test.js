// The extension's two halves: the page script's bridge (src/core/bridge.js) and the isolated
// content script (extension/isolated.js), run against each other over a happy-dom document
// with a stand-in for chrome.storage and the background.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  HELLO_ISOLATED,
  HELLO_MAIN,
  STORAGE_REVISION_EPOCH_KEY,
  STORAGE_REVISION_ORDER_KEY,
  STORAGE_REVISIONS_KEY,
  bridgeDownload,
  channelNames,
  connectBridge,
  createBridgeStorage,
} from '../src/core/bridge.js';
import { createSettings, storageKeyFor } from '../src/core/settings.js';
import { createSeenStore, SEEN_KEY } from '../src/core/seen-store.js';
import { applyObjectMutation } from '../src/core/storage.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const revisions = (epoch, order, keys = {}) => ({
  [STORAGE_REVISION_EPOCH_KEY]: epoch,
  [STORAGE_REVISION_ORDER_KEY]: order,
  ...keys,
});
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// chrome.storage.local, chrome.runtime and the background's answers to downloads.
function fakeChrome(saved = {}, {
  download = () => ({ ok: true }),
  read,
  mutate = applyObjectMutation,
  migrate,
} = {}) {
  const data = structuredClone(saved);
  const changed = [];
  const fromBackground = [];
  const sent = [];
  let initialRead = read;
  let mutationTail = Promise.resolve();
  const tell = (changes) => queueMicrotask(() => changed.forEach((listener) => listener(changes, 'local')));
  return {
    data,
    sent,
    emitStorageChange: tell,
    openSettings: () => fromBackground.forEach((listener) => listener({ type: 'open-settings' })),
    storage: {
      local: {
        get: async () => {
          if (!initialRead) return structuredClone(data);
          const run = initialRead;
          initialRead = null;
          return run(data);
        },
        async set(items) {
          const changes = {};
          for (const [key, value] of Object.entries(items)) {
            changes[key] = { oldValue: data[key], newValue: structuredClone(value) };
            data[key] = structuredClone(value);
          }
          tell(changes);
        },
        async remove(key) {
          const changes = { [key]: { oldValue: data[key] } };
          delete data[key];
          tell(changes);
        },
      },
      onChanged: { addListener: (listener) => changed.push(listener) },
    },
    runtime: {
      async sendMessage(message) {
        sent.push(message);
        if (message.type === 'storage:mutate' || message.type === 'storage:migrate') {
          const run = async () => {
            try {
            const oldValue = data[message.key];
            const oldReceipt = message.type === 'storage:migrate' ? data[message.doneKey] : undefined;
            const copiesSource = message.type === 'storage:migrate'
              && oldValue === undefined
              && message.sourceKey
              && message.sourceKey !== message.key;
            const migrationRecord = copiesSource ? data[message.sourceKey] : oldValue;
            const migrationReceipt = [...new Set([
              ...(Array.isArray(oldReceipt) ? oldReceipt : []),
              ...(copiesSource && Array.isArray(data[message.sourceDoneKey]) ? data[message.sourceDoneKey] : []),
            ])];
            let result;
            let nextReceipt;
            if (message.type === 'storage:migrate') {
              const done = migrationReceipt;
              const pending = message.receipt.filter((id) => !done.includes(id));
              const initializes = oldValue === undefined && Object.hasOwn(message.mutation, 'initialize');
              const guardMatches = Object.entries(message.mutation.guard ?? {}).every(([name, condition]) => {
                const source = migrationRecord && typeof migrationRecord === 'object' ? migrationRecord : {};
                const exists = Object.hasOwn(source, name);
                return exists === condition.exists
                  && (!exists || JSON.stringify(source[name]) === JSON.stringify(condition.value));
              });
              if (pending.length && !guardMatches) {
                const currentRevisions = structuredClone(data[STORAGE_REVISIONS_KEY]);
                return {
                  ok: true,
                  result: {
                    value: structuredClone(migrationRecord),
                    previous: structuredClone(migrationRecord),
                    receipt: structuredClone(done),
                    completedBefore: structuredClone(done),
                    revision: Number.isSafeInteger(currentRevisions?.[message.key]) ? currentRevisions[message.key] : null,
                    epoch: typeof currentRevisions?.[STORAGE_REVISION_EPOCH_KEY] === 'string'
                      ? currentRevisions[STORAGE_REVISION_EPOCH_KEY]
                      : null,
                    revisions: currentRevisions,
                    committed: false,
                    conflict: true,
                    copyAll: Boolean(copiesSource),
                  },
                };
              }
              let effective = message.mutation;
              if (!pending.length && message.mutation.conditions) {
                const conditional = new Set(Object.keys(message.mutation.conditions));
                effective = {
                  ...(Object.hasOwn(message.mutation, 'initialize') ? { initialize: message.mutation.initialize } : {}),
                  set: Object.fromEntries(Object.entries(message.mutation.set ?? {}).filter(([name]) => !conditional.has(name))),
                  remove: (message.mutation.remove ?? []).filter((name) => !conditional.has(name)),
                };
              }
              if (initializes) effective = { ...effective, initialize: structuredClone(migrationRecord ?? {}) };
              const migrated = migrate
                ? await migrate({ record: migrationRecord, receipt: done, message, mutation: effective })
                : { value: await mutate(oldValue, effective, message.key), receipt: [...new Set([...done, ...message.receipt])] };
              result = migrated.value;
              nextReceipt = migrated.receipt;
            } else {
              result = await mutate(oldValue, message.mutation, message.key);
            }
            const oldRevisions = structuredClone(data[STORAGE_REVISIONS_KEY]);
            const valid = oldRevisions
              && typeof oldRevisions[STORAGE_REVISION_EPOCH_KEY] === 'string'
              && Number.isSafeInteger(oldRevisions[STORAGE_REVISION_ORDER_KEY])
              && oldRevisions[STORAGE_REVISION_ORDER_KEY] >= 0
              && Object.entries(oldRevisions).every(([name, value]) => (
                name === STORAGE_REVISION_EPOCH_KEY
                || (Number.isSafeInteger(value) && value >= 0 && value <= oldRevisions[STORAGE_REVISION_ORDER_KEY])
              ));
            const sameBase = JSON.stringify(oldRevisions) === JSON.stringify(message.baseRevisions);
            const resetMatches = typeof message.generation === 'string'
              && message.generation
              && message.generation !== oldRevisions?.[STORAGE_REVISION_EPOCH_KEY]
              && sameBase;
            const resetPrecededRequest = valid
              && message.baseRevisions?.[STORAGE_REVISION_EPOCH_KEY] === oldRevisions[STORAGE_REVISION_EPOCH_KEY]
              && (
                oldRevisions[STORAGE_REVISION_ORDER_KEY] < message.baseRevisions[STORAGE_REVISION_ORDER_KEY]
                || Object.entries(message.baseRevisions).some(([name, revision]) => (
                  name !== STORAGE_REVISION_EPOCH_KEY
                  && name !== STORAGE_REVISION_ORDER_KEY
                  && (!Number.isSafeInteger(oldRevisions[name]) || oldRevisions[name] < revision)
                ))
              );
            const continuing = valid
              && oldRevisions[STORAGE_REVISION_ORDER_KEY] < Number.MAX_SAFE_INTEGER
              && !resetMatches
              && !resetPrecededRequest;
            const epoch = continuing
              ? oldRevisions[STORAGE_REVISION_EPOCH_KEY]
              : resetMatches ? message.generation : randomUUID();
            const revisions = continuing ? structuredClone(oldRevisions) : {
              [STORAGE_REVISION_EPOCH_KEY]: epoch,
              [STORAGE_REVISION_ORDER_KEY]: 0,
            };
            const revision = revisions[STORAGE_REVISION_ORDER_KEY] + 1;
            revisions[STORAGE_REVISION_ORDER_KEY] = revision;
            revisions[message.key] = revision;
            if (message.type === 'storage:migrate') revisions[message.doneKey] = revision;
            data[message.key] = structuredClone(result);
            if (message.type === 'storage:migrate') data[message.doneKey] = structuredClone(nextReceipt);
            data[STORAGE_REVISIONS_KEY] = structuredClone(revisions);
            const changes = {
              [message.key]: { oldValue, newValue: structuredClone(result) },
              [STORAGE_REVISIONS_KEY]: { oldValue: oldRevisions, newValue: structuredClone(revisions) },
            };
            if (message.type === 'storage:migrate') {
              changes[message.doneKey] = { oldValue: oldReceipt, newValue: structuredClone(nextReceipt) };
            }
            tell(changes);
            return {
              ok: true,
              result: {
                value: result,
                previous: message.type === 'storage:migrate' ? migrationRecord : oldValue,
                completedBefore: message.type === 'storage:migrate' ? structuredClone(migrationReceipt) : undefined,
                revision,
                epoch,
                revisions: structuredClone(revisions),
                committed: true,
              },
            };
            } catch (error) {
              return { ok: false, error: String(error?.message ?? error) };
            }
          };
          const answer = mutationTail.then(run, run);
          mutationTail = answer.then(() => undefined, () => undefined);
          return answer;
        }
        return download(message);
      },
      onMessage: { addListener: (listener) => fromBackground.push(listener) },
    },
  };
}

let loads = 0;
// Runs extension/isolated.js as Chrome would, against this window and chrome stand-in.
async function startIsolated(win, chrome) {
  const saved = { document: globalThis.document, CustomEvent: globalThis.CustomEvent, chrome: globalThis.chrome };
  Object.assign(globalThis, { document: win.document, CustomEvent: win.CustomEvent, chrome });
  cleanups.push(() => Object.assign(globalThis, saved));
  await import(`../extension/isolated.js?run=${loads++}`);
}

function page() {
  const win = new Window({ url: 'https://www.facebook.com/' });
  cleanups.push(() => win.happyDOM.close());
  return win;
}

test('the halves find each other whichever starts first, and the secret stays off the page after', async () => {
  for (const isolatedFirst of [true, false]) {
    const win = page();
    const chrome = fakeChrome({ answer: 42 });
    if (isolatedFirst) await startIsolated(win, chrome);
    const bridge = connectBridge({ doc: win.document, win, secret: randomUUID() });
    if (!isolatedFirst) await startIsolated(win, chrome);
    await settle();
    assert.equal(bridge.connected(), true, `connected when the isolated half starts ${isolatedFirst ? 'first' : 'second'}`);
    assert.deepEqual({ ...(await bridge.request('storage:load')) }, { answer: 42 });

    // A page script asking later hears nothing.
    const heard = [];
    win.document.addEventListener(HELLO_MAIN, (event) => heard.push(event.detail));
    win.document.dispatchEvent(new win.CustomEvent(HELLO_ISOLATED));
    assert.deepEqual(heard, []);
  }
});

test('MAIN-first requests wait for readiness and are dispatched exactly once', async () => {
  const win = page();
  const secret = randomUUID();
  const { toIsolated } = channelNames(secret);
  const sent = [];
  win.document.addEventListener(toIsolated, (event) => sent.push(JSON.parse(event.detail)));
  const bridge = connectBridge({ doc: win.document, win, secret });
  const load = bridge.request('storage:load', null, { timeout: 100 });
  assert.deepEqual(sent, [], 'the request stays queued until the isolated half is listening');

  await startIsolated(win, fakeChrome({ answer: 42 }));
  assert.deepEqual({ ...(await load) }, { answer: 42 });
  assert.equal(sent.length, 1);
  win.document.dispatchEvent(new win.CustomEvent(channelNames(secret).toMain, { detail: JSON.stringify({ ready: true }) }));
  assert.equal(sent.length, 1, 'a repeated ready signal does not dispatch it again');
});

test('the pre-ready request queue is bounded and queued requests expire', async () => {
  const win = page();
  const bridge = connectBridge({ doc: win.document, win, secret: randomUUID(), maxPending: 1 });
  const first = bridge.request('storage:load', null, { timeout: 20 });
  await assert.rejects(bridge.request('storage:load', null, { timeout: 20 }), /too many extension requests/);
  await assert.rejects(first, /did not answer/);
  await assert.rejects(bridge.request('storage:load', null, { timeout: 20 }), /did not answer/, 'an expired request frees its queue slot');
});

test("a hello that isn't a secret is ignored, and only the real one opens the channel", async () => {
  const win = page();
  await startIsolated(win, fakeChrome({ answer: 1 }));
  win.document.dispatchEvent(new win.CustomEvent(HELLO_MAIN, { detail: 'not-a-secret' }));
  const bridge = connectBridge({ doc: win.document, win, secret: randomUUID() });
  await settle();
  assert.equal(bridge.connected(), true);
  assert.deepEqual({ ...(await bridge.request('storage:load')) }, { answer: 1 });
});

test('requests the isolated half has no answer for, or never answers, reject', async () => {
  const win = page();
  await startIsolated(win, fakeChrome());
  const bridge = connectBridge({ doc: win.document, win, secret: randomUUID() });
  await assert.rejects(bridge.request('nonsense'), /unknown request nonsense/);

  const silent = page();
  const alone = connectBridge({ doc: silent.document, win: silent, secret: randomUUID() });
  await assert.rejects(alone.request('storage:load', null, { timeout: 20 }), /did not answer/);
});

test('storage reads defaults until the saved copy arrives, then tells listeners and whenReady', async () => {
  const win = page();
  const chrome = fakeChrome({ 'keepSpeed.rate': 1.5, seen: { a: 1 } });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  assert.equal(storage.kind, 'extension');
  assert.equal(storage.get('keepSpeed.rate', 1), 1, 'the default until it loads');
  const told = [];
  storage.onChange('keepSpeed.rate', (value) => told.push(value));
  let ready = false;
  storage.whenReady(() => {
    ready = true;
  });
  await settle();
  assert.equal(ready, true);
  assert.deepEqual(told, [1.5]);
  assert.equal(storage.get('keepSpeed.rate', 1), 1.5);
  assert.equal(storage.getAtLoad('keepSpeed.rate', 1), 1.5);
  const ran = [];
  storage.whenReady(() => ran.push('now'));
  assert.deepEqual(ran, ['now'], 'once loaded, whenReady runs at once');
});

test('a write before the load keeps the newer value, and writes reach chrome.storage', async () => {
  const win = page();
  const chrome = fakeChrome({ 'keepSpeed.rate': 1.5 });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  storage.set('keepSpeed.rate', 2);
  await settle();
  assert.equal(storage.get('keepSpeed.rate'), 2);
  assert.equal(storage.getAtLoad('keepSpeed.rate'), 1.5, 'the original loaded value remains available');
  assert.equal(chrome.data['keepSpeed.rate'], 2);

  storage.remove('keepSpeed.rate');
  await settle();
  assert.equal(Object.hasOwn(chrome.data, 'keepSpeed.rate'), false);
  storage.set('gone', undefined);
  await settle();
  assert.equal(Object.hasOwn(chrome.data, 'gone'), false, 'undefined is a removal');
});

test('the real adapter preserves newer changes against a delayed snapshot in both script orders', async () => {
  for (const isolatedFirst of [true, false]) {
    const win = page();
    const load = deferred();
    const readStarted = deferred();
    const stale = {
      changed: 'old', removed: 'old', local: 'old', untouched: 'saved',
      localThenRemote: 'old', localThenRemoved: 'old',
    };
    const chrome = fakeChrome(stale, { read: () => {
      readStarted.resolve();
      return load.promise;
    } });
    if (isolatedFirst) await startIsolated(win, chrome);
    const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
    if (!isolatedFirst) await startIsolated(win, chrome);
    await readStarted.promise;

    await chrome.storage.local.set({ changed: 'new' });
    await chrome.storage.local.remove('removed');
    storage.set('local', 'mine');
    storage.set('localThenRemote', 'mine');
    storage.set('localThenRemoved', 'mine');
    await chrome.storage.local.set({ localThenRemote: 'theirs' });
    await chrome.storage.local.remove('localThenRemoved');
    await settle();
    const ready = new Promise((resolve) => storage.whenReady(resolve));
    load.resolve(stale);
    await ready;
    await settle();

    assert.equal(storage.get('changed'), 'new');
    assert.equal(storage.get('removed', 'missing'), 'missing');
    assert.equal(storage.get('local'), 'mine');
    assert.equal(storage.get('untouched'), 'saved');
    assert.equal(storage.get('localThenRemote'), 'theirs');
    assert.equal(storage.get('localThenRemoved', 'missing'), 'missing');
    assert.equal(storage.getAtLoad('changed'), 'new');
    assert.equal(storage.getAtLoad('removed', 'missing'), undefined, 'the remote deletion is a load-time tombstone');
    assert.equal(storage.getAtLoad('local'), 'old');
    assert.equal(chrome.data.localThenRemote, 'theirs', 'a newer remote set cancels the queued local write');
    assert.equal(Object.hasOwn(chrome.data, 'localThenRemoved'), false, 'a newer remote removal cancels the queued local write');
  }
});

test('seen posts recorded before load merge with saved history before the queued write is sent', async () => {
  const win = page();
  const load = deferred();
  const readStarted = deferred();
  const saved = { [SEEN_KEY]: { old: 100, same: 100 } };
  const chrome = fakeChrome(saved, { read: () => {
    readStarted.resolve();
    return load.promise;
  } });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  let scheduled = null;
  const seen = createSeenStore({
    storage,
    now: () => 200,
    schedule: (run) => { scheduled = run; return 1; },
    cancel: () => {},
    every: null,
  });
  await readStarted.promise;
  seen.add(['new', 'same']);
  scheduled();
  load.resolve(saved);
  await new Promise((resolve) => storage.whenReady(resolve));
  await settle();

  assert.equal(seen.has('old'), true);
  assert.equal(seen.has('new'), true);
  assert.deepEqual(chrome.data[SEEN_KEY], { new: 200, same: 100, old: 100 });
});

test('a failed initial load stays unready and can be retried', async () => {
  const retry = deferred();
  let loads = 0;
  const bridge = {
    request(type) {
      assert.equal(type, 'storage:load');
      loads++;
      return loads === 1 ? Promise.reject(new Error('bridge unavailable')) : retry.promise;
    },
    on() {},
  };
  const errors = [];
  const storage = createBridgeStorage(bridge, { log: { error: (...args) => errors.push(args) } });
  const settings = createSettings({ storage, features: [{ id: 'alpha', title: 'Alpha', default: true }], migrations: [] });
  const loaded = [];
  const states = [];
  const startupStates = [];
  storage.onStatus(({ state }) => states.push(state));
  settings.startup.onStatus(() => startupStates.push(settings.startup.status()));
  settings.whenLoaded(() => loaded.push(settings.get('alpha')));
  await settle();

  assert.equal(storage.status().state, 'error');
  assert.deepEqual(loaded, [], 'failed loading is not reported as loaded defaults');
  assert.equal(settings.startup.status(), 'error');
  assert.equal(errors.length, 1);
  const retried = storage.retry();
  assert.equal(storage.status().state, 'loading');
  retry.resolve({ settings: { alpha: false } });
  await retried;
  assert.equal(storage.status().state, 'ready');
  assert.deepEqual(loaded, [false]);
  assert.deepEqual(states, ['loading', 'error', 'loading', 'ready']);
  assert.deepEqual(startupStates, ['loading', 'error', 'loading', 'ready']);
  assert.deepEqual(storage.get('settings'), { alpha: false });
});

test('writes after a failed load wait for retry and retain untouched saved settings', async () => {
  const retry = deferred();
  const requests = [];
  let loads = 0;
  const bridge = {
    request(type, payload) {
      requests.push([type, payload]);
      if (type === 'storage:mutate') {
        return Promise.resolve({
          value: { beta: true, alpha: true },
          revision: 1,
          epoch: 'settings-generation',
          revisions: revisions('settings-generation', 1, { settings: 1 }),
        });
      }
      if (type !== 'storage:load') return Promise.resolve();
      loads++;
      return loads === 1 ? Promise.reject(new Error('bridge unavailable')) : retry.promise;
    },
    on() {},
  };
  const storage = createBridgeStorage(bridge);
  const features = [
    { id: 'alpha', title: 'Alpha', default: false },
    { id: 'beta', title: 'Beta', default: false },
  ];
  const settings = createSettings({ storage, features, migrations: [] });
  await settle();
  settings.set('alpha', true);
  assert.deepEqual(requests, [['storage:load', undefined]], 'the partial default-backed record is not sent after failure');

  const loaded = storage.retry();
  retry.resolve({ settings: { beta: true } });
  await loaded;
  await settle();

  assert.equal(settings.get('alpha'), true);
  assert.equal(settings.get('beta'), true);
  assert.deepEqual(requests, [
    ['storage:load', undefined],
    ['storage:load', undefined],
    ['storage:mutate', { key: 'settings', mutation: { set: { alpha: true }, remove: [] } }],
  ]);
});

test('a pre-load remote settings record merges with the independent local draft', async () => {
  for (const remote of [{ beta: true }, undefined]) {
    const win = page();
    const load = deferred();
    const readStarted = deferred();
    const stale = { settings: { alpha: false, beta: false } };
    const chrome = fakeChrome(stale, { read: () => {
      readStarted.resolve();
      return load.promise;
    } });
    await startIsolated(win, chrome);
    const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
    const settings = createSettings({
      storage,
      features: [
        { id: 'alpha', title: 'Alpha', default: false },
        { id: 'beta', title: 'Beta', default: false },
      ],
      migrations: [],
    });
    await readStarted.promise;
    const saved = settings.set('alpha', true);
    if (remote === undefined) await chrome.storage.local.remove('settings');
    else await chrome.storage.local.set({ settings: remote });
    load.resolve(stale);
    await new Promise((resolve) => settings.whenLoaded(resolve));
    await saved;
    await settle();

    assert.equal(settings.get('alpha'), true, `remote ${JSON.stringify(remote)}`);
    assert.equal(settings.get('beta'), remote?.beta ?? false);
    assert.deepEqual(chrome.data.settings, { ...(remote ?? {}), alpha: true });
  }
});

test('default-enabled features stay inactive until extension settings are confirmed', async () => {
  const load = deferred();
  const bridge = {
    request: (type) => {
      assert.equal(type, 'storage:load');
      return load.promise;
    },
    on() {},
  };
  const storage = createBridgeStorage(bridge);
  const settings = createSettings({ storage, features: [{ id: 'alpha', title: 'Alpha', default: true }], migrations: [] });
  assert.equal(settings.startup.status(), 'loading');
  assert.equal(settings.startup.matchesAccount(null), true);
  assert.equal(settings.startup.matchesAccount('another-account'), false);
  assert.equal(settings.get('alpha'), true, 'the settings UI can still show the default');
  assert.equal(settings.enabled('alpha'), false, 'irreversible feature decisions wait for storage');
  load.resolve({ settings: {} });
  await new Promise((resolve) => settings.whenLoaded(resolve));
  assert.equal(settings.startup.status(), 'ready');
  assert.equal(settings.enabled('alpha'), true);
});

test("another tab's change reaches listeners, and this tab's own write doesn't come back as one", async () => {
  const win = page();
  const chrome = fakeChrome();
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  await settle();
  const told = [];
  storage.onChange('settings', (value) => told.push(value));
  storage.set('settings', { alpha: false });
  await settle();
  assert.deepEqual(told, [], 'the echo of our own write is skipped');
  await chrome.storage.local.set({ settings: { alpha: true } });
  await settle();
  assert.deepEqual(told, [{ alpha: true }]);
  assert.deepEqual(storage.get('settings'), { alpha: true });
  await chrome.storage.local.remove('settings');
  await settle();
  assert.deepEqual(told, [{ alpha: true }, undefined]);
  assert.equal(storage.get('settings', 'none'), 'none');
});

test('accepted revisions reject stale pushes and let a later direct deletion win', async () => {
  const mutations = [];
  const errors = [];
  let push;
  const bridge = {
    request(type) {
      if (type === 'storage:load') {
        return Promise.resolve({
          settings: { original: true },
          [STORAGE_REVISIONS_KEY]: revisions('settings-generation', 0, { settings: 0 }),
        });
      }
      assert.equal(type, 'storage:mutate');
      const waiting = deferred();
      mutations.push(waiting);
      return waiting.promise;
    },
    on(type, listener) {
      assert.equal(type, 'storage');
      push = listener;
    },
  };
  const storage = createBridgeStorage(bridge, { log: { error: (...args) => errors.push(args) } });
  await new Promise((resolve) => storage.whenReady(resolve));

  const first = storage.mutate('settings', { set: { alpha: true } });
  push({ settings: { original: true, beta: true } }, {
    epoch: 'settings-generation',
    state: revisions('settings-generation', 1, { settings: 1 }),
    revisions: { settings: 1 },
  });
  mutations[0].resolve({
    value: { original: true, alpha: true, beta: true },
    revision: 2,
    epoch: 'settings-generation',
    revisions: revisions('settings-generation', 2, { settings: 2 }),
  });
  assert.deepEqual(await first, { original: true, alpha: true, beta: true });
  assert.deepEqual(storage.get('settings'), { original: true, alpha: true, beta: true });

  push({ settings: null }, {
    epoch: 'settings-generation',
    state: revisions('settings-generation', 2, { settings: 2 }),
    barriers: { settings: 2 },
  });
  assert.equal(storage.get('settings', 'missing'), 'missing');

  push({ settings: { stale: true } }, {
    epoch: 'settings-generation',
    state: revisions('settings-generation', 2, { settings: 2 }),
    revisions: { settings: 2 },
  });
  assert.equal(storage.get('settings', 'missing'), 'missing', 'an older push cannot resurrect a deleted record');

  for (const message of ['QUOTA_BYTES quota exceeded', 'the extension did not answer']) {
    const failed = storage.mutate('settings', { remove: ['alpha'] });
    mutations.at(-1).reject(new Error(message));
    await assert.rejects(failed, new RegExp(message.split(' ')[0], 'i'));
    assert.equal(storage.get('settings', 'missing'), 'missing');
  }
  assert.equal(errors.length, 2);
});

test('removing revision metadata starts a new accepted-write epoch', async () => {
  const mutations = [];
  let push;
  const bridge = {
    request(type) {
      if (type === 'storage:load') {
        return Promise.resolve({
          settings: { old: true },
          [STORAGE_REVISIONS_KEY]: revisions('old-epoch', 5, { settings: 5 }),
        });
      }
      const waiting = deferred();
      mutations.push(waiting);
      return waiting.promise;
    },
    on(type, listener) {
      assert.equal(type, 'storage');
      push = listener;
    },
  };
  const storage = createBridgeStorage(bridge);
  await new Promise((resolve) => storage.whenReady(resolve));

  const oldEpoch = storage.mutate('settings', { set: { stale: true } });
  push({ settings: null }, {
    resetRevisions: true,
    epoch: 'reset-epoch',
    state: revisions('reset-epoch', 0),
  });
  mutations[0].resolve({
    value: { stale: true },
    revision: 6,
    epoch: 'old-epoch',
    revisions: revisions('old-epoch', 6, { settings: 6 }),
  });
  assert.equal(await oldEpoch, undefined, 'a response from before the reset cannot enter the new epoch');

  const newEpoch = storage.mutate('settings', { set: { current: true } });
  push({ settings: { current: true } }, {
    epoch: 'reset-epoch',
    state: revisions('reset-epoch', 1, { settings: 1 }),
    revisions: { settings: 1 },
  });
  mutations[1].resolve({
    value: { current: true },
    revision: 1,
    epoch: 'reset-epoch',
    revisions: revisions('reset-epoch', 1, { settings: 1 }),
  });
  assert.deepEqual(await newEpoch, { current: true });
  assert.deepEqual(storage.get('settings'), { current: true });
});

test('a mutation started before reset can commit in the new worker epoch', async () => {
  const mutation = deferred();
  let push;
  const bridge = {
    request(type) {
      if (type === 'storage:load') {
        return Promise.resolve({
          settings: { old: true },
          [STORAGE_REVISIONS_KEY]: revisions('old-epoch', 5, { settings: 5 }),
        });
      }
      return mutation.promise;
    },
    on(type, listener) {
      assert.equal(type, 'storage');
      push = listener;
    },
  };
  const storage = createBridgeStorage(bridge);
  await new Promise((resolve) => storage.whenReady(resolve));

  const saving = storage.mutate('settings', { set: { current: true } });
  push({}, { resetRevisions: true, epoch: 'reset-epoch', state: revisions('reset-epoch', 0) });
  push({ settings: { old: true, current: true } }, {
    epoch: 'reset-epoch',
    state: revisions('reset-epoch', 1, { settings: 1 }),
    revisions: { settings: 1 },
  });
  mutation.resolve({
    value: { old: true, current: true },
    revision: 1,
    epoch: 'reset-epoch',
    revisions: revisions('reset-epoch', 1, { settings: 1 }),
  });

  assert.deepEqual(await saving, { old: true, current: true });
  assert.deepEqual(storage.get('settings'), { old: true, current: true });
  push({ settings: { stale: true } }, {
    revisions: { settings: 99 },
    resetRevisions: true,
    epoch: 'old-epoch',
    state: revisions('old-epoch', 99, { settings: 99 }),
  });
  assert.deepEqual(storage.get('settings'), { old: true, current: true }, 'the retired pre-reset epoch stays retired');
});

test('a later receipt commit does not hide a delayed settings value from the same generation', async () => {
  let push;
  const bridge = {
    request(type) {
      assert.equal(type, 'storage:load');
      return Promise.resolve({
        settings: { first: true },
        'settings.migrated': [],
        [STORAGE_REVISIONS_KEY]: revisions('stable-generation', 4, { settings: 4, 'settings.migrated': 0 }),
      });
    },
    on(type, listener) {
      assert.equal(type, 'storage');
      push = listener;
    },
  };
  const storage = createBridgeStorage(bridge);
  await new Promise((resolve) => storage.whenReady(resolve));

  push({ 'settings.migrated': ['one'] }, {
    revisions: { 'settings.migrated': 6 },
    state: revisions('stable-generation', 6, { settings: 5, 'settings.migrated': 6 }),
    epoch: 'stable-generation',
  });
  push({ settings: { fresh: true } }, {
    revisions: { settings: 5 },
    state: revisions('stable-generation', 5, { settings: 5, 'settings.migrated': 0 }),
    epoch: 'stable-generation',
  });

  assert.deepEqual(storage.get('settings'), { fresh: true });
  assert.deepEqual(storage.get('settings.migrated'), ['one']);
});

test('a retired generation rejects a delayed push even when its counter is higher', async () => {
  let push;
  const bridge = {
    request(type) {
      assert.equal(type, 'storage:load');
      return Promise.resolve({
        settings: { current: true },
        [STORAGE_REVISIONS_KEY]: revisions('old-epoch', 7, { settings: 7 }),
      });
    },
    on(type, listener) {
      assert.equal(type, 'storage');
      push = listener;
    },
  };
  const storage = createBridgeStorage(bridge);
  await new Promise((resolve) => storage.whenReady(resolve));

  push({ settings: { reset: true } }, {
    revisions: { settings: 1 },
    resetRevisions: true,
    epoch: 'current-epoch',
    state: revisions('current-epoch', 1, { settings: 1 }),
  });
  push({ settings: { stale: true } }, {
    revisions: { settings: 99 },
    resetRevisions: true,
    epoch: 'old-epoch',
    state: revisions('old-epoch', 99, { settings: 99 }),
  });

  assert.deepEqual(storage.get('settings'), { reset: true });
});

test('a delayed startup snapshot cannot restore revision metadata from before a reset', async () => {
  const load = deferred();
  const mutations = [];
  let push;
  const bridge = {
    request(type) {
      if (type === 'storage:load') return load.promise;
      const waiting = deferred();
      mutations.push(waiting);
      return waiting.promise;
    },
    on(type, listener) {
      assert.equal(type, 'storage');
      push = listener;
    },
  };
  const storage = createBridgeStorage(bridge);
  push({}, { resetRevisions: true, epoch: 'reset-epoch', state: revisions('reset-epoch', 0) });
  load.resolve({ settings: { old: true }, [STORAGE_REVISIONS_KEY]: revisions('old-epoch', 5, { settings: 5 }) });
  await new Promise((resolve) => storage.whenReady(resolve));

  const saving = storage.mutate('settings', { set: { current: true } });
  push({ settings: { old: true, current: true } }, {
    epoch: 'reset-epoch',
    state: revisions('reset-epoch', 1, { settings: 1 }),
    revisions: { settings: 1 },
  });
  mutations[0].resolve({
    value: { old: true, current: true },
    revision: 1,
    epoch: 'reset-epoch',
    revisions: revisions('reset-epoch', 1, { settings: 1 }),
  });
  assert.deepEqual(await saving, { old: true, current: true });
  assert.deepEqual(storage.get('settings'), { old: true, current: true });
});

test('a current-epoch push outranks a delayed snapshot from before the revision reset', async () => {
  const load = deferred();
  let push;
  const bridge = {
    request(type) {
      assert.equal(type, 'storage:load');
      return load.promise;
    },
    on(type, listener) {
      assert.equal(type, 'storage');
      push = listener;
    },
  };
  const storage = createBridgeStorage(bridge);
  push({}, { resetRevisions: true, epoch: 'new-epoch', state: revisions('new-epoch', 0) });
  push({ settings: { fresh: true } }, {
    epoch: 'new-epoch',
    state: revisions('new-epoch', 1, { settings: 1 }),
    revisions: { settings: 1 },
  });
  load.resolve({ settings: { stale: true }, [STORAGE_REVISIONS_KEY]: revisions('old-epoch', 5, { settings: 5 }) });
  await new Promise((resolve) => storage.whenReady(resolve));

  assert.deepEqual(storage.get('settings'), { fresh: true });
  assert.deepEqual(storage.getAtLoad('settings'), { fresh: true });
});

test('a delayed startup snapshot rejects an older versioned push', async () => {
  const load = deferred();
  let push;
  const bridge = {
    request(type) {
      assert.equal(type, 'storage:load');
      return load.promise;
    },
    on(type, listener) {
      assert.equal(type, 'storage');
      push = listener;
    },
  };
  const storage = createBridgeStorage(bridge);
  push({ settings: { stale: true } }, {
    epoch: 'same-epoch',
    state: revisions('same-epoch', 4, { settings: 4 }),
    revisions: { settings: 4 },
  });
  load.resolve({ settings: { newer: true }, [STORAGE_REVISIONS_KEY]: revisions('same-epoch', 5, { settings: 5 }) });
  await new Promise((resolve) => storage.whenReady(resolve));

  assert.deepEqual(storage.get('settings'), { newer: true });
  assert.deepEqual(storage.getAtLoad('settings'), { newer: true });
});

test('a delayed load cannot regress the isolated revision barrier', async () => {
  const load = deferred();
  const readStarted = deferred();
  let captured;
  const win = page();
  const chrome = fakeChrome({
    settings: { old: true },
    [STORAGE_REVISIONS_KEY]: revisions('stable-generation', 5, { settings: 5 }),
  }, {
    read: (data) => {
      captured = structuredClone(data);
      readStarted.resolve();
      return load.promise;
    },
  });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  await readStarted.promise;

  await chrome.storage.local.set({
    settings: { old: true, current: true },
    [STORAGE_REVISIONS_KEY]: revisions('stable-generation', 6, { settings: 6 }),
  });
  await settle();
  load.resolve(captured);
  await new Promise((resolve) => storage.whenReady(resolve));
  assert.deepEqual(storage.get('settings'), { old: true, current: true });

  await chrome.storage.local.set({ settings: { direct: true } });
  await settle();
  assert.deepEqual(storage.get('settings'), { direct: true });
});

test('a malformed revision change before load completes preserves its newer settings value', async () => {
  const load = deferred();
  const readStarted = deferred();
  let captured;
  const firstRecord = { __epoch: 'broken', __order: 1, settings: 'invalid' };
  const secondRecord = { __epoch: 'broken-again', __order: 2, settings: 'still-invalid' };
  const win = page();
  const chrome = fakeChrome({ settings: { old: true }, [STORAGE_REVISIONS_KEY]: firstRecord }, {
    read: (data) => {
      captured = structuredClone(data);
      readStarted.resolve();
      return load.promise;
    },
  });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  await readStarted.promise;

  await chrome.storage.local.set({
    settings: { current: true },
    [STORAGE_REVISIONS_KEY]: secondRecord,
  });
  await settle();
  load.resolve(captured);
  await new Promise((resolve) => storage.whenReady(resolve));

  assert.deepEqual(storage.get('settings'), { current: true });
  assert.deepEqual(storage.getAtLoad('settings'), { current: true });
});

test('a barrier-proven older direct push does not hide a newer worker response', async () => {
  const mutation = deferred();
  let push;
  const bridge = {
    request(type) {
      if (type === 'storage:load') {
        return Promise.resolve({
          settings: { old: true },
          [STORAGE_REVISIONS_KEY]: revisions('stable-generation', 5, { settings: 5 }),
        });
      }
      return mutation.promise;
    },
    on(type, listener) {
      assert.equal(type, 'storage');
      push = listener;
    },
  };
  const storage = createBridgeStorage(bridge);
  await new Promise((resolve) => storage.whenReady(resolve));

  const saving = storage.mutate('settings', { set: { current: true } });
  push({ settings: { old: true, direct: true } }, {
    epoch: 'stable-generation',
    state: revisions('stable-generation', 5, { settings: 5 }),
    barriers: { settings: 5 },
  });
  mutation.resolve({
    value: { old: true, direct: true, current: true },
    revision: 6,
    epoch: 'stable-generation',
    revisions: revisions('stable-generation', 6, { settings: 6 }),
  });
  assert.deepEqual(await saving, { old: true, direct: true, current: true });
  assert.deepEqual(storage.get('settings'), { old: true, direct: true, current: true });
});

test('a worker response that incorporates a barrierless direct write remains authoritative', async () => {
  const mutation = deferred();
  let push;
  const bridge = {
    request(type) {
      if (type === 'storage:load') return Promise.resolve({ settings: { old: true } });
      return mutation.promise;
    },
    on(type, listener) {
      assert.equal(type, 'storage');
      push = listener;
    },
  };
  const storage = createBridgeStorage(bridge);
  await new Promise((resolve) => storage.whenReady(resolve));

  const saving = storage.mutate('settings', { set: { current: true } });
  push({ settings: { old: true, direct: true } }, {});
  mutation.resolve({
    value: { old: true, direct: true, current: true },
    revision: 1,
    epoch: 'first-epoch',
    revisions: revisions('first-epoch', 1, { settings: 1 }),
  });

  assert.deepEqual(await saving, { old: true, direct: true, current: true });
  assert.deepEqual(storage.get('settings'), { old: true, direct: true, current: true });
});

test('an epoch-tagged replacement response outranks an earlier barrierless push', async () => {
  const mutation = deferred();
  let push;
  const bridge = {
    request(type) {
      if (type === 'storage:load') return Promise.resolve({ settings: { old: true } });
      return mutation.promise;
    },
    on(type, listener) {
      assert.equal(type, 'storage');
      push = listener;
    },
  };
  const storage = createBridgeStorage(bridge);
  await new Promise((resolve) => storage.whenReady(resolve));

  const saving = storage.mutate('settings', { replace: { current: true } });
  push({ settings: { direct: true } }, {});
  mutation.resolve({
    value: { current: true },
    revision: 1,
    epoch: 'first-epoch',
    revisions: revisions('first-epoch', 1, { settings: 1 }),
  });

  assert.deepEqual(await saving, { current: true });
  assert.deepEqual(storage.get('settings'), { current: true });
});

test('a delayed direct push cannot overwrite a newer accepted worker response', async () => {
  const mutation = deferred();
  let push;
  const bridge = {
    request(type) {
      if (type === 'storage:load') {
        return Promise.resolve({
          settings: { old: true },
          [STORAGE_REVISIONS_KEY]: revisions('stable-generation', 5, { settings: 5 }),
        });
      }
      return mutation.promise;
    },
    on(type, listener) {
      assert.equal(type, 'storage');
      push = listener;
    },
  };
  const storage = createBridgeStorage(bridge);
  await new Promise((resolve) => storage.whenReady(resolve));

  const saving = storage.mutate('settings', { set: { current: true } });
  mutation.resolve({
    value: { old: true, direct: true, current: true },
    revision: 6,
    epoch: 'stable-generation',
    revisions: revisions('stable-generation', 6, { settings: 6 }),
  });
  await saving;
  push({ settings: { old: true, direct: true } }, {
    epoch: 'stable-generation',
    state: revisions('stable-generation', 5, { settings: 5 }),
    barriers: { settings: 5 },
  });

  assert.deepEqual(storage.get('settings'), { old: true, direct: true, current: true });
});

test('the isolated bridge forwards a revision-record reset even when no setting changes with it', async () => {
  const win = page();
  const chrome = fakeChrome({ settings: { old: true }, [STORAGE_REVISIONS_KEY]: { settings: 5 } });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  await new Promise((resolve) => storage.whenReady(resolve));

  await chrome.storage.local.remove(STORAGE_REVISIONS_KEY);
  await settle();
  assert.deepEqual(await storage.mutate('settings', { set: { current: true } }), { old: true, current: true });
  assert.equal(chrome.data[STORAGE_REVISIONS_KEY].settings, 1);

  await chrome.storage.local.set({ [STORAGE_REVISIONS_KEY]: {} });
  await settle();
  assert.deepEqual(await storage.mutate('settings', { set: { restarted: true } }), { old: true, current: true, restarted: true });
  assert.equal(chrome.data[STORAGE_REVISIONS_KEY].settings, 1, 'a valid but lower revision map also starts a new epoch');
});

test('restoring a retired storage generation reactivates it through a verified reset', async () => {
  const win = page();
  const original = revisions('restored-generation', 1, { settings: 1 });
  const chrome = fakeChrome({ settings: { old: true }, [STORAGE_REVISIONS_KEY]: original });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  await new Promise((resolve) => storage.whenReady(resolve));

  await chrome.storage.local.remove(STORAGE_REVISIONS_KEY);
  await settle();
  await chrome.storage.local.set({
    settings: { restored: true },
    [STORAGE_REVISIONS_KEY]: original,
  });
  await settle();

  assert.deepEqual(storage.get('settings'), { restored: true });
  assert.deepEqual(await storage.mutate('settings', { set: { current: true } }), { restored: true, current: true });
  assert.equal(chrome.data[STORAGE_REVISIONS_KEY][STORAGE_REVISION_EPOCH_KEY], 'restored-generation');
  assert.equal(chrome.data[STORAGE_REVISIONS_KEY].settings, 2);
});

test('a restored generation waits for its new mutation event instead of its retired high-water mark', async () => {
  const win = page();
  const original = revisions('restored-generation', 5, { settings: 5 });
  const restored = revisions('restored-generation', 1, { settings: 1 });
  const committed = revisions('restored-generation', 2, { settings: 2 });
  const chrome = fakeChrome({ settings: { old: true }, [STORAGE_REVISIONS_KEY]: original });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  await new Promise((resolve) => storage.whenReady(resolve));

  await chrome.storage.local.remove(STORAGE_REVISIONS_KEY);
  await settle();
  await chrome.storage.local.set({ settings: { restored: true }, [STORAGE_REVISIONS_KEY]: restored });
  await settle();

  const send = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = async (message) => {
    if (message.type !== 'storage:mutate') return send(message);
    return {
      ok: true,
      result: {
        value: { restored: true, current: true },
        revision: 2,
        epoch: 'restored-generation',
        revisions: committed,
      },
    };
  };
  let settled = false;
  const saving = storage.mutate('settings', { set: { current: true } }).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(settled, false, 'the retired generation order cannot acknowledge the new write');

  chrome.data.settings = { restored: true, current: true };
  chrome.data[STORAGE_REVISIONS_KEY] = committed;
  chrome.emitStorageChange({
    settings: { oldValue: { restored: true }, newValue: { restored: true, current: true } },
    [STORAGE_REVISIONS_KEY]: { oldValue: restored, newValue: committed },
  });
  assert.deepEqual(await saving, { restored: true, current: true });
});

test('a lower revision with the same epoch resets its floor before the next worker commit', async () => {
  const win = page();
  const chrome = fakeChrome({
    settings: { old: true },
    [STORAGE_REVISIONS_KEY]: revisions('same-epoch', 5, { settings: 5 }),
  });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  await new Promise((resolve) => storage.whenReady(resolve));

  await chrome.storage.local.set({
    [STORAGE_REVISIONS_KEY]: revisions('same-epoch', 2, { settings: 2 }),
  });
  await settle();
  await chrome.storage.local.set({ settings: { direct: true } });
  await settle();
  assert.deepEqual(storage.get('settings'), { direct: true }, 'direct writes remain visible in the reset generation');
  assert.deepEqual(await storage.mutate('settings', { set: { current: true } }), { direct: true, current: true });
  assert.equal(chrome.data[STORAGE_REVISIONS_KEY].settings, 1);
  assert.notEqual(chrome.data[STORAGE_REVISIONS_KEY][STORAGE_REVISION_EPOCH_KEY], 'same-epoch');
});

test('a delayed old generation cannot replace the generation loaded by a fresh tab', async () => {
  const win = page();
  const current = revisions('current-generation', 8, { settings: 8 });
  const chrome = fakeChrome({ settings: { current: true }, [STORAGE_REVISIONS_KEY]: current });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  await new Promise((resolve) => storage.whenReady(resolve));

  chrome.emitStorageChange({
    settings: { oldValue: { older: true }, newValue: { stale: true } },
    [STORAGE_REVISIONS_KEY]: {
      oldValue: revisions('original-generation', 2, { settings: 2 }),
      newValue: revisions('delayed-generation', 3, { settings: 3 }),
    },
  });
  await settle();

  assert.deepEqual(storage.get('settings'), { current: true });
  assert.deepEqual(await storage.mutate('settings', { set: { saved: true } }), { current: true, saved: true });
  assert.equal(chrome.data[STORAGE_REVISIONS_KEY][STORAGE_REVISION_EPOCH_KEY], 'current-generation');
});

test('reordered generation callbacks keep the generation that is current in storage', async () => {
  const win = page();
  const first = revisions('first-generation', 1, { settings: 1 });
  const second = revisions('second-generation', 1, { settings: 1 });
  const current = revisions('current-generation', 1, { settings: 1 });
  const chrome = fakeChrome({ settings: { first: true }, [STORAGE_REVISIONS_KEY]: first });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  await new Promise((resolve) => storage.whenReady(resolve));

  chrome.data.settings = { current: true };
  chrome.data[STORAGE_REVISIONS_KEY] = current;
  chrome.emitStorageChange({
    settings: { oldValue: { second: true }, newValue: { current: true } },
    [STORAGE_REVISIONS_KEY]: { oldValue: second, newValue: current },
  });
  chrome.emitStorageChange({
    settings: { oldValue: { first: true }, newValue: { second: true } },
    [STORAGE_REVISIONS_KEY]: { oldValue: first, newValue: second },
  });
  await settle();

  assert.deepEqual(storage.get('settings'), { current: true });
  assert.deepEqual(await storage.mutate('settings', { set: { saved: true } }), { current: true, saved: true });
  assert.equal(chrome.data[STORAGE_REVISIONS_KEY][STORAGE_REVISION_EPOCH_KEY], 'current-generation');
});

test('a delayed atomic callback cannot overwrite a newer direct value', async () => {
  const win = page();
  const first = revisions('first-generation', 1, { settings: 1 });
  const current = revisions('current-generation', 1, { settings: 1 });
  const chrome = fakeChrome({ settings: { first: true }, [STORAGE_REVISIONS_KEY]: first });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  await new Promise((resolve) => storage.whenReady(resolve));

  chrome.data.settings = { current: true };
  chrome.data[STORAGE_REVISIONS_KEY] = current;
  chrome.emitStorageChange({ settings: { oldValue: { stale: true }, newValue: { current: true } } });
  chrome.emitStorageChange({
    settings: { oldValue: { first: true }, newValue: { stale: true } },
    [STORAGE_REVISIONS_KEY]: { oldValue: first, newValue: current },
  });
  await settle();

  assert.deepEqual(storage.get('settings'), { current: true });
});

test('a newer direct value wins when its callback precedes an older same-generation commit', async () => {
  const win = page();
  const before = revisions('stable-generation', 5, { settings: 5 });
  const committed = revisions('stable-generation', 6, { settings: 6 });
  const chrome = fakeChrome({ settings: { before: true }, [STORAGE_REVISIONS_KEY]: before });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  await new Promise((resolve) => storage.whenReady(resolve));

  chrome.data.settings = { direct: true };
  chrome.data[STORAGE_REVISIONS_KEY] = committed;
  chrome.emitStorageChange({ settings: { oldValue: { worker: true }, newValue: { direct: true } } });
  chrome.emitStorageChange({
    settings: { oldValue: { before: true }, newValue: { worker: true } },
    [STORAGE_REVISIONS_KEY]: { oldValue: before, newValue: committed },
  });
  await settle();

  assert.deepEqual(storage.get('settings'), { direct: true });
});

test('a transient storage read failure retries the same callback without waiting for another event', async () => {
  const win = page();
  const record = revisions('stable-generation', 5, { settings: 5 });
  const chrome = fakeChrome({ settings: { current: true }, [STORAGE_REVISIONS_KEY]: record });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  await new Promise((resolve) => storage.whenReady(resolve));

  const read = chrome.storage.local.get;
  let attempts = 0;
  chrome.storage.local.get = async (...args) => {
    attempts++;
    if (attempts === 1) throw new Error('storage briefly unavailable');
    return read(...args);
  };
  chrome.data.settings = { fresh: true };
  chrome.emitStorageChange({ settings: { oldValue: { current: true }, newValue: { fresh: true } } });
  await new Promise((resolve) => setTimeout(resolve, 75));

  assert.equal(attempts, 2);
  assert.deepEqual(storage.get('settings'), { fresh: true });
  assert.equal(storage.status().state, 'ready');
});

test('an unverifiable storage callback reports an error without replacing confirmed data', async () => {
  const win = page();
  const record = revisions('stable-generation', 5, { settings: 5 });
  const chrome = fakeChrome({ settings: { current: true }, [STORAGE_REVISIONS_KEY]: record });
  await startIsolated(win, chrome);
  const errors = [];
  const states = [];
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }), {
    log: { error: (...args) => errors.push(args) },
  });
  await new Promise((resolve) => storage.whenReady(resolve));
  storage.onStatus(({ state }) => states.push(state));

  const read = chrome.storage.local.get;
  chrome.storage.local.get = async () => { throw new Error('storage unavailable'); };
  chrome.emitStorageChange({ settings: { oldValue: { older: true }, newValue: { stale: true } } });
  await new Promise((resolve) => setTimeout(resolve, 225));

  assert.deepEqual(storage.get('settings'), { current: true });
  assert.equal(storage.status().state, 'error');
  assert.match(storage.status().error.message, /storage unavailable/);
  assert.equal(errors.length, 1);
  assert.deepEqual(states, ['ready', 'error']);

  chrome.storage.local.get = read;
  assert.equal(await storage.retry(), true);

  assert.deepEqual(storage.get('settings'), { current: true });
  assert.equal(storage.status().state, 'ready');
});

test('retry adopts the current storage generation after its transition callback could not be read', async () => {
  const win = page();
  const before = revisions('before-generation', 3, { settings: 3 });
  const current = revisions('current-generation', 1, { settings: 1 });
  const chrome = fakeChrome({ settings: { before: true }, [STORAGE_REVISIONS_KEY]: before });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }), {
    log: { error() {} },
  });
  await new Promise((resolve) => storage.whenReady(resolve));

  const read = chrome.storage.local.get;
  chrome.storage.local.get = async () => { throw new Error('storage unavailable'); };
  chrome.data.settings = { fresh: true };
  chrome.data[STORAGE_REVISIONS_KEY] = current;
  chrome.emitStorageChange({
    settings: { oldValue: { before: true }, newValue: { fresh: true } },
    [STORAGE_REVISIONS_KEY]: { oldValue: before, newValue: current },
  });
  await new Promise((resolve) => setTimeout(resolve, 225));
  assert.equal(storage.status().state, 'error');
  assert.deepEqual(storage.get('settings'), { before: true });

  chrome.storage.local.get = read;
  assert.equal(await storage.retry(), true);
  assert.deepEqual(storage.get('settings'), { fresh: true });
  assert.deepEqual(await storage.mutate('settings', { set: { saved: true } }), { fresh: true, saved: true });
  assert.deepEqual(storage.get('settings'), { fresh: true, saved: true });
  assert.equal(storage.status().state, 'ready');
});

test('retry classifies a missed same-token rollback as a new generation', async () => {
  const win = page();
  const before = revisions('same-generation', 5, { settings: 5 });
  const rolledBack = revisions('same-generation', 2, { settings: 2 });
  const chrome = fakeChrome({ settings: { before: true }, [STORAGE_REVISIONS_KEY]: before });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }), {
    log: { error() {} },
  });
  await new Promise((resolve) => storage.whenReady(resolve));

  const read = chrome.storage.local.get;
  chrome.storage.local.get = async () => { throw new Error('storage unavailable'); };
  chrome.data.settings = { rolledBack: true };
  chrome.data[STORAGE_REVISIONS_KEY] = rolledBack;
  chrome.emitStorageChange({
    settings: { oldValue: { before: true }, newValue: { rolledBack: true } },
    [STORAGE_REVISIONS_KEY]: { oldValue: before, newValue: rolledBack },
  });
  await new Promise((resolve) => setTimeout(resolve, 225));
  assert.equal(storage.status().state, 'error');

  chrome.storage.local.get = read;
  assert.equal(await storage.retry(), true);
  assert.deepEqual(storage.get('settings'), { rolledBack: true });
  assert.deepEqual(await storage.mutate('settings', { set: { saved: true } }), { rolledBack: true, saved: true });
  const request = chrome.sent.findLast((message) => message.type === 'storage:mutate');
  assert.notEqual(request.generation, 'same-generation');
  assert.equal(request.baseRevisions[STORAGE_REVISION_ORDER_KEY], 2);
  assert.notEqual(chrome.data[STORAGE_REVISIONS_KEY][STORAGE_REVISION_EPOCH_KEY], 'same-generation');
});

test('a same-generation push during retry outranks its delayed snapshot', async () => {
  const win = page();
  const before = revisions('stable-generation', 5, { settings: 5 });
  const current = revisions('stable-generation', 6, { settings: 6 });
  const chrome = fakeChrome({ settings: { before: true }, [STORAGE_REVISIONS_KEY]: before });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }), {
    log: { error() {} },
  });
  await new Promise((resolve) => storage.whenReady(resolve));

  const read = chrome.storage.local.get;
  chrome.storage.local.get = async () => { throw new Error('storage unavailable'); };
  chrome.emitStorageChange({ settings: { oldValue: { older: true }, newValue: { missed: true } } });
  await new Promise((resolve) => setTimeout(resolve, 225));
  assert.equal(storage.status().state, 'error');

  const delayed = deferred();
  let reads = 0;
  chrome.storage.local.get = async (...args) => {
    reads++;
    if (reads === 1) return delayed.promise;
    return read(...args);
  };
  const retrying = storage.retry();
  await settle();
  chrome.data.settings = { newer: true };
  chrome.data[STORAGE_REVISIONS_KEY] = current;
  chrome.emitStorageChange({
    settings: { oldValue: { before: true }, newValue: { newer: true } },
    [STORAGE_REVISIONS_KEY]: { oldValue: before, newValue: current },
  });
  await settle();
  assert.deepEqual(storage.get('settings'), { newer: true });

  delayed.resolve({ settings: { stale: true }, [STORAGE_REVISIONS_KEY]: before });
  assert.equal(await retrying, true);
  assert.deepEqual(storage.get('settings'), { newer: true });
  assert.deepEqual(await storage.mutate('settings', { set: { saved: true } }), { newer: true, saved: true });
  assert.deepEqual(storage.get('settings'), { newer: true, saved: true });
});

test('a reconciliation failure during retry keeps its error and rejects the older snapshot', async () => {
  const win = page();
  const record = revisions('stable-generation', 5, { settings: 5 });
  const chrome = fakeChrome({ settings: { before: true }, [STORAGE_REVISIONS_KEY]: record });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }), {
    log: { error() {} },
  });
  await new Promise((resolve) => storage.whenReady(resolve));

  const read = chrome.storage.local.get;
  chrome.storage.local.get = async () => { throw new Error('first callback unavailable'); };
  chrome.emitStorageChange({ settings: { oldValue: { before: true }, newValue: { missed: true } } });
  await new Promise((resolve) => setTimeout(resolve, 225));
  assert.equal(storage.status().state, 'error');

  const delayed = deferred();
  let reads = 0;
  chrome.storage.local.get = async () => {
    reads++;
    if (reads === 1) return delayed.promise;
    throw new Error('second callback unavailable');
  };
  const retrying = storage.retry();
  await settle();
  chrome.data.settings = { newer: true };
  chrome.emitStorageChange({ settings: { oldValue: { missed: true }, newValue: { newer: true } } });
  await new Promise((resolve) => setTimeout(resolve, 225));
  assert.equal(storage.status().state, 'error');

  delayed.resolve({ settings: { stale: true }, [STORAGE_REVISIONS_KEY]: record });
  assert.equal(await retrying, false);
  assert.deepEqual(storage.get('settings'), { before: true });
  assert.equal(storage.status().state, 'error');

  chrome.storage.local.get = read;
  assert.equal(await storage.retry(), true);
  assert.deepEqual(storage.get('settings'), { newer: true });
  assert.equal(storage.status().state, 'ready');
});

test('a verified full snapshot recovers a dropped direct value at the same key revision', async () => {
  const win = page();
  const initial = revisions('stable-generation', 1, { settings: 1, 'settings.migrated': 0 });
  const chrome = fakeChrome({
    settings: { old: true },
    'settings.migrated': [],
    [STORAGE_REVISIONS_KEY]: initial,
  });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  await new Promise((resolve) => storage.whenReady(resolve));

  const read = chrome.storage.local.get;
  chrome.storage.local.get = async () => { throw new Error('storage unavailable'); };
  await chrome.storage.local.set({ settings: { fresh: true } });
  await new Promise((resolve) => setTimeout(resolve, 225));
  chrome.storage.local.get = read;
  assert.deepEqual(storage.get('settings'), { old: true }, 'the unverified direct callback stays hidden');

  await chrome.storage.local.set({
    'settings.migrated': ['one'],
    [STORAGE_REVISIONS_KEY]: revisions('stable-generation', 2, { settings: 1, 'settings.migrated': 2 }),
  });
  await settle();

  assert.deepEqual(storage.get('settings'), { fresh: true });
  assert.deepEqual(storage.get('settings.migrated'), ['one']);
});

test('a validated skipped generation reconciles values changed by the missing callback', async () => {
  const win = page();
  const first = revisions('first-generation', 1, { settings: 1, 'settings.migrated': 0 });
  const skipped = revisions('skipped-generation', 1, { settings: 1, 'settings.migrated': 0 });
  const current = revisions('current-generation', 1, { settings: 1, 'settings.migrated': 1 });
  const chrome = fakeChrome({
    settings: { old: true },
    'settings.migrated': [],
    [STORAGE_REVISIONS_KEY]: first,
  });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  await new Promise((resolve) => storage.whenReady(resolve));

  chrome.data.settings = { fresh: true };
  chrome.data['settings.migrated'] = ['one'];
  chrome.data[STORAGE_REVISIONS_KEY] = current;
  chrome.emitStorageChange({
    'settings.migrated': { oldValue: [], newValue: ['one'] },
    [STORAGE_REVISIONS_KEY]: { oldValue: skipped, newValue: current },
  });
  await settle();

  assert.deepEqual(storage.get('settings'), { fresh: true });
  assert.deepEqual(storage.get('settings.migrated'), ['one']);
});

test('a malformed startup revision record is discarded as one unit', async () => {
  const win = page();
  const chrome = fakeChrome({
    settings: { old: true },
    [STORAGE_REVISIONS_KEY]: {
      [STORAGE_REVISION_EPOCH_KEY]: 'malformed-epoch',
      [STORAGE_REVISION_ORDER_KEY]: 5,
      settings: 5,
      broken: 'not a revision',
    },
  });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  await new Promise((resolve) => storage.whenReady(resolve));

  await chrome.storage.local.set({ [STORAGE_REVISIONS_KEY]: { settings: 2 } });
  await settle();
  assert.deepEqual(await storage.mutate('settings', { set: { current: true } }), { old: true, current: true });
  assert.equal(chrome.data[STORAGE_REVISIONS_KEY].settings, 1);
});

test('the toolbar button reaches the page as open-settings', async () => {
  const win = page();
  const chrome = fakeChrome();
  await startIsolated(win, chrome);
  const bridge = connectBridge({ doc: win.document, win, secret: randomUUID() });
  let opened = 0;
  bridge.on('open-settings', () => opened++);
  chrome.openSettings();
  assert.equal(opened, 1);
});

test("downloads go to the background in GM_download's shape, and a cancel says so", async () => {
  const win = page();
  const answers = [{ ok: true }, { ok: false, error: 'USER_CANCELED' }];
  const chrome = fakeChrome({}, { download: () => answers.shift() });
  await startIsolated(win, chrome);
  const download = bridgeDownload(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  const outcome = (url) => new Promise((resolve) => {
    download({ url, name: 'Pat video.mp4', onload: () => resolve('saved'), onerror: (error) => resolve(error.error), ontimeout: () => resolve('timeout') });
  });
  assert.equal(await outcome('https://video.xx.fbcdn.net/v/one.mp4'), 'saved');
  assert.equal(await outcome('https://video.xx.fbcdn.net/v/two.mp4'), 'USER_CANCELED');
  assert.deepEqual(chrome.sent.map(({ type, url, name }) => [type, url, name]), [
    ['download', 'https://video.xx.fbcdn.net/v/one.mp4', 'Pat video.mp4'],
    ['download', 'https://video.xx.fbcdn.net/v/two.mp4', 'Pat video.mp4'],
  ]);
});

test('settings wait for the saved copy, then migrate through the worker once before recording it', async () => {
  const win = page();
  const chrome = fakeChrome({ settings: { alpha: false }, 'settings.migrated': [] });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  const ran = [];
  const migrations = [{ id: 'one', run: (raw) => { ran.push(structuredClone(raw)); raw.beta = true; } }];
  const settings = createSettings({
    storage,
    features: [
      { id: 'alpha', title: 'Alpha', default: true },
      { id: 'beta', title: 'Beta', default: false },
    ],
    migrations,
  });
  const seen = [];
  settings.subscribe(({ remote }) => seen.push(['change', remote, settings.get('alpha')]));
  settings.whenLoaded(() => seen.push(['loaded', settings.get('alpha')]));
  assert.equal(settings.get('alpha'), true, 'the default until it loads');
  assert.deepEqual(ran, [], "migrations wait so they see what's saved");
  await settle();
  assert.deepEqual(ran, [{ alpha: false }]);
  assert.deepEqual(seen, [['change', true, false], ['loaded', false], ['change', true, false]]);
  assert.deepEqual(chrome.data.settings, { alpha: false, beta: true });
  assert.equal(chrome.data[STORAGE_REVISIONS_KEY].settings, 1);
  assert.ok(chrome.sent.some((message) => message.type === 'storage:migrate' && message.key === 'settings'));
  assert.deepEqual(chrome.data['settings.migrated'], ['one']);
});

test('a rejected atomic migration leaves both records retryable', async () => {
  const win = page();
  let unavailable = true;
  const chrome = fakeChrome({ settings: {}, 'settings.migrated': [] }, {
    migrate: ({ record, receipt, message, mutation }) => {
      if (unavailable) throw new Error('storage unavailable');
      return {
        value: applyObjectMutation(record, mutation),
        receipt: [...new Set([...receipt, ...message.receipt])],
      };
    },
  });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  const settings = createSettings({
    storage,
    features: [{ id: 'alpha', title: 'Alpha', default: true }],
    migrations: [{ id: 'one', run: (raw) => { raw.alpha = false; } }],
  });

  await settle();
  assert.deepEqual(chrome.data.settings, {}, 'a failed transaction does not expose migrated settings');
  assert.deepEqual(chrome.data['settings.migrated'], [], 'a failed transaction does not expose its receipt');
  assert.equal(settings.saveStatus().state, 'error');
  assert.deepEqual(settings.saveStatus().pending, ['alpha']);
  assert.deepEqual(
    chrome.sent.filter((message) => message.type === 'storage:migrate').map((message) => message.key),
    ['settings'],
  );

  unavailable = false;
  await settings.retry();
  await settle();
  assert.deepEqual(chrome.data.settings, { alpha: false });
  assert.deepEqual(chrome.data['settings.migrated'], ['one']);
  assert.deepEqual(settings.saveStatus(), { state: 'idle', error: null, pending: [] });
});

test('an atomic migration exposes settings and its receipt together', async () => {
  const win = page();
  const commit = deferred();
  const chrome = fakeChrome({ settings: {}, 'settings.migrated': [] }, {
    migrate: async ({ record, receipt, message, mutation }) => {
      await commit.promise;
      return {
        value: applyObjectMutation(record, mutation),
        receipt: [...new Set([...receipt, ...message.receipt])],
      };
    },
  });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  const settings = createSettings({
    storage,
    features: [
      { id: 'alpha', title: 'Alpha', default: true },
      { id: 'beta', title: 'Beta', default: false },
    ],
    migrations: [{ id: 'one', run: (raw) => { raw.alpha = false; } }],
  });

  await settle();
  assert.equal(settings.saveStatus().state, 'saving');
  assert.deepEqual(chrome.data.settings, {});
  assert.deepEqual(chrome.data['settings.migrated'], []);

  commit.resolve();
  await settle();
  assert.deepEqual(settings.snapshot(), { alpha: false });
  assert.deepEqual(chrome.data.settings, { alpha: false });
  assert.deepEqual(chrome.data['settings.migrated'], ['one']);
  assert.deepEqual(settings.saveStatus(), { state: 'idle', error: null, pending: [] });
});

test('a rejected extension migration keeps committed behavior and a retryable draft', async () => {
  const win = page();
  let unavailable = true;
  const chrome = fakeChrome({ settings: {}, 'settings.migrated': [] }, {
    mutate: (record, mutation) => {
      if (unavailable) throw new Error('storage unavailable');
      return applyObjectMutation(record, mutation);
    },
  });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  const settings = createSettings({
    storage,
    features: [{ id: 'alpha', title: 'Alpha', default: true }],
    migrations: [{ id: 'one', run: (raw) => { raw.alpha = false; } }],
  });

  await settle();
  assert.equal(settings.get('alpha'), true, 'the failed migration is not active behavior');
  assert.equal(settings.display('alpha'), false, 'the migrated choice remains visible for recovery');
  assert.equal(settings.saveStatus().state, 'error');
  assert.deepEqual(settings.saveStatus().pending, ['alpha']);
  assert.deepEqual(chrome.data['settings.migrated'], [], 'the receipt is not advanced before a successful mutation');

  unavailable = false;
  await settings.retry();
  await settle();
  assert.equal(settings.get('alpha'), false);
  assert.deepEqual(chrome.data.settings, { alpha: false });
  assert.deepEqual(chrome.data['settings.migrated'], ['one']);
  assert.deepEqual(settings.saveStatus(), { state: 'idle', error: null, pending: [] });
});

test('choosing the committed value cancels a rejected migration draft', async () => {
  const win = page();
  let unavailable = true;
  const chrome = fakeChrome({ settings: {}, 'settings.migrated': [] }, {
    mutate: (record, mutation) => {
      if (unavailable) throw new Error('storage unavailable');
      return applyObjectMutation(record, mutation);
    },
  });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  const settings = createSettings({
    storage,
    features: [{ id: 'alpha', title: 'Alpha', default: true }],
    migrations: [{ id: 'one', run: (raw) => { raw.alpha = false; } }],
  });

  await settle();
  const rejected = settings.set('alpha', true);
  assert.ok(rejected && typeof rejected.then === 'function', 'canceling waits for the pending migration receipt write');
  await assert.rejects(rejected, /storage unavailable/);
  assert.deepEqual(chrome.data['settings.migrated'], []);

  unavailable = false;
  await settings.set('alpha', true);
  await settle();

  assert.equal(settings.get('alpha'), true);
  assert.equal(settings.display('alpha'), true);
  assert.deepEqual(chrome.data.settings, {});
  assert.deepEqual(chrome.data['settings.migrated'], ['one']);
  assert.deepEqual(settings.saveStatus(), { state: 'idle', error: null, pending: [] });
});

test('settings retain a nondefault page-start value when the same value is written before load', async () => {
  const win = page();
  const chrome = fakeChrome({ settings: { alpha: true }, 'settings.migrated': [] });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  const settings = createSettings({ storage, features: [{ id: 'alpha', title: 'Alpha', default: false }], migrations: [] });
  settings.set('alpha', true);
  await settle();
  assert.equal(settings.get('alpha'), true);
  assert.equal(settings.pageLoadValue('alpha'), true);
});

test('a pre-load settings write preserves untouched saved choices', async () => {
  const win = page();
  const chrome = fakeChrome({ settings: { alpha: true, beta: true }, 'settings.migrated': [] });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  const features = [
    { id: 'alpha', title: 'Alpha', default: false },
    { id: 'beta', title: 'Beta', default: false },
  ];
  const settings = createSettings({ storage, features, migrations: [] });
  settings.set('alpha', false);
  await settle();
  assert.equal(settings.get('alpha'), false);
  assert.equal(settings.get('beta'), true);
  assert.deepEqual(chrome.data.settings, { beta: true });
});

test('pre-load reset preserves migration state for Undo and keeps a later setting change', async () => {
  const win = page();
  const load = deferred();
  const readStarted = deferred();
  const saved = { settings: { source: false }, 'settings.migrated': [] };
  const chrome = fakeChrome(saved, { read: () => {
    readStarted.resolve();
    return load.promise;
  } });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  const settings = createSettings({
    storage,
    features: [
      { id: 'source', title: 'Source', default: true },
      { id: 'target', title: 'Target', default: true },
      { id: 'beta', title: 'Beta', default: false },
    ],
    migrations: [{ id: 'one', run: (raw) => { raw.target = false; } }],
  });
  await readStarted.promise;

  const resetting = settings.reset();
  const later = settings.set('beta', true);
  assert.deepEqual(chrome.data.settings, { source: false }, 'reset does not replace an unread record');
  load.resolve(saved);
  const previous = await resetting;
  await later;
  await settle();
  assert.deepEqual(previous, { source: false, target: false });
  assert.deepEqual(chrome.data.settings, { beta: true }, 'the later setting wins over the earlier reset');
  assert.deepEqual(chrome.data['settings.migrated'], ['one']);

  await settings.restore(previous);
  await settle();
  assert.deepEqual(chrome.data.settings, { source: false, target: false });
});

test('pre-load Reset Undo excludes migration fields completed by another tab', async () => {
  const win = page();
  const load = deferred();
  const readStarted = deferred();
  const saved = { settings: { hideSponsoredPosts: false }, 'settings.migrated': [] };
  const chrome = fakeChrome(saved, { read: () => {
    readStarted.resolve();
    return load.promise;
  } });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  const settings = createSettings({
    storage,
    features: [
      { id: 'hideSponsoredPosts', title: 'Feed ads', default: true },
      { id: 'hideSponsoredSearch', title: 'Search ads', default: true },
      { id: 'hideSponsoredMarketplace', title: 'Marketplace ads', default: true },
    ],
  });
  await readStarted.promise;

  const resetting = settings.reset();
  chrome.data['settings.migrated'] = ['split-ad-switch'];
  load.resolve(saved);
  const previous = await resetting;
  await settle();

  assert.deepEqual(previous, { hideSponsoredPosts: false });
  assert.deepEqual(chrome.data.settings, {});
  assert.deepEqual(chrome.data['settings.migrated'], ['split-ad-switch']);
});

test('pre-load Reset Undo rederives a pending migration after its source changes', async () => {
  const win = page();
  const load = deferred();
  const readStarted = deferred();
  const saved = { settings: { hideSponsoredPosts: false }, 'settings.migrated': [] };
  const chrome = fakeChrome(saved, { read: () => {
    readStarted.resolve();
    return load.promise;
  } });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  const settings = createSettings({
    storage,
    features: [
      { id: 'hideSponsoredPosts', title: 'Feed ads', default: true },
      { id: 'hideSponsoredSearch', title: 'Search ads', default: true },
      { id: 'hideSponsoredMarketplace', title: 'Marketplace ads', default: true },
    ],
  });
  await readStarted.promise;

  const resetting = settings.reset();
  chrome.data.settings = {};
  load.resolve(saved);
  const previous = await resetting;
  await settle();

  assert.deepEqual(previous, {});
  assert.deepEqual(chrome.data.settings, {});
  assert.deepEqual(chrome.data['settings.migrated'], ['split-ad-switch']);
  assert.equal(chrome.sent.filter((message) => message.type === 'storage:migrate').length, 2);
});

test('migration guards use the physical record when it stores an explicit default', async () => {
  const win = page();
  const chrome = fakeChrome({ settings: { alpha: true }, 'settings.migrated': [] });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  const settings = createSettings({
    storage,
    features: [
      { id: 'alpha', title: 'Alpha', default: true },
      { id: 'beta', title: 'Beta', default: false },
    ],
    migrations: [{ id: 'one', run: (raw) => { raw.beta = true; } }],
  });
  await settle();

  assert.equal(settings.get('beta'), true);
  assert.deepEqual(chrome.data.settings, { beta: true });
  assert.deepEqual(chrome.data['settings.migrated'], ['one']);
  assert.deepEqual(settings.saveStatus(), { state: 'idle', error: null, pending: [] });
});

test('a new account inherits the shared migration record when it writes before storage loads', async () => {
  const win = page();
  const account = '615000000000017';
  const accountKey = storageKeyFor(account);
  const chrome = fakeChrome({
    settings: { hideSponsoredPosts: false },
    'settings.migrated': ['split-ad-switch'],
  });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  const features = [
    { id: 'hideSponsoredPosts', title: 'Feed ads', default: true },
    { id: 'hideSponsoredSearch', title: 'Search ads', default: true },
    { id: 'hideSponsoredMarketplace', title: 'Marketplace ads', default: true },
  ];
  const settings = createSettings({ storage, features, account });
  settings.set('hideSponsoredPosts', false);
  await settle();
  assert.equal(settings.get('hideSponsoredSearch'), true);
  assert.equal(settings.get('hideSponsoredMarketplace'), true);
  assert.equal(settings.pageLoadValue('hideSponsoredSearch'), true);
  assert.deepEqual(chrome.data[accountKey], { hideSponsoredPosts: false });
  assert.equal(chrome.data[STORAGE_REVISIONS_KEY][accountKey], 1, 'inheritance and the pre-load choice share one mutation');
  const copied = chrome.sent.find((message) => message.type === 'storage:migrate' && message.key === accountKey);
  assert.deepEqual(copied.mutation.initialize, { hideSponsoredPosts: false });
  assert.deepEqual(copied.mutation.set, { hideSponsoredPosts: false });
  assert.deepEqual(copied.mutation.remove, []);
  assert.equal(Object.hasOwn(copied.mutation.guard, 'hideSponsoredPosts'), false, 'the explicit draft is unconditional');
  assert.deepEqual(copied.receipt, ['split-ad-switch']);
  assert.deepEqual(chrome.data[`${accountKey}.migrated`], ['split-ad-switch']);
});

test('a first-seen account snapshots inherited defaults through the worker', async () => {
  const account = '615000000000018';
  const accountKey = storageKeyFor(account);
  const chrome = fakeChrome({ 'settings.migrated': ['done'] });
  const firstPage = page();
  await startIsolated(firstPage, chrome);
  const firstStorage = createBridgeStorage(connectBridge({ doc: firstPage.document, win: firstPage, secret: randomUUID() }));
  const feature = [{ id: 'beta', title: 'Beta', default: false }];
  const first = createSettings({
    storage: firstStorage,
    features: feature,
    account,
    migrations: [{ id: 'done', run() {} }],
  });
  await settle();

  assert.equal(first.get('beta'), false);
  assert.deepEqual(chrome.data[accountKey], {}, 'the empty inherited snapshot still creates an account record');
  assert.equal(chrome.data[STORAGE_REVISIONS_KEY][accountKey], 1);

  await chrome.storage.local.set({ settings: { beta: true } });
  const secondPage = page();
  await startIsolated(secondPage, chrome);
  const secondStorage = createBridgeStorage(connectBridge({ doc: secondPage.document, win: secondPage, secret: randomUUID() }));
  const again = createSettings({
    storage: secondStorage,
    features: feature,
    account,
    migrations: [{ id: 'done', run() {} }],
  });
  await settle();

  assert.equal(again.get('beta'), false, 'later shared changes do not leak into a known account');
});

test('a first-seen account rereads shared settings through the worker without migrations', async () => {
  const account = '615000000000024';
  const accountKey = storageKeyFor(account);
  const chrome = fakeChrome({ settings: { alpha: false } });
  const send = chrome.runtime.sendMessage;
  let sourceChanged = false;
  chrome.runtime.sendMessage = async (message) => {
    if (message.type === 'storage:migrate' && !sourceChanged) {
      sourceChanged = true;
      chrome.data.settings = {};
    }
    return send(message);
  };
  const win = page();
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  const settings = createSettings({
    storage,
    features: [{ id: 'alpha', title: 'Alpha', default: true }],
    account,
    migrations: [],
  });
  await settle();

  assert.equal(sourceChanged, true);
  assert.equal(settings.get('alpha'), true);
  assert.deepEqual(chrome.data[accountKey], {});
  const copy = chrome.sent.find((message) => message.type === 'storage:migrate' && message.key === accountKey);
  assert.deepEqual(copy.receipt, []);
  assert.equal(copy.sourceKey, 'settings');
});

test('the channel names carry the secret', () => {
  assert.deepEqual(channelNames('abc'), { toIsolated: 'hushfacebook-web:abc:in', toMain: 'hushfacebook-web:abc:out' });
});
