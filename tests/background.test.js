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

function worker({ version = '0.0.4', saved = {}, release = null, tabs = {} } = {}) {
  const data = structuredClone(saved);
  const calls = { fetch: 0, badge: [], created: [], reloaded: [], sent: [], downloads: [] };
  const listeners = { updated: [], downloadChanged: [] };
  const chrome = {
    runtime: { getManifest: () => ({ version }), onMessage: { addListener() {} } },
    storage: { local: {
      get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
      set: async (items) => void Object.assign(data, structuredClone(items)),
    } },
    action: {
      onClicked: { addListener() {} },
      setBadgeText: async ({ text }) => void calls.badge.push(text),
      setBadgeBackgroundColor: async () => {},
    },
    alarms: { onAlarm: { addListener() {} }, get: async () => ({ name: 'update-check' }), create() {} },
    tabs: {
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
  const context = vm.createContext({ chrome, fetch, URL, Date, setTimeout, clearTimeout, console });
  vm.runInContext(SOURCE, context);
  return { context, data, calls, listeners };
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
