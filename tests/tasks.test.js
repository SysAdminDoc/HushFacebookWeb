// The daily job table and the storage check it runs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHECK_KEY, checkStorage, createDailyTasks, DAY, localMirror, MIRROR_KEY, RECENT, scheduleStorageCheck, TASKS_KEY } from '../src/core/tasks.js';
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

test('the page copy lives in localStorage under its own key and survives junk', () => {
  const data = new Map();
  const win = { localStorage: { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) } };
  const mirror = localMirror(win);
  assert.equal(mirror.get(), null);
  assert.equal(mirror.set({ token: 'a', at: T0 }), true);
  assert.deepEqual(JSON.parse(data.get(MIRROR_KEY)), { token: 'a', at: T0 });
  assert.deepEqual(mirror.get(), { token: 'a', at: T0 });
  data.set(MIRROR_KEY, '{broken');
  assert.equal(mirror.get(), null);
  assert.equal(localMirror({ get localStorage() { throw new Error('blocked'); } }), null);
  assert.equal(localMirror({}), null);
});
