// The daily job table and the storage check it runs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHECK_KEY, checkStorage, createDailyTasks, DAY, MIRROR_DB, MIRROR_KEY, pageMirror, RECENT, scheduleStorageCheck, TASKS_KEY, whenMirrorReady } from '../src/core/tasks.js';
import { createMemoryStorage } from '../src/core/storage.js';
import { createDiagnostics } from '../src/core/diagnostics.js';

const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);

function memoryMirror(initial = null) {
  let record = initial;
  return { get: () => record, set: (value) => { record = value; return true; } };
}

test('a daily job runs once a day and its last run is kept', () => {
  const storage = createMemoryStorage();
  let clock = T0;
  const tasks = createDailyTasks({ storage, now: () => clock });
  let runs = 0;
  tasks.add('demo', () => runs++);
  assert.deepEqual(tasks.runDue(), ['demo']);
  assert.deepEqual(storage.dump()[TASKS_KEY], { demo: T0 });
  clock += DAY - 1;
  assert.deepEqual(tasks.runDue(), []);
  clock += 1;
  assert.deepEqual(tasks.runDue(), ['demo']);
  assert.equal(runs, 2);
});

test('daily jobs wait for authoritative extension storage before deciding what is due', () => {
  const backing = createMemoryStorage({ [TASKS_KEY]: { demo: T0 - 1000 } });
  let loaded = false;
  let release;
  const storage = {
    get: (key, fallback) => (loaded ? backing.get(key, fallback) : fallback),
    set: (key, value) => backing.set(key, value),
    whenReady(run) {
      release = () => {
        loaded = true;
        run();
      };
    },
  };
  const tasks = createDailyTasks({ storage, now: () => T0 });
  let runs = 0;
  tasks.add('demo', () => runs++);

  assert.deepEqual(tasks.runDue(), []);
  assert.equal(runs, 0);
  release();
  assert.equal(runs, 0, 'the saved recent run prevents a defaults-backed duplicate');
  assert.deepEqual(backing.get(TASKS_KEY), { demo: T0 - 1000 });
});

test('a job that throws is logged and still counts as run; junk in the table is ignored', () => {
  const storage = createMemoryStorage({ [TASKS_KEY]: ['junk'] });
  const errors = [];
  const tasks = createDailyTasks({ storage, log: { error: (message) => errors.push(message) }, now: () => T0 });
  tasks.add('broken', () => { throw new Error('nope'); });
  tasks.add('fine', () => {});
  assert.deepEqual(tasks.runDue(), ['broken', 'fine']);
  assert.deepEqual(errors, ['The daily job "broken" failed']);
  assert.deepEqual(storage.dump()[TASKS_KEY], { broken: T0, fine: T0 });
});

test('a lost table falls back on the job\'s own record of its last run', () => {
  const tasks = createDailyTasks({ storage: createMemoryStorage(), now: () => T0 });
  let runs = 0;
  tasks.add('demo', () => runs++, { lastSeen: () => T0 - 1000 });
  assert.deepEqual(tasks.runDue(), []);
  assert.equal(runs, 0);
});

test('the storage check passes on a manager that keeps what it saves, day after day', () => {
  const storage = createMemoryStorage();
  const mirror = memoryMirror();
  assert.deepEqual(checkStorage({ storage, mirror, now: T0, token: 'a' }), { ok: true, at: T0 });
  assert.deepEqual(storage.dump()[CHECK_KEY], { token: 'a', at: T0 });
  assert.deepEqual(mirror.get(), { token: 'a', at: T0 });
  assert.deepEqual(checkStorage({ storage, mirror, now: T0 + DAY, token: 'b' }), { ok: true, at: T0 + DAY });
});

test('a manager that lost the last write between visits is caught, and the next check starts clean', () => {
  const storage = createMemoryStorage();
  const mirror = memoryMirror();
  checkStorage({ storage, mirror, now: T0, token: 'a' });
  // The manager lost it: the value is gone, or an old one came back.
  storage.remove(CHECK_KEY);
  const lost = checkStorage({ storage, mirror, now: T0 + DAY, token: 'b' });
  assert.equal(lost.ok, false);
  assert.match(lost.message, /didn't keep what HushFacebook Web saved on 2026-10-11/);
  storage.set(CHECK_KEY, { token: 'stale', at: T0 - DAY });
  assert.equal(checkStorage({ storage, mirror, now: T0 + 2 * DAY, token: 'c' }).ok, false);
  // The check wrote both copies again, so the one after that passes.
  assert.equal(checkStorage({ storage, mirror, now: T0 + 3 * DAY, token: 'd' }).ok, true);
});

test('www and web share the manager but not the page copy, and moving between them is no alarm', () => {
  const storage = createMemoryStorage();
  const www = memoryMirror();
  const web = memoryMirror();
  assert.equal(checkStorage({ storage, mirror: www, now: T0, token: 'a' }).ok, true);
  assert.equal(checkStorage({ storage, mirror: web, now: T0 + DAY, token: 'b' }).ok, true);
  // Back on www, its copy is the older one. The manager's is newer, written from web.
  assert.equal(checkStorage({ storage, mirror: www, now: T0 + 2 * DAY, token: 'c' }).ok, true);
  // A loss is still caught there: the manager's copy goes back to before www's last write.
  storage.set(CHECK_KEY, { token: 'b', at: T0 + DAY });
  assert.equal(checkStorage({ storage, mirror: www, now: T0 + 3 * DAY, token: 'd' }).ok, false);
});

test("two tabs checking at once don't trip over each other's copies", () => {
  const storage = createMemoryStorage({ [CHECK_KEY]: { token: 'a', at: T0 } });
  const mirror = memoryMirror({ token: 'a', at: T0 });
  // The first tab's check writes both copies.
  assert.equal(checkStorage({ storage, mirror, now: T0 + DAY, token: 'b' }).ok, true);
  // The second tab still sees the manager's old value, but the page copy is seconds old.
  let reads = 0;
  const stale = { get: (key, fallback) => (reads++ === 0 ? { token: 'a', at: T0 } : storage.get(key, fallback)), set: (key, value) => storage.set(key, value) };
  assert.equal(checkStorage({ storage: stale, mirror, now: T0 + DAY + 5000, token: 'c' }).ok, true);
  // Past those few minutes, the same mismatch is a loss again.
  storage.set(CHECK_KEY, { token: 'a', at: T0 });
  assert.equal(checkStorage({ storage, mirror, now: T0 + DAY + 5000 + RECENT, token: 'd' }).ok, false);
});

test('a manager that won\'t save or won\'t give a value back fails the check', () => {
  const dropping = { get: () => undefined, set: () => {} };
  assert.match(checkStorage({ storage: dropping, mirror: null, now: T0, token: 'a' }).message, /didn't give back what HushFacebook Web just saved/);
  const throwing = { get: () => undefined, set: () => { throw new Error('quota'); } };
  assert.match(checkStorage({ storage: throwing, mirror: null, now: T0, token: 'a' }).message, /wouldn't save \(quota\)/);
  const unreadable = { get: () => { throw new Error('locked'); }, set: () => {} };
  assert.match(checkStorage({ storage: unreadable, mirror: null, now: T0, token: 'a' }).message, /couldn't be read \(locked\)/);
});

test('a first check, or one without the page copy, only tests the round trip', () => {
  assert.equal(checkStorage({ storage: createMemoryStorage(), mirror: memoryMirror(), now: T0, token: 'a' }).ok, true);
  assert.equal(checkStorage({ storage: createMemoryStorage({ [CHECK_KEY]: { token: 'old', at: T0 - DAY } }), mirror: null, now: T0, token: 'a' }).ok, true);
});

test('a failed check shows a toast, logs it and says so in Diagnostics', () => {
  const storage = { get: () => undefined, set: () => {} };
  const toasts = [];
  const errors = [];
  const diagnostics = createDiagnostics();
  const tasks = createDailyTasks({ storage: createMemoryStorage(), now: () => T0 });
  scheduleStorageCheck({ tasks, storage, mirror: memoryMirror(), log: { error: (message) => errors.push(message) }, toast: (message, options) => toasts.push([message, options]), diagnostics, now: () => T0 });
  const row = () => diagnostics.rows().find((entry) => entry.label === 'Storage check').value;
  assert.equal(row(), 'Runs within a day');
  assert.deepEqual(tasks.runDue(), [CHECK_KEY]);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0][1].tone, 'error');
  assert.equal(errors.length, 1);
  assert.match(row(), /^Failed: Your userscript manager didn't give back/);
});

test("a failed check logs the manager's error as the detail, not in the message", () => {
  const storage = { get: () => undefined, set: () => { throw new Error('PRIVATE quota'); } };
  const logged = [];
  const toasts = [];
  const tasks = createDailyTasks({ storage: createMemoryStorage(), now: () => T0 });
  scheduleStorageCheck({ tasks, storage, mirror: memoryMirror(), log: { error: (message, detail) => logged.push([message, detail]) }, toast: (message) => toasts.push(message), diagnostics: createDiagnostics(), now: () => T0 });
  tasks.runDue();
  assert.equal(logged.length, 1);
  assert.doesNotMatch(logged[0][0], /PRIVATE/);
  assert.equal(logged[0][1].message, 'PRIVATE quota');
  assert.match(toasts[0], /wouldn't save \(PRIVATE quota\)/, 'the toast still names the error for the person');
});

test('a passing check is quiet and Diagnostics shows when it ran', () => {
  const storage = createMemoryStorage();
  const toasts = [];
  const diagnostics = createDiagnostics();
  const tasks = createDailyTasks({ storage, now: () => T0 });
  scheduleStorageCheck({ tasks, storage, mirror: memoryMirror(), toast: (message) => toasts.push(message), diagnostics, now: () => T0 });
  tasks.runDue();
  assert.deepEqual(toasts, []);
  assert.match(diagnostics.rows().find((entry) => entry.label === 'Storage check').value, /^Passed /);
});

// IndexedDB as far as pageMirror uses it, answering on a later turn the way a browser does.
// With record, the database is already there holding it. Without, opening it creates it.
function fakeIndexedDB({ record, failOpen = false } = {}) {
  const later = (fn) => setTimeout(fn, 0);
  const stores = new Map();
  if (record !== undefined) stores.set('checks', new Map([[MIRROR_KEY, record]]));
  const opened = [];
  const db = {
    createObjectStore(name) {
      stores.set(name, new Map());
    },
    transaction(name, mode) {
      const store = stores.get(name);
      if (!store) throw new Error(`No store ${name}`);
      return {
        objectStore: () => ({
          get(key) {
            const request = {};
            later(() => {
              request.result = store.get(key);
              request.onsuccess?.();
            });
            return request;
          },
          put(value, key) {
            if (mode !== 'readwrite') throw new Error('Read only');
            store.set(key, structuredClone(value));
            return {};
          },
        }),
      };
    },
  };
  return {
    stores,
    opened,
    open(name, version) {
      opened.push([name, version]);
      const request = {};
      later(() => {
        if (failOpen) {
          request.onerror?.();
          return;
        }
        request.result = db;
        if (!stores.has('checks')) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

test('the page copy lives in IndexedDB, where Facebook\'s storage cleaner doesn\'t reach', async () => {
  const idb = fakeIndexedDB();
  const writes = [];
  const win = { indexedDB: idb, localStorage: { getItem: () => null, setItem: (key) => writes.push(key) } };
  const mirror = pageMirror(win);
  assert.deepEqual(idb.opened, [[MIRROR_DB, 1]]);
  assert.equal(mirror.get(), null);
  await settle();
  assert.equal(mirror.get(), null, 'a new database has no copy yet');
  assert.equal(mirror.set({ token: 'a', at: T0 }), true);
  assert.deepEqual(idb.stores.get('checks').get(MIRROR_KEY), { token: 'a', at: T0 });
  assert.deepEqual(mirror.get(), { token: 'a', at: T0 });
  assert.deepEqual(writes, [], 'nothing goes to localStorage');
});

test('a copy from an earlier day is read back once the database answers, and junk reads as none', async () => {
  const mirror = pageMirror({ indexedDB: fakeIndexedDB({ record: { token: 'old', at: T0 - DAY } }) });
  assert.equal(mirror.get(), null, 'nothing is known before the read is back');
  await settle();
  assert.deepEqual(mirror.get(), { token: 'old', at: T0 - DAY });
  const junk = pageMirror({ indexedDB: fakeIndexedDB({ record: '{broken' }) });
  await settle();
  assert.equal(junk.get(), null);
});

test('a check that runs before the database answers is saved once it does, and never compared against nothing', async () => {
  const idb = fakeIndexedDB({ record: { token: 'old', at: T0 - DAY } });
  const mirror = pageMirror({ indexedDB: idb });
  const storage = createMemoryStorage({ [CHECK_KEY]: { token: 'other', at: T0 - 2 * DAY } });
  assert.deepEqual(checkStorage({ storage, mirror, now: T0, token: 'new' }), { ok: true, at: T0 }, 'the stale copy is unread, so no false alarm');
  assert.deepEqual(idb.stores.get('checks').get(MIRROR_KEY), { token: 'old', at: T0 - DAY }, 'not written before the database is open');
  await settle();
  assert.deepEqual(idb.stores.get('checks').get(MIRROR_KEY), { token: 'new', at: T0 });
  assert.deepEqual(mirror.get(), { token: 'new', at: T0 }, 'the newer write wins over the copy read back');
});

test('without IndexedDB there is no page copy, and a database that won\'t open stays quiet', async () => {
  assert.equal(pageMirror({}), null);
  assert.equal(pageMirror({ get indexedDB() { throw new Error('blocked'); } }), null);
  assert.equal(pageMirror({ indexedDB: { open() { throw new Error('denied'); } } }), null);
  const closed = pageMirror({ indexedDB: fakeIndexedDB({ failOpen: true }) });
  await settle();
  assert.equal(closed.get(), null);
  assert.equal(closed.set({ token: 'a', at: T0 }), true);
  assert.equal(closed.get(), null);
});

test('the daily jobs wait for the page copy to be read, and not forever', async () => {
  const idb = fakeIndexedDB({ record: { token: 'old', at: T0 - 1000 } });
  const mirror = pageMirror({ indexedDB: idb });
  const storage = createMemoryStorage();
  const tasks = createDailyTasks({ storage, now: () => T0 });
  let runs = 0;
  scheduleStorageCheck({ tasks, storage, mirror, now: () => T0 });
  tasks.add('demo', () => runs++);
  let ran = null;
  let calls = 0;
  const timers = [];
  whenMirrorReady(mirror, () => { calls++; ran = tasks.runDue(); }, { setTimer: (fn, ms) => timers.push([fn, ms]) });
  assert.equal(ran, null, 'not before the read is back');
  await settle();
  assert.deepEqual(ran, ['demo'], 'the storage check ran within the day the page copy records, so it waits');
  timers[0][0]();
  assert.equal(calls, 1, "the time limit doesn't call them a second time");
  assert.equal(runs, 1);
  let late = 0;
  const never = { ready: new Promise(() => {}), get: () => null, set: () => true };
  const held = [];
  whenMirrorReady(never, () => late++, { wait: 30000, setTimer: (fn, ms) => held.push([fn, ms]) });
  assert.equal(late, 0);
  assert.equal(held[0][1], 30000);
  held[0][0]();
  assert.equal(late, 1, 'a read that never comes back holds them up no longer than the limit');
  let bare = 0;
  whenMirrorReady(null, () => bare++);
  assert.equal(bare, 1, 'with no page copy they run at once');
});
