import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSeenStore, SEEN_KEY, CLEARED_KEY } from '../src/core/seen-store.js';
import vm from 'node:vm';
import { build } from 'esbuild';
import { createActivityStorage } from '../src/core/activity.js';
import { applySeenOperation, mergeSeenRecords, validSeenOperation, MAX_ENTRIES } from '../src/core/seen.js';

const { outputFiles } = await build({ entryPoints: ['src/core/storage.js'], bundle: true, write: false, format: 'iife', globalName: 'StorageFixture' });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function managers(seed = {}) {
  const backend = new Map(Object.entries(structuredClone(seed)));
  const clients = [];
  const events = [];
  const platform = {
    clock: 100000, backend,
    propagate() {
      while (events.length) {
        const [key, value, owner] = events.shift();
        for (const client of clients) {
          if (client === owner) continue;
          if (value === undefined) client.cache.delete(key);
          else client.cache.set(key, structuredClone(value));
          for (const run of client.listeners.get(key) ?? []) run(key, null, structuredClone(value), true);
        }
      }
    },
    client({ privateWindow = false, account = null, currentAccount = () => account, unsupported = false } = {}) {
      const client = { cache: new Map([...backend].map(([key, value]) => [key, structuredClone(value)])), listeners: new Map(), fail: false, hold: null, writes: 0, lists: 0 };
      const get = (key, fallback) => client.cache.has(key) ? structuredClone(client.cache.get(key)) : fallback;
      const set = async (key, value) => {
        if (JSON.stringify(get(key)) === JSON.stringify(value)) return;
        client.cache.set(key, structuredClone(value));
        if (client.fail) throw new Error('storage unavailable');
        if (client.hold && value.add) await client.hold;
        client.writes++;
        backend.set(key, structuredClone(value));
        events.push([key, structuredClone(value), client]);
      };
      const remove = async (key) => {
        if (client.fail) throw new Error('storage unavailable');
        client.cache.delete(key);
        backend.delete(key);
        events.push([key, undefined, client]);
      };
      const context = vm.createContext({
        GM_info: { isIncognito: privateWindow, scriptHandler: 'Violentmonkey' },
        GM_getValue: get, GM_setValue: set, GM_deleteValue: remove,
        GM_listValues: () => { client.lists++; return [...client.cache.keys()]; },
        GM_addValueChangeListener(key, run) { client.listeners.set(key, [...client.listeners.get(key) ?? [], run]); },
        GM: { setValue: set, deleteValue: remove }, crypto, structuredClone, TextEncoder, URL,
        Date: class extends Date { static now() { return platform.clock; } },
      });
      if (unsupported) delete context.GM_listValues;
      vm.runInContext(outputFiles[0].text, context);
      const raw = context.StorageFixture.createGmStorage();
      const activity = createActivityStorage({ storage: raw, account, currentAccount, now: () => platform.clock });
      const store = createSeenStore({ ...options, now: () => platform.clock, storage: activity.storage });
      Object.assign(client, { raw, activity, store });
      clients.push(client);
      return client;
    },
  };
  return platform;
}

const options = { now: () => 100000, schedule: () => 1, cancel() {}, every: null };

test('seen batches use authoritative additions rather than publishing a cached whole list', async () => {
  const saved = new Map();
  const mutations = [];
  const storage = {
    seenSupported: true,
    get: (key, fallback) => saved.get(key) ?? fallback,
    set: (key, value) => saved.set(key, structuredClone(value)),
    mutate(key, mutation) {
      mutations.push([key, mutation]);
      saved.set(key, { ...saved.get(key), ...mutation.seen.add });
      return structuredClone(saved.get(key));
    },
  };
  const first = createSeenStore({ ...options, storage });
  const second = createSeenStore({ ...options, storage });
  first.add('post-a');
  second.add('post-b');
  await first.flush();
  await second.flush();
  assert.equal(mutations.length, 2, 'both writes are additions at the authority');
  assert.equal(mutations[0][0], SEEN_KEY);
  assert.deepEqual(Object.keys(mutations[1][1].seen.add), ['post-b']);
  const fresh = createSeenStore({ ...options, storage });
  assert.deepEqual([...fresh.since(0)].sort(), ['post-a', 'post-b']);
  assert.equal(storage.get(CLEARED_KEY, 0), 0);
});

test('real GM adapters merge stale caches durably before and after delayed notifications', async () => {
  const platform = managers();
  const a = platform.client();
  const b = platform.client();
  a.store.add(['post-a', 'same']);
  platform.clock++;
  b.store.add(['post-b', 'same']);
  await Promise.all([a.store.flush(), b.store.flush()]);
  const expected = ['post-a', 'post-b', 'same'];
  assert.deepEqual([...platform.client().store.since(0)].sort(), expected, 'fresh manager sees durable operations before old caches hear them');
  platform.propagate();
  for (const client of [a, b]) assert.deepEqual([...client.store.since(0)].sort(), expected);
  assert.deepEqual([...platform.client().store.since(0, platform.clock)], ['post-a', 'same'], 'earliest duplicate time survives reopening');
});

test('a clear wins over held older writes and same-clock stale observations after restart', async () => {
  const platform = managers();
  const a = platform.client();
  const b = platform.client();
  let release;
  a.hold = new Promise((resolve) => { release = resolve; });
  a.store.add('older');
  const held = a.store.flush();
  await tick();
  await b.store.clear();
  release();
  await held;
  assert.equal(platform.client().store.size(), 0);
  platform.propagate();
  assert.equal(a.store.size(), 0);
  b.store.add('after-clear');
  await b.store.flush();
  assert.deepEqual([...platform.client().store.since(0)], ['after-clear']);
});

test('a stale same-clock clear beats an addition made after an earlier clear', async () => {
  const platform = managers();
  const a = platform.client();
  const b = platform.client();
  await a.store.clear();
  let release;
  a.hold = new Promise((resolve) => { release = resolve; });
  a.store.add('older-than-second-clear');
  const held = a.store.flush();
  await tick();
  await b.store.clear();
  release();
  await held;
  assert.equal(platform.client().store.size(), 0);
  platform.propagate();
  a.hold = null;
  a.store.add('after-both-clears');
  await a.store.flush();
  assert.deepEqual([...platform.client().store.since(0)], ['after-both-clears']);
});

test('a manager missing journal APIs refuses unsafe durable seen snapshots', async () => {
  const platform = managers();
  const client = platform.client({ unsupported: true });
  assert.equal(client.store.add('unsafe'), false);
  assert.equal(client.store.failed(), true);
  await assert.rejects(client.store.retry(), /cannot merge seen history/);
  await assert.rejects(client.store.clear(), /cannot merge seen history/);
  assert.equal(client.writes, 0);
});

test('rejected cache-only additions remain retryable and a fresh reader sees one acknowledged result', async () => {
  const platform = managers();
  const client = platform.client();
  client.fail = true;
  client.store.add('retry');
  await assert.rejects(client.store.flush(), /unavailable/);
  assert.equal(client.store.failed(), true);
  assert.equal(platform.client().store.size(), 0, 'cache-only ghost is not durable');
  client.fail = false;
  await client.store.retry();
  assert.equal(client.store.failed(), false);
  assert.deepEqual([...platform.client().store.since(0)], ['retry']);
});

test('queued seen writes stop at an account change and private history never enumerates GM keys', async () => {
  const platform = managers();
  let account = '100000000000017';
  const client = platform.client({ account, currentAccount: () => account });
  client.store.add('old-account');
  account = '100000000000018';
  await assert.rejects(client.store.flush(), /account/);
  assert.equal(client.writes, 0);
  assert.equal(client.store.size(), 0);
  const privateClient = platform.client({ privateWindow: true });
  privateClient.store.add('private');
  await privateClient.store.flush();
  assert.equal(privateClient.lists, 0);
  assert.equal(privateClient.writes, 0);
  assert.equal(platform.client().store.size(), 0);
});

test('seen operations retain earliest timestamps, deterministic ties, expiry and strict clear barriers', () => {
  const rows = Object.fromEntries(Array.from({ length: MAX_ENTRIES + 1 }, (_, index) => [`post-${String(index).padStart(5, '0')}`, 100]));
  const kept = mergeSeenRecords([rows], 0, 100);
  assert.equal(Object.keys(kept).length, MAX_ENTRIES);
  assert.equal(kept['post-05000'], undefined, 'ties use stable ids');
  assert.deepEqual(applySeenOperation({ same: 10, fresh: 20 }, 0, { add: { same: 15 }, at: 30 }).entries, { fresh: 20, same: 10 });
  assert.deepEqual(applySeenOperation({ same: 10 }, 10, { add: { same: 10, fresh: 11 }, at: 30 }).entries, { fresh: 11 });
  assert.deepEqual(mergeSeenRecords([{ old: 1 }], 0, 31 * 86400000), {});
  for (const operation of [{ add: {}, clear: 2, at: 2 }, { clear: -1, at: 2 }, { add: { bad: NaN }, at: 2 }, { add: {}, at: Infinity }, { add: {}, at: 2, extra: true }]) assert.equal(validSeenOperation(operation), false);
});

test('GM compaction checkpoints preserve durable first-seen times and retained clears', async () => {
  const platform = managers();
  const client = platform.client();
  await client.store.clear();
  for (let i = 0; i < 70; i++) {
    platform.clock++;
    client.store.add(`post-${i}`);
    await client.store.flush();
  }
  assert.equal(platform.client().store.size(), 70);
  assert.ok([...platform.backend.keys()].filter((key) => key.includes('#seen:')).length <= 33);
  await client.store.clear();
  assert.equal(platform.client().store.size(), 0);
});

test('same-clock clear tokens survive compaction and fresh reopen', async () => {
  const platform = managers();
  const a = platform.client();
  const b = platform.client();
  await a.store.clear();
  await b.store.clear();
  platform.propagate();
  for (let i = 0; i < 40; i++) {
    a.store.add(`equal-${i}`);
    await a.store.flush();
  }
  assert.equal(platform.client().store.size(), 40);
});
