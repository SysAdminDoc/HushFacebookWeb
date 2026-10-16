// The extension's two halves: the page script's bridge (src/core/bridge.js) and the isolated
// content script (extension/isolated.js), run against each other over a happy-dom document
// with a stand-in for chrome.storage and the background.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { HELLO_ISOLATED, HELLO_MAIN, bridgeDownload, channelNames, connectBridge, createBridgeStorage } from '../src/core/bridge.js';
import { createSettings, storageKeyFor } from '../src/core/settings.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// chrome.storage.local, chrome.runtime and the background's answers to downloads.
function fakeChrome(saved = {}, { download = () => ({ ok: true }) } = {}) {
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
        get: async () => structuredClone(data),
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
