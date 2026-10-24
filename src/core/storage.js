// Storage adapters expose reads, change listeners and acknowledged field/delta mutations.
//
// GM_getValue is synchronous in Tampermonkey and Violentmonkey, which matters at
// document-start: hooks need the saved settings before Facebook sends its first request. The
// browser extension's storage (bridge.js) fills a few milliseconds in, and says when with
// whenReady.

import { extensionHost } from './extension.js';
import { applyWatchedOperation } from './watched.js';
import { createWatchedJournal, watchedStorageKey } from './watched-journal.js';

const sameStoredValue = (left, right) => {
  if (left === undefined || right === undefined) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
};

export function applyObjectMutation(current, mutation = {}) {
  if (Object.hasOwn(mutation, 'watched')) {
    if (Object.keys(mutation).length !== 1) throw new TypeError('watched-history operations cannot include other mutations');
    return applyWatchedOperation(current, mutation.watched);
  }
  const replacement = Object.hasOwn(mutation, 'replace');
  if (replacement) return structuredClone(mutation.replace);
  if (Object.hasOwn(mutation, 'union')) {
    if (!Array.isArray(mutation.union) || mutation.union.some((id) => typeof id !== 'string')) {
      throw new TypeError('union mutations require string ids');
    }
    const existing = Array.isArray(current) ? current.filter((id) => typeof id === 'string') : [];
    return [...new Set([...structuredClone(existing), ...structuredClone(mutation.union)])];
  }
  const initial = current === undefined && Object.hasOwn(mutation, 'initialize') ? mutation.initialize : current;
  const next = initial && typeof initial === 'object' && !Array.isArray(initial) ? structuredClone(initial) : {};
  const allowed = (name) => {
    const condition = mutation.conditions?.[name];
    if (!condition) return true;
    const exists = Object.hasOwn(initial ?? {}, name);
    return exists === condition.exists && (!exists || sameStoredValue(initial[name], condition.value));
  };
  for (const name of mutation.remove ?? []) {
    if (allowed(name)) delete next[name];
  }
  for (const [name, value] of Object.entries(mutation.set ?? {})) {
    if (allowed(name)) next[name] = structuredClone(value);
  }
  return next;
}

function mutateObjectDetailed(storage, key, mutation) {
  const previous = storage.get(key, undefined);
  const next = applyObjectMutation(previous, mutation);
  storage.set(key, next);
  return { value: structuredClone(next), previous: structuredClone(previous) };
}

function mutateObject(storage, key, mutation) {
  return mutateObjectDetailed(storage, key, mutation).value;
}

// Whether settings outlive the page: the manager's storage or the extension's.
export const keepsSettings = (storage) => storage.kind === 'gm' || storage.kind === 'extension';

export function createGmStorage({ log } = {}) {
  const extension = extensionHost({ log });
  if (extension) return extension.storage;
  if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') {
    return createLocalStorage();
  }
  const modern = typeof GM === 'object' ? GM : null;
  const journal = typeof GM_listValues === 'function' && typeof modern?.setValue === 'function' && typeof modern?.deleteValue === 'function'
    ? createWatchedJournal({
      get: (key, fallback) => GM_getValue(key, fallback), list: () => GM_listValues(),
      set: (key, value) => modern.setValue(key, value), remove: (key) => modern.deleteValue(key), log,
    }) : null;
  const storage = {
    kind: 'gm',
    watchedSupported: Boolean(journal),
    get: (key, fallback) => journal && watchedStorageKey(key) ? journal.read(key, fallback) : GM_getValue(key, fallback),
    set: (key, value) => GM_setValue(key, value),
    remove: (key) => (typeof GM_deleteValue === 'function' ? GM_deleteValue(key) : GM_setValue(key, undefined)),
    onChange(key, listener) {
      if (typeof GM_addValueChangeListener !== 'function') return;
      GM_addValueChangeListener(key, (_name, _old, value, remote) => {
        if (remote) listener(value);
      });
      if (journal && watchedStorageKey(key)) GM_addValueChangeListener(`${key}#changed`, (_name, _old, _value, remote) => {
        if (remote) listener(journal.read(key, []));
      });
    },
  };
  storage.mutate = (key, mutation, options = {}) => {
    if (watchedStorageKey(key) && Object.hasOwn(mutation, 'watched')) {
      if (!journal) throw new Error('This userscript manager cannot merge watched history across tabs');
      return journal.mutate(key, mutation.watched, options.allowed);
    }
    return mutateObject(storage, key, mutation);
  };
  storage.mutateDetailed = (key, mutation) => mutateObjectDetailed(storage, key, mutation);
  return storage;
}

// Fallback for managers without GM storage. It can't keep much on Facebook: the page's
// WebStorageMonster posts every localStorage key's name to Facebook's server and removes the
// ones the answer lists, which took an hfw: key within ten seconds of a load (live
// 2026-10-11, run 48). It only covers a manager the script doesn't support, and the script says
// so (UNKEPT_SETTINGS).
export const UNKEPT_SETTINGS = "Your userscript manager doesn't give HushFacebook Web storage of its own, so your settings are kept in Facebook's page, which clears them within seconds. Tampermonkey and Violentmonkey keep them.";

export function createLocalStorage(prefix = 'hfw:') {
  const storage = {
    kind: 'localStorage',
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(prefix + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set: (key, value) => localStorage.setItem(prefix + key, JSON.stringify(value)),
    remove: (key) => localStorage.removeItem(prefix + key),
    onChange(key, listener) {
      addEventListener('storage', (event) => {
        if (event.key !== prefix + key) return;
        try {
          listener(event.newValue === null ? undefined : JSON.parse(event.newValue));
        } catch {
          listener(undefined);
        }
      });
    },
  };
  storage.mutate = (key, mutation) => mutateObject(storage, key, mutation);
  storage.mutateDetailed = (key, mutation) => mutateObjectDetailed(storage, key, mutation);
  return storage;
}

export function createMemoryStorage(initial = {}) {
  const data = new Map(Object.entries(structuredClone(initial)));
  const storage = {
    kind: 'memory',
    get: (key, fallback) => (data.has(key) ? structuredClone(data.get(key)) : fallback),
    set: (key, value) => void data.set(key, structuredClone(value)),
    remove: (key) => void data.delete(key),
    onChange() {},
    dump: () => Object.fromEntries(data),
  };
  storage.mutate = (key, mutation) => mutateObject(storage, key, mutation);
  storage.mutateDetailed = (key, mutation) => mutateObjectDetailed(storage, key, mutation);
  return storage;
}
