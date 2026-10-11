// Jobs that run at most once a day, a few seconds after a page loads, the way Social Fixer's
// task table did. When each one last ran is kept in the manager's storage under 'tasks'
// ({ id: time }).
//
// The first job is a storage check, after Social Fixer's storage_check, which caught managers
// that lose what a script saves. A write read back on the same page nearly always works, since
// managers keep a copy in memory, so the check also leaves a token in two places: the
// manager's storage and the page's own localStorage. On the next check a day later, the two
// should still agree. If the manager's copy is gone or different, it didn't keep a write.

export const DAY = 24 * 60 * 60 * 1000;
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
  return {
    // lastSeen: another record of the last run, used when the table itself was lost.
    add(id, run, { lastSeen } = {}) {
      tasks.push({ id, run, lastSeen });
    },
    // Runs every job that hasn't run in the last day. Returns the ids it ran.
    runDue() {
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
    },
  };
}

// The page's own localStorage, for the second copy of the token. null where it can't be used.
export function localMirror(win = globalThis) {
  let store;
  try {
    store = win.localStorage;
    if (!store) return null;
  } catch {
    return null;
  }
  return {
    get() {
      try {
        return asRecord(JSON.parse(store.getItem(MIRROR_KEY) ?? 'null'));
      } catch {
        return null;
      }
    },
    set(record) {
      try {
        store.setItem(MIRROR_KEY, JSON.stringify(record));
        return true;
      } catch {
        return false;
      }
    },
  };
}

const randomToken = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
const day = (time) => new Date(time).toISOString().slice(0, 10);

// One check. Returns { ok: true, at } or { ok: false, at, message }.
export function checkStorage({ storage, mirror, now = Date.now(), token = randomToken() }) {
  let kept;
  try {
    kept = asRecord(storage.get(CHECK_KEY, null));
  } catch (error) {
    return { ok: false, at: now, message: `Your userscript manager's storage couldn't be read (${error?.message ?? error}), so your settings may not be saved.` };
  }
  const before = mirror?.get() ?? null;
  const lost = before && (!kept || kept.token !== before.token)
    ? `Your userscript manager didn't keep what HushFacebook Web saved on ${day(before.at)}. If you didn't reinstall the script or clear its storage since then, your settings may not be saving.`
    : null;
  try {
    storage.set(CHECK_KEY, { token, at: now });
    const back = asRecord(storage.get(CHECK_KEY, null));
    if (!back || back.token !== token) {
      return { ok: false, at: now, message: "Your userscript manager didn't give back what HushFacebook Web just saved, so your settings may not be saving." };
    }
  } catch (error) {
    return { ok: false, at: now, message: `Your userscript manager wouldn't save (${error?.message ?? error}), so your settings may not be saving.` };
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
      log?.error(result.message);
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
