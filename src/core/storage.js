// Storage adapters expose reads, change listeners and acknowledged field/delta mutations.
//
// GM_getValue is synchronous in Tampermonkey and Violentmonkey, which matters at
// document-start: hooks need the saved settings before Facebook sends its first request. The
// browser extension's storage (bridge.js) fills a few milliseconds in, and says when with
// whenReady.

import { extensionHost } from './extension.js';
import { activityContextFor } from './env.js';
import { applyWatchedOperation } from './watched.js';
import { createWatchedJournal, watchedStorageKey } from './watched-journal.js';
import { createSeenJournal } from './seen-journal.js';
import { applySeenOperation, seenStorageKey, seenClearKey } from './seen.js';
import { createGmActivityRegister, gmActivityRegisterKey, gmActivityPulseKey } from './gm-activity-register.js';

const sameStoredValue = (left, right) => {
  if (left === undefined || right === undefined) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
};

export function applyObjectMutation(current, mutation = {}) {
  if (Object.hasOwn(mutation, 'seen')) {
    if (Object.keys(mutation).length !== 1) throw new TypeError('Seen operations cannot include other mutations');
    return applySeenOperation(current, 0, mutation.seen).entries;
  }
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
  const state = Object.hasOwn(mutation, 'seen') ? applySeenOperation(previous, storage.get(seenClearKey(key), 0), mutation.seen) : null;
  const next = state ? state.entries : applyObjectMutation(previous, mutation);
  if (state) storage.set(seenClearKey(key), state.clearedAt);
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
  const context = activityContextFor(typeof GM_info === 'undefined' ? null : GM_info);
  if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') {
    return { ...createLocalStorage(), activityContext: () => context };
  }
  const modern = typeof GM === 'object' ? GM : null;
  const unconfirmed = new Map();
  const setConfirmed = (key, value, options = {}) => {
    if (activityRegister && gmActivityRegisterKey(key)) return value === undefined ? activityRegister.erase(key, options) : activityRegister.write(key, value, options);
    // A manager may update its cache before a rejected write, then skip an identical retry.
    if (unconfirmed.has(key) && sameStoredValue(unconfirmed.get(key), value) && sameStoredValue(GM_getValue(key, undefined), value)) {
      return Promise.reject(Object.assign(new Error('This activity save is still unconfirmed'), { code: 'ACTIVITY_SAVE_UNCONFIRMED' }));
    }
    const failed = (error) => { unconfirmed.set(key, structuredClone(value)); throw error; };
    const accepted = (result) => { unconfirmed.delete(key); return result; };
    try {
      const saved = modern?.setValue ? modern.setValue(key, value) : GM_setValue(key, value);
      return saved && typeof saved.then === 'function' ? saved.then(accepted, failed) : accepted(saved);
    } catch (error) {
      return failed(error);
    }
  };
  const journal = context === 'normal' && typeof GM_listValues === 'function' && typeof modern?.setValue === 'function' && typeof modern?.deleteValue === 'function'
    ? createWatchedJournal({
      get: (key, fallback) => GM_getValue(key, fallback), list: () => GM_listValues(),
      set: (key, value) => modern.setValue(key, value), remove: (key) => modern.deleteValue(key), log,
    }) : null;
  const seenJournal = context === 'normal' && typeof GM_listValues === 'function' && typeof modern?.setValue === 'function' && typeof modern?.deleteValue === 'function'
    ? createSeenJournal({
      get: (key, fallback) => GM_getValue(key, fallback), list: () => GM_listValues(),
      set: (key, value) => modern.setValue(key, value), remove: (key) => modern.deleteValue(key), log,
    }) : null;
  const activityRegister = context === 'normal' && typeof GM_listValues === 'function' && typeof modern?.setValue === 'function' && typeof modern?.deleteValue === 'function'
    ? createGmActivityRegister({
      get: (key, fallback) => GM_getValue(key, fallback), list: () => GM_listValues(),
      set: (key, value) => modern.setValue(key, value), remove: (key) => modern.deleteValue(key), log,
    }) : null;
  const reportConflict = (error) => {
    if (error.code !== 'ACTIVITY_REGISTER_CONFLICT') throw error;
    log?.error('Activity recovery has conflicting saved values. Try the recovery action again to choose this copy', error);
  };
  const storage = {
    kind: 'gm',
    activityContext: () => context,
    watchedSupported: Boolean(journal),
    seenSupported: Boolean(seenJournal),
    get(key, fallback) {
      if (activityRegister && gmActivityRegisterKey(key)) {
        try { return activityRegister.read(key, fallback); }
        catch (error) { reportConflict(error); return fallback; }
      }
      if (seenJournal && seenStorageKey(key)) return seenJournal.read(key).entries;
      const source = key.replace(/^seenPostsCleared@/, 'seenPosts@');
      if (seenJournal && source !== key && seenStorageKey(source)) return seenJournal.read(source).clearedAt;
      return journal && watchedStorageKey(key) ? journal.read(key, fallback) : GM_getValue(key, fallback);
    },
    // Only explicit legacy recovery may inspect the retained source when proposals conflict.
    getLegacyRecovery(key, fallback) {
      if (!activityRegister || !gmActivityRegisterKey(key) || key.includes('@')) return storage.get(key, fallback);
      try { return activityRegister.read(key, fallback); }
      catch (error) { reportConflict(error); return activityRegister.source(key, fallback); }
    },
    set: (key, value, options) => activityRegister && gmActivityRegisterKey(key) ? activityRegister.set(key, value, options) : GM_setValue(key, value),
    setConfirmed,
    eraseConfirmed: (key, options) => activityRegister && gmActivityRegisterKey(key) ? activityRegister.erase(key, options) : storage.remove(key, options),
    remove: (key, options) => activityRegister && gmActivityRegisterKey(key) ? activityRegister.remove(key, options)
      : typeof modern?.deleteValue === 'function' ? modern.deleteValue(key)
      : typeof GM_deleteValue === 'function' ? GM_deleteValue(key) : GM_setValue(key, undefined),
    onChange(key, listener) {
      if (activityRegister && gmActivityRegisterKey(key)) {
        const unsubscribe = activityRegister.subscribe(key, listener);
        if (typeof GM_addValueChangeListener === 'function') {
          for (const name of [key, gmActivityPulseKey(key)]) GM_addValueChangeListener(name, (_name, _old, _value, remote) => {
            if (!remote) return;
            try { activityRegister.refresh(key); }
            catch (error) { reportConflict(error); listener(undefined, { source: 'remote', conflict: true }); }
          });
        }
        return unsubscribe;
      }
      if (typeof GM_addValueChangeListener !== 'function') return;
      GM_addValueChangeListener(key, (_name, _old, value, remote) => {
        if (remote) listener(seenJournal && seenStorageKey(key) ? seenJournal.read(key).entries : value);
      });
      if (journal && watchedStorageKey(key)) GM_addValueChangeListener(`${key}#changed`, (_name, _old, _value, remote) => {
        if (remote) listener(journal.read(key, []));
      });
      const source = key.replace(/^seenPostsCleared@/, 'seenPosts@');
      if (seenJournal && seenStorageKey(source)) GM_addValueChangeListener(`${source}#seen-changed`, (_name, _old, _value, remote) => {
        if (remote) listener(source === key ? seenJournal.read(source).entries : seenJournal.read(source).clearedAt);
      });
    },
  };
  storage.mutate = (key, mutation, options = {}) => {
    if (seenStorageKey(key) && Object.hasOwn(mutation, 'seen')) {
      if (!seenJournal) throw new Error('This userscript manager cannot merge seen history across tabs');
      return seenJournal.mutate(key, mutation.seen, options.allowed);
    }
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
    activityContext: () => 'unknown',
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
    activityContext: () => 'normal',
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
