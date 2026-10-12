// Keeping the script's tab marks out of Facebook's storage report.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepOutOfStorageReport, MONSTER, stepAside, wrapReport } from '../src/core/storage-report.js';

class FakeStorage {
  #data = new Map();
  constructor(entries = {}) {
    for (const [key, value] of Object.entries(entries)) this.#data.set(key, value);
  }
  get length() {
    return this.#data.size;
  }
  key(i) {
    return [...this.#data.keys()][i] ?? null;
  }
  getItem(key) {
    return this.#data.has(key) ? this.#data.get(key) : null;
  }
  setItem(key, value) {
    this.#data.set(key, String(value));
  }
  removeItem(key) {
    this.#data.delete(key);
  }
  dump() {
    return Object.fromEntries(this.#data);
  }
}

// WebStorageMonster as read live: cleanNow counts each storage's keys on the spot (name to
// length), then sends that. Its own timer calls it through the module object.
function fakeMonster(win) {
  const count = (store) => {
    const out = {};
    for (let i = 0; i < store.length; i++) out[store.key(i)] = store.getItem(store.key(i)).length;
    return out;
  };
  const monster = {
    reports: [],
    cleanNow(quiet) {
      this.reports.push({ quiet, local: count(win.localStorage), session: count(win.sessionStorage) });
      return 'sent';
    },
    tick: () => monster.cleanNow(false),
  };
  return monster;
}

const tabMarks = () => ({ 'hfw:started': '1', 'hfw:followingFeedRedirect': '1791768798777', fb_session_thing: 'xyz' });

test("the script's marks step out while Facebook counts sessionStorage and are back right after", () => {
  const win = { sessionStorage: new FakeStorage(tabMarks()), localStorage: new FakeStorage({ Session: 'abc' }) };
  const monster = fakeMonster(win);
  let reports = 0;
  assert.equal(wrapReport(monster, { win, onReport: () => reports++ }), true);
  assert.equal(monster.tick(), 'sent', "Facebook's call gets its own answer");
  assert.deepEqual(monster.reports, [{ quiet: false, local: { Session: 3 }, session: { fb_session_thing: 3 } }]);
  assert.deepEqual(win.sessionStorage.dump(), tabMarks());
  assert.equal(reports, 1);
});

test('the marks come back even when the report fails, and the failure is still Facebook\'s', () => {
  const win = { sessionStorage: new FakeStorage(tabMarks()) };
  const monster = { cleanNow() { throw new Error('offline'); } };
  wrapReport(monster, { win });
  assert.throws(() => monster.cleanNow(), /offline/);
  assert.deepEqual(win.sessionStorage.dump(), tabMarks());
});

test('a module handed back as a default export is wrapped too, and one without cleanNow is left alone', () => {
  const win = { sessionStorage: new FakeStorage(tabMarks()), localStorage: new FakeStorage() };
  const monster = fakeMonster(win);
  assert.equal(wrapReport({ default: monster }, { win }), true);
  monster.tick();
  assert.deepEqual(monster.reports[0].session, { fb_session_thing: 3 });
  const other = { schedule() {} };
  assert.equal(wrapReport(other, { win }), false);
  assert.deepEqual(Object.keys(other), ['schedule']);
  assert.equal(wrapReport(null, { win }), false);
});

test('a storage that refuses to be read leaves the report as Facebook makes it', () => {
  const win = { get sessionStorage() { throw new Error('denied'); }, localStorage: new FakeStorage() };
  let made = 0;
  const monster = { cleanNow: () => ++made };
  wrapReport(monster, { win });
  assert.equal(monster.cleanNow(), 1);
});

test('stepAside takes only the marks, and a full storage that refuses one back is quiet', () => {
  const store = new FakeStorage({ 'hfw:a': '1', other: '2', 'hfw:b': '3' });
  const restore = stepAside(store);
  assert.deepEqual(store.dump(), { other: '2' });
  store.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.doesNotThrow(restore);
});

test('Diagnostics says whether the report was reached, and a changed module is logged', () => {
  const rows = new Map();
  const diagnostics = { add: (name, read) => rows.set(name, read), changed() {} };
  const modules = new Map();
  const waiting = [];
  const win = {
    sessionStorage: new FakeStorage(tabMarks()),
    localStorage: new FakeStorage(),
    requireLazy: ([name], callback) => (modules.has(name) ? callback(modules.get(name)) : waiting.push([name, callback])),
  };
  keepOutOfStorageReport({ win, diagnostics });
  const row = () => rows.get("Facebook's storage report")();
  assert.equal(row(), 'Not loaded yet');
  const monster = fakeMonster(win);
  modules.set(MONSTER, monster);
  for (const [name, callback] of waiting) callback(modules.get(name));
  monster.tick();
  monster.tick();
  assert.equal(row(), "This script's marks kept out of 2 reports");
  assert.deepEqual(monster.reports.map((report) => Object.keys(report.session)), [['fb_session_thing'], ['fb_session_thing']]);

  const warnings = [];
  const changed = new Map();
  keepOutOfStorageReport({
    win: { requireLazy: (names, callback) => callback({ schedule() {} }) },
    log: { warn: (message) => warnings.push(message), error() {} },
    diagnostics: { add: (name, read) => changed.set(name, read), changed() {} },
  });
  assert.equal(changed.get("Facebook's storage report")(), 'Changed, so the marks may be in it');
  assert.equal(warnings.length, 1);
});
