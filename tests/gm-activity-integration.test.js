import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createActivityStorage, activityKeyFor } from '../src/core/activity.js';

const { outputFiles } = await build({ entryPoints: ['src/core/storage.js'], bundle: true, write: false, format: 'iife', globalName: 'StorageFixture' });
function managers() {
  const saved = new Map([['keepSpeed.rate', 1.5], ['keepVolume.state', { volume: 0.35, muted: false }]]);
  const clients = [];
  const pending = [];
  return {
    saved,
    propagate() {
      for (const [key, value, author] of pending.splice(0)) for (const client of clients) {
        if (client === author) continue;
        client.cache.set(key, structuredClone(value));
        for (const listener of client.listeners.get(key) ?? []) listener(key, undefined, value, true);
      }
    },
    client({ privateWindow = false } = {}) {
      const client = { cache: new Map([...saved].map(([key, value]) => [key, structuredClone(value)])), timers: [], listeners: new Map(), failures: 0, writes: 0, lists: 0, account: '615000000000041' };
      const get = (key, fallback) => client.cache.has(key) ? structuredClone(client.cache.get(key)) : fallback;
      const set = async (key, value) => {
        if (JSON.stringify(get(key)) === JSON.stringify(value)) return;
        client.cache.set(key, structuredClone(value));
        if (value?.kind === 'restore' && client.failures-- > 0) throw new Error('manager storage unavailable');
        client.writes++;
        saved.set(key, structuredClone(value));
        pending.push([key, structuredClone(value), client]);
      };
      const remove = async (key) => { client.cache.delete(key); saved.delete(key); };
      const context = vm.createContext({
        GM_info: { scriptHandler: 'Violentmonkey', isIncognito: privateWindow },
        GM_getValue: get, GM_setValue: set, GM_deleteValue: remove,
        GM_listValues: () => { client.lists++; return [...client.cache.keys()]; },
        GM_addValueChangeListener: (key, listener) => client.listeners.set(key, [...client.listeners.get(key) ?? [], listener]),
        GM: { setValue: set, deleteValue: remove }, crypto, structuredClone, TextEncoder, URL,
        setTimeout(run) { const timer = { run }; client.timers.push(timer); return timer; },
        clearTimeout(timer) { const index = client.timers.indexOf(timer); if (index >= 0) client.timers.splice(index, 1); },
      });
      vm.runInContext(outputFiles[0].text, context);
      client.storage = context.StorageFixture.createGmStorage();
      client.activity = createActivityStorage({ storage: client.storage, account: client.account, currentAccount: () => client.account });
      client.advance = async () => { await setImmediate(); for (const timer of client.timers.splice(0)) timer.run(); await setImmediate(); };
      clients.push(client);
      return client;
    },
  };
}

test('legacy Undo automatically retries a rejected manager-cache write and survives a fresh reader', async () => {
  const platform = managers();
  const client = platform.client();
  const undo = await client.activity.clearLegacy();
  assert.equal(platform.client().storage.get('keepSpeed.rate'), undefined);
  assert.equal(platform.saved.get('keepSpeed.rate'), 1.5, 'logical deletion does not blindly overwrite the legacy Undo seed');
  client.failures = 1;
  const restoring = undo();
  await setImmediate();
  assert.equal(client.storage.get('keepSpeed.rate'), undefined, 'a cache-only proposal cannot count as restored');
  assert.equal(platform.client().storage.get('keepSpeed.rate'), undefined);
  assert.equal(client.timers.length, 1, 'automatic repair is scheduled');
  await client.advance();
  await restoring;
  const fresh = platform.client();
  assert.equal(fresh.storage.get('keepSpeed.rate'), 1.5);
  assert.deepEqual(fresh.storage.get('keepVolume.state'), { volume: 0.35, muted: false });
});

test('legacy Undo never overwrites a newer ordinary value hidden from its stale manager cache', async () => {
  const platform = managers();
  const a = platform.client();
  const b = platform.client();
  const undo = await a.activity.clearLegacy();
  a.failures = 1;
  const restoring = undo();
  await setImmediate();
  await b.storage.set('keepSpeed.rate', 2.25);
  await a.advance();
  await restoring;
  assert.equal(platform.client().storage.get('keepSpeed.rate'), 2.25);
  assert.deepEqual(platform.client().storage.get('keepVolume.state'), { volume: 0.35, muted: false });
  platform.propagate();
  assert.equal(a.storage.get('keepSpeed.rate'), 2.25);
});

test('the account guard stops automatic legacy retries and private contexts never enumerate proposal keys', async () => {
  const platform = managers();
  const client = platform.client();
  const undo = await client.activity.clearLegacy();
  client.failures = 1;
  const restoring = undo();
  void restoring.catch(() => {});
  await setImmediate();
  const before = client.writes;
  client.account = '615000000000042';
  await client.advance();
  await assert.rejects(restoring, /account/);
  assert.equal(client.writes, before);
  const privateClient = platform.client({ privateWindow: true });
  assert.equal(privateClient.activity.legacy(), null);
  assert.throws(() => privateClient.activity.clearLegacy(), /unavailable/);
  privateClient.activity.storage.set('keepSpeed.rate', 1.75);
  assert.equal(privateClient.activity.storage.get('keepSpeed.rate'), 1.75);
  assert.equal(privateClient.writes, 0);
  assert.equal(privateClient.lists, 0);
});

test('ordinary playback envelopes remain account-scoped and invalidate an older confirmed import', async () => {
  const platform = managers();
  const client = platform.client();
  await client.activity.addLegacy();
  assert.equal(client.activity.storage.get('keepSpeed.rate'), 1.5);
  await client.activity.storage.set('keepSpeed.rate', 1.75);
  const key = activityKeyFor('keepSpeed.rate', client.account);
  assert.ok(platform.saved.get(key).nonce);
  assert.equal(platform.client().activity.storage.get('keepSpeed.rate'), 1.75);
  assert.equal(client.storage.get('keepSpeed.rate'), 1.5, 'unscoped legacy data is separate');
});

test('ambiguous imports keep playback reads usable and an explicit Add resolves the retained copies', async () => {
  const platform = managers();
  const key = activityKeyFor('keepSpeed.rate', '615000000000041');
  for (const [id, value] of [['left', 1.75], ['right', 2.25]]) platform.saved.set(`${key}#activity:${id}`, {
    tag: 'hfw-activity-v1', id, seed: 'undefined', at: 100, parents: [], kind: 'set', value,
  });
  const client = platform.client();
  assert.equal(client.activity.storage.get('keepSpeed.rate', 1), 1, 'a read uses its fallback rather than guessing a conflicting value');
  assert.equal(client.activity.legacy().speed, true, 'General still has a recovery source');
  const updates = [];
  client.storage.onChange(key, (value) => updates.push(value));
  assert.doesNotThrow(() => client.listeners.get(`${key}#activityChanged`)[0]('', null, 'pulse', true));
  assert.deepEqual(updates, [undefined]);
  await client.activity.addLegacy();
  assert.equal(platform.client().activity.storage.get('keepSpeed.rate'), 1.5);
  assert.equal(platform.saved.has(`${key}#activity:left`), true, 'conflicting copies remain intact');
  assert.equal(platform.saved.has(`${key}#activity:right`), true);
});

test('a conflicted plain legacy source stays available for explicit Delete and Undo', async () => {
  const platform = managers();
  for (const [id, value] of [['left', 1.75], ['right', 2.25]]) platform.saved.set(`keepSpeed.rate#activity:${id}`, {
    tag: 'hfw-activity-v1', id, seed: 'number:1.5', at: 100, parents: [], kind: 'set', value,
  });
  const client = platform.client();
  assert.equal(client.activity.legacy().speed, true);
  const undo = await client.activity.clearLegacy();
  assert.equal(platform.client().storage.get('keepSpeed.rate'), undefined);
  await undo();
  assert.equal(platform.client().storage.get('keepSpeed.rate'), 1.5);
});
