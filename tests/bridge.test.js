// The extension's two halves: the page script's bridge (src/core/bridge.js) and the isolated
// content script (extension/isolated.js), run against each other over a happy-dom document
// with a stand-in for chrome.storage and the background.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { HELLO_ISOLATED, HELLO_MAIN, bridgeDownload, channelNames, connectBridge, createBridgeStorage } from '../src/core/bridge.js';
import { createSettings, storageKeyFor } from '../src/core/settings.js';
import { createSeenStore, SEEN_KEY } from '../src/core/seen-store.js';

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
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// chrome.storage.local, chrome.runtime and the background's answers to downloads.
function fakeChrome(saved = {}, { download = () => ({ ok: true }), read } = {}) {
  const data = structuredClone(saved);
  const changed = [];
  const fromBackground = [];
  const sent = [];
  const tell = (changes) => queueMicrotask(() => changed.forEach((listener) => listener(changes, 'local')));
  return {
    data,
    sent,
    openSettings: () => fromBackground.forEach((listener) => listener({ type: 'open-settings' })),
    storage: {
      local: {
        get: async () => (read ? read(data) : structuredClone(data)),
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
  storage.onStatus(({ state }) => states.push(state));
  settings.whenLoaded(() => loaded.push(settings.get('alpha')));
  await settle();

  assert.equal(storage.status().state, 'error');
  assert.deepEqual(loaded, [], 'failed loading is not reported as loaded defaults');
  assert.equal(errors.length, 1);
  const retried = storage.retry();
  assert.equal(storage.status().state, 'loading');
  retry.resolve({ settings: { alpha: false } });
  await retried;
  assert.equal(storage.status().state, 'ready');
  assert.deepEqual(loaded, [false]);
  assert.deepEqual(states, ['loading', 'error', 'loading', 'ready']);
  assert.deepEqual(storage.get('settings'), { alpha: false });
});

test('writes after a failed load wait for retry and retain untouched saved settings', async () => {
  const retry = deferred();
  const requests = [];
  let loads = 0;
  const bridge = {
    request(type, payload) {
      requests.push([type, payload]);
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
    ['storage:set', { key: 'settings', value: { beta: true, alpha: true } }],
  ]);
});

test('a newer remote settings record overrides older pre-load local changes', async () => {
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
    settings.set('alpha', true);
    if (remote === undefined) await chrome.storage.local.remove('settings');
    else await chrome.storage.local.set({ settings: remote });
    load.resolve(stale);
    await new Promise((resolve) => settings.whenLoaded(resolve));
    await settle();

    assert.equal(settings.get('alpha'), false);
    assert.equal(settings.get('beta'), remote?.beta ?? false);
    if (remote === undefined) assert.equal(Object.hasOwn(chrome.data, 'settings'), false);
    else assert.deepEqual(chrome.data.settings, remote);
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
  assert.equal(settings.get('alpha'), true, 'the settings UI can still show the default');
  assert.equal(settings.enabled('alpha'), false, 'irreversible feature decisions wait for storage');
  load.resolve({ settings: {} });
  await new Promise((resolve) => settings.whenLoaded(resolve));
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

test('settings wait for the saved copy: defaults first, then the saved choices, migrated once, and whenLoaded after', async () => {
  const win = page();
  const chrome = fakeChrome({ settings: { alpha: false }, 'settings.migrated': [] });
  await startIsolated(win, chrome);
  const storage = createBridgeStorage(connectBridge({ doc: win.document, win, secret: randomUUID() }));
  const ran = [];
  const migrations = [{ id: 'one', run: (raw) => ran.push(structuredClone(raw)) }];
  const settings = createSettings({ storage, features: [{ id: 'alpha', title: 'Alpha', default: true }], migrations });
  const seen = [];
  settings.subscribe(({ remote }) => seen.push(['change', remote, settings.get('alpha')]));
  settings.whenLoaded(() => seen.push(['loaded', settings.get('alpha')]));
  assert.equal(settings.get('alpha'), true, 'the default until it loads');
  assert.deepEqual(ran, [], "migrations wait so they see what's saved");
  await settle();
  assert.deepEqual(ran, [{ alpha: false }]);
  assert.deepEqual(seen, [['change', true, false], ['loaded', false]]);
  assert.deepEqual(chrome.data['settings.migrated'], ['one']);
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
  assert.deepEqual(chrome.data[`${accountKey}.migrated`], ['split-ad-switch']);
});

test('the channel names carry the secret', () => {
  assert.deepEqual(channelNames('abc'), { toIsolated: 'hushfacebook-web:abc:in', toMain: 'hushfacebook-web:abc:out' });
});
