// Jobs that run at most once a day, a few seconds after a page loads, the way Social Fixer's
// task table did. When each one last ran is kept in the manager's storage under 'tasks'
// ({ id: time }).
//
// The first job is a storage check, after Social Fixer's storage_check, which caught managers
// that lose what a script saves. A write read back on the same page nearly always works, since
// managers keep a copy in memory, so the check also leaves a token in two places: the
// manager's storage and the page's own IndexedDB. On the next check a day later, the two
// should still agree. If the manager's copy is gone or older than the page's, it didn't keep a
// write. A newer one is another page's check, since www.facebook.com and web.facebook.com share
// the manager's storage but each has its own IndexedDB. A page copy written in the last few
// minutes is another tab's check running alongside, and isn't compared.

import { KEEPER } from './target.js';

export const DAY = 24 * 60 * 60 * 1000;
export const RECENT = 10 * 60 * 1000;
export const TASKS_KEY = 'tasks';
export const CHECK_KEY = 'storageCheck';
export const MIRROR_KEY = 'hfw:storageCheck';

const asTable = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const asRecord = (value) => (value && typeof value === 'object' && typeof value.token === 'string' ? value : null);

// A value from read(), or fallback when it throws.
function attempt(read, fallback) {
  try {
    return read();
  } catch {
    return fallback;
  }
}

export function createDailyTasks({ storage, log, now = () => Date.now() }) {
  const tasks = [];
  let ready = !storage.whenReady;
  let pending = false;
  const runDue = () => {
    if (!ready) {
      pending = true;
      return [];
    }
    let table;
    try {
      table = { ...asTable(storage.get(TASKS_KEY, {})) };
    } catch (error) {
      log?.error("Couldn't read when the daily jobs last ran", error);
      table = {};
    }
    const ran = [];
    for (const task of tasks) {
      const other = attempt(() => Number(task.lastSeen?.()) || 0, 0);
      const last = Math.max(Number(table[task.id]) || 0, other);
      if (now() - last < DAY) continue;
      try {
        task.run();
      } catch (error) {
        log?.error(`The daily job "${task.id}" failed`, error);
      }
      table[task.id] = now();
      ran.push(task.id);
    }
    if (ran.length) {
      try {
        storage.set(TASKS_KEY, table);
      } catch (error) {
        log?.error("Couldn't note that the daily jobs ran", error);
      }
    }
    return ran;
  };
  const api = {
    // lastSeen: another record of the last run, used when the table itself was lost.
    add(id, run, { lastSeen } = {}) {
      tasks.push({ id, run, lastSeen });
    },
    // Runs every job that hasn't run in the last day. Returns the ids it ran.
    runDue,
  };
  storage.whenReady?.(() => {
    ready = true;
    if (!pending) return;
    pending = false;
    runDue();
  });
  return api;
}

// The page's own IndexedDB, for the second copy of the token. Not localStorage: Facebook's
// WebStorageMonster removes localStorage keys it doesn't know a few seconds into a page load
// (live 2026-10-11, run 48: hfw:storageCheck there at load, gone ten seconds later), and tells
// Facebook's server their names on the way. The copy is read once at start. Until that read is
// back, get() knows nothing, so a slow read never looks like a lost write, and a write made
// meanwhile is kept and saved once the database is open. ready settles when the read is back
// or the database won't open. null where IndexedDB can't be used.
export const MIRROR_DB = 'hushfacebook-web';
const MIRROR_STORE = 'checks';

export function pageMirror(win = globalThis) {
  const idb = attempt(() => win.indexedDB, null);
  if (!idb || typeof idb.open !== 'function') return null;
  let db = null;
  let known = false;
  let record = null;
  let pending = null;
  let settle;
  const ready = new Promise((resolve) => {
    settle = resolve;
  });
  const write = (value) => {
    try {
      db.transaction(MIRROR_STORE, 'readwrite').objectStore(MIRROR_STORE).put(value, MIRROR_KEY);
      return true;
    } catch {
      return false;
    }
  };
  const loaded = (value) => {
    known = true;
    record = pending ?? asRecord(value);
    if (pending) write(pending);
    pending = null;
    settle();
  };
  try {
    const request = idb.open(MIRROR_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(MIRROR_STORE);
    request.onsuccess = () => {
      db = request.result;
      // Never stand in the way of a newer copy of the script in another tab.
      db.onversionchange = () => db.close();
      try {
        const read = db.transaction(MIRROR_STORE, 'readonly').objectStore(MIRROR_STORE).get(MIRROR_KEY);
        read.onsuccess = () => loaded(read.result);
        read.onerror = () => loaded(null);
      } catch {
        loaded(null);
      }
    };
    request.onerror = () => settle();
  } catch {
    return null;
  }
  return {
    ready,
    get: () => (known ? record : null),
    set(value) {
      if (!known) {
        pending = value;
        return true;
      }
      record = value;
      return write(value);
    },
  };
}

// Runs run() once the mirror has read its copy, or after wait ms if it never does, so the daily
// jobs see the page's record of their last run.
export function whenMirrorReady(mirror, run, { wait = 30000, setTimer = setTimeout } = {}) {
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    run();
  };
  if (!mirror?.ready) {
    go();
    return;
  }
  mirror.ready.then(go, go);
  setTimer(go, wait);
}

const randomToken = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
const day = (time) => new Date(time).toISOString().slice(0, 10);
const STORAGE_FAILED = `${KEEPER}'s storage failed the daily check, so your settings may not be saving`;

// One check. Returns { ok: true, at } or { ok: false, at, message, cause? }, where cause is the
// manager's own error when there was one.
export function checkStorage({ storage, mirror, now = Date.now(), token = randomToken() }) {
  let kept;
  try {
    kept = asRecord(storage.get(CHECK_KEY, null));
  } catch (error) {
    return { ok: false, at: now, cause: error, message: `${KEEPER}'s storage couldn't be read (${error?.message ?? error}), so your settings may not be saved.` };
  }
  const before = mirror?.get() ?? null;
  const earlier = before && !(now - Number(before.at) < RECENT);
  const lost = earlier && (!kept || (kept.token !== before.token && !(Number(kept.at) > Number(before.at))))
    ? `${KEEPER} didn't keep what HushFacebook Web saved on ${day(before.at)}. If you didn't reinstall the script or clear its storage since then, your settings may not be saving.`
    : null;
  try {
    storage.set(CHECK_KEY, { token, at: now });
    const back = asRecord(storage.get(CHECK_KEY, null));
    if (!back || back.token !== token) {
      return { ok: false, at: now, message: `${KEEPER} didn't give back what HushFacebook Web just saved, so your settings may not be saving.` };
    }
  } catch (error) {
    return { ok: false, at: now, cause: error, message: `${KEEPER} wouldn't save (${error?.message ?? error}), so your settings may not be saving.` };
  }
  mirror?.set({ token, at: now });
  return lost ? { ok: false, at: now, message: lost } : { ok: true, at: now };
}

// Wires the storage check into the daily jobs, the toast and Diagnostics.
export function scheduleStorageCheck({ tasks, storage, mirror, log, toast, diagnostics, now = () => Date.now() }) {
  let result = null;
  tasks.add(CHECK_KEY, () => {
    result = checkStorage({ storage, mirror, now: now() });
    if (!result.ok) {
      // The manager's own error text goes in the detail, where Copy report doesn't reach.
      log?.error(result.cause ? STORAGE_FAILED : result.message, result.cause);
      toast?.(result.message, { tone: 'error' });
    }
    diagnostics?.changed();
  }, { lastSeen: () => mirror?.get()?.at ?? 0 });
  diagnostics?.add('Storage check', () => {
    if (result) return result.ok ? `Passed ${new Date(result.at).toLocaleString()}` : `Failed: ${result.message}`;
    const kept = attempt(() => asRecord(storage.get(CHECK_KEY, null)), null);
    return kept ? `Last ran ${new Date(kept.at).toLocaleString()}, runs again within a day` : 'Runs within a day';
  });
}
