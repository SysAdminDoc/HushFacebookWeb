// Activity kept for each Facebook account, the way its settings are (settings.js): the posts
// you've scrolled past, video spots, the speed and volume you keep, and what you watched. Each of these keys gets
// the account's tag, or "signed-out" while nobody is, so what one account watched never shows
// up for another. A tag is base-36 digits only, so "signed-out" can't be one.
//
// The tag is taken once, when the page starts, since the stores read their lists then. Every
// read and write checks the account again, and so do page changes and coming back to the tab
// (watch): once this page is signed in to someone else (a switch here or in another tab),
// writes stop, reads come back empty, other tabs' changes are no longer passed on, a store that
// keeps a copy in memory drops it (onAccountChange) and onSwitch hears about it once. Nothing
// the page still holds reaches either account after that, and a reload starts over with the
// new one. A cookie that reads as signed out for a moment counts as a change too.
//
// Before this the lists were kept under the plain keys, shared by everyone on the browser.
// They stay there, tied to no account, until you add them to one or delete them in General.

import { accountTag } from './settings.js';
import { createMemoryStorage } from './storage.js';
import { CLEARED_KEY, MAX_AGE, MAX_ENTRIES, SEEN_KEY } from './seen-store.js';
import { seenTime } from './seen.js';

const SPEED_KEY = 'keepSpeed.rate';
const VOLUME_KEY = 'keepVolume.state';
const POSITIONS_KEY = 'resumeVideos.positions';
const WATCHED_KEY = 'rememberWatched.list'; // WATCHED_KEY in features/playback/remember-watched.js
const MAX_POSITIONS = 200; // MAX_KEPT in features/playback/resume-videos.js
const SIGNED_OUT = 'signed-out';

// The watched list came after accounts were kept apart, so it never has a shared copy to add.
export const ACTIVITY_KEYS = Object.freeze([SEEN_KEY, CLEARED_KEY, SPEED_KEY, VOLUME_KEY, POSITIONS_KEY, WATCHED_KEY]);
const ACTIVITY = new Set(ACTIVITY_KEYS);
export const ACCOUNT_CHANGED = 'The Facebook account on this page changed, so seen posts and video spots stop saving here until you reload';

export const isActivityKey = (key) => ACTIVITY.has(key);
export const activityKeyFor = (key, account) => `${key}@${account ? accountTag(account) : SIGNED_OUT}`;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isPromise = (value) => value && typeof value.then === 'function';
const stamp = seenTime;
const afterWrite = (write, done) => isPromise(write) ? write.then(done) : done();
function inOrder(entries, write) {
  const iterator = entries[Symbol.iterator]();
  const next = () => {
    for (let item = iterator.next(); !item.done; item = iterator.next()) {
      const saved = write(item.value);
      if (isPromise(saved)) return saved.then(next);
    }
  };
  return next();
}
const spotOf = (spot) => (
  isRecord(spot) && Number.isFinite(spot.t) && Number.isFinite(spot.d) && Number.isFinite(spot.at)
    ? { t: spot.t, d: spot.d, at: spot.at }
    : null
);

// Seen posts from both lists, each at the first time either list saw it. Entries from before
// a list was forgotten don't count, and past the store's limits the oldest go.
export function mergeSeen({ mine, mineCleared, theirs, theirsCleared, now }) {
  const merged = new Map();
  const cutoff = now - MAX_AGE;
  const add = (raw, cleared) => {
    if (!isRecord(raw)) return;
    for (const [id, at] of Object.entries(raw)) {
      if (!id || !Number.isFinite(at) || at <= 0 || at < cleared || at < cutoff) continue;
      const known = merged.get(id);
      if (known === undefined || at < known) merged.set(id, at);
    }
  };
  add(mine, stamp(mineCleared));
  add(theirs, Math.max(stamp(theirsCleared), stamp(mineCleared)));
  return Object.fromEntries([...merged].sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES));
}

// Video spots from both, the newer one where both have the same video.
export function mergePositions(mine, theirs) {
  const merged = new Map();
  for (const raw of [theirs, mine]) {
    if (!isRecord(raw)) continue;
    for (const [id, value] of Object.entries(raw)) {
      const spot = spotOf(value);
      if (!id || !spot) continue;
      if (!merged.has(id) || spot.at >= merged.get(id).at) merged.set(id, spot);
    }
  }
  return Object.fromEntries([...merged].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_POSITIONS));
}

export function createActivityStorage({ storage, account = null, currentAccount = () => account, onSwitch, log, now = Date.now }) {
  const keyOf = (key) => (ACTIVITY.has(key) ? activityKeyFor(key, account) : key);
  // The extension owns privacy routing in its isolated world. MAIN gets no private flag.
  const context = () => storage.kind === 'extension' ? 'managed' : storage.activityContext?.() ?? 'normal';
  const memoryOnly = () => storage.kind !== 'extension' && context() !== 'normal';
  const temporary = createMemoryStorage();
  const listeners = new Map(); // activity key -> this page's listeners, told about an import here
  const resets = []; // stores that keep a copy in memory, told to drop it on a switch
  let switched = false;
  let legacyClear = null; // One pre-clear snapshot and its unacknowledged deletions, across retries.

  // Whether the page is still signed in to the account it started with. The first time it
  // isn't, writes stop for good, stores drop what they hold and onSwitch hears about it.
  function check() {
    if (switched) return false;
    if ((currentAccount() ?? null) === (account ?? null)) return true;
    switched = true;
    log?.warn(ACCOUNT_CHANGED);
    for (const reset of resets) {
      try {
        reset();
      } catch (error) {
        log?.error("A store couldn't let go of the old account's activity", error);
      }
    }
    try {
      onSwitch?.();
    } catch (error) {
      log?.error("Couldn't say that the account changed", error);
    }
    return false;
  }

  const backendFor = (key) => ACTIVITY.has(key) && memoryOnly() ? temporary : storage;
  const read = (name) => (key, fallback) => {
    if (ACTIVITY.has(key) && !check()) return fallback;
    const backend = backendFor(key);
    return (backend[name] ?? backend.get)(keyOf(key), fallback);
  };
  // A refused write returns what the method would have, minus the effect.
  const write = (name, refused) => (key, ...rest) => {
    if (ACTIVITY.has(key) && !check()) return refused;
    const backend = backendFor(key);
    const method = backend[name] ?? (name === 'setConfirmed' ? backend.set : name === 'migrateDetailed' ? backend.mutateDetailed : backend.mutate);
    return method(keyOf(key), ...rest);
  };

  const scoped = {
    ...storage,
    get: read('get'),
    set: write('set'),
    remove: write('remove'),
    get watchedSupported() { return memoryOnly() ? true : storage.watchedSupported; },
    get seenSupported() { return memoryOnly() ? true : storage.seenSupported; },
    onChange(key, listener) {
      if (!ACTIVITY.has(key)) return storage.onChange?.(key, listener);
      listeners.set(key, [...(listeners.get(key) ?? []), listener]);
      if (memoryOnly() && context() !== 'loading') return;
      return storage.onChange?.(keyOf(key), (...args) => {
        if (!switched && !memoryOnly()) listener(...args);
      });
    },
    // For a store that keeps the list in memory: run once the page belongs to someone else.
    onAccountChange(reset) {
      if (switched) reset();
      else resets.push(reset);
    },
  };
  if (storage.getAtLoad) scoped.getAtLoad = read('getAtLoad');
  if (storage.setConfirmed) scoped.setConfirmed = write('setConfirmed');
  // Only the key is scoped, so these are for one key at a time.
  for (const name of ['mutate', 'mutateDetailed', 'migrate', 'migrateDetailed']) {
    if (storage[name]) scoped[name] = write(name, Promise.resolve(undefined));
  }
  if (storage.mutate) {
    const mutate = scoped.mutate;
    scoped.mutate = (key, mutation, options = {}) => {
      if (key !== WATCHED_KEY && key !== SEEN_KEY) return mutate(key, mutation, options);
      if (!check()) return Promise.reject(new Error(ACCOUNT_CHANGED));
      return backendFor(key).mutate(keyOf(key), mutation, { ...options, allowed: () => check() && options.allowed?.() !== false });
    };
  }

  // Page changes and coming back to the tab are when another account shows up.
  function watch({ router, doc }) {
    router?.subscribe?.(() => check());
    doc?.addEventListener?.('visibilitychange', () => {
      if (doc.visibilityState === 'visible') check();
    });
  }

  const shared = (key) => storage.get(key, undefined);
  const recoverable = (key) => {
    const current = shared(key);
    return current === undefined && legacyClear?.snapshot.has(key) ? legacyClear.snapshot.get(key) : current;
  };
  const own = (key) => storage.get(keyOf(key), undefined);
  const count = (value) => (isRecord(value) ? Object.keys(value).length : 0);

  // What the plain keys still hold from before accounts were kept apart, or null.
  function legacy() {
    if (memoryOnly() || !check()) return null;
    const from = Math.max(stamp(recoverable(CLEARED_KEY)), now() - MAX_AGE);
    const seen = Object.values(isRecord(recoverable(SEEN_KEY)) ? recoverable(SEEN_KEY) : {}).filter((at) => Number.isFinite(at) && at > 0 && at >= from).length;
    const found = {
      seen,
      spots: count(recoverable(POSITIONS_KEY)),
      speed: recoverable(SPEED_KEY) !== undefined,
      volume: recoverable(VOLUME_KEY) !== undefined,
    };
    return found.seen || found.spots || found.speed || found.volume ? found : null;
  }

  // Adds the shared lists to this account's, keeping its own speed and volume where it has
  // them. The shared copy stays until it's deleted, so another account can take it too.
  function addLegacy() {
    if (memoryOnly()) throw new Error('Legacy activity is unavailable in this tab');
    if (!check()) throw new Error(ACCOUNT_CHANGED);
    if (legacyClear) throw new Error("That deletion hasn't finished. Use Delete them to retry it");
    // The extension's copy fills in a moment after the page starts, and until then the
    // account's own speed and volume would read as missing.
    if (storage.status && storage.status().state !== 'ready') throw new Error("Saved activity hasn't loaded yet. Try again in a moment");
    const next = new Map();
    if (count(shared(SEEN_KEY))) {
      next.set(SEEN_KEY, mergeSeen({ mine: own(SEEN_KEY), mineCleared: own(CLEARED_KEY), theirs: shared(SEEN_KEY), theirsCleared: shared(CLEARED_KEY), now: now() }));
    }
    if (count(shared(POSITIONS_KEY))) next.set(POSITIONS_KEY, mergePositions(own(POSITIONS_KEY), shared(POSITIONS_KEY)));
    for (const key of [SPEED_KEY, VOLUME_KEY]) {
      if (shared(key) !== undefined && own(key) === undefined) next.set(key, shared(key));
    }
    const writes = inOrder(next, ([key, value]) => {
      if (!check()) throw new Error(ACCOUNT_CHANGED);
      const saved = key === SEEN_KEY && storage.seenSupported
        ? storage.mutate(keyOf(key), { seen: { add: value, at: now() } }, { allowed: check })
        : (storage.setConfirmed ?? storage.set)(keyOf(key), value);
      // A store in this page doesn't hear its own page's writes, so it's told here.
      const notify = () => {
        if (!check()) return;
        for (const listener of listeners.get(key) ?? []) {
          try {
            listener(structuredClone(value), { source: 'import' });
          } catch (error) {
            log?.error('A storage listener failed', error);
          }
        }
      };
      return afterWrite(saved, notify);
    });
    return afterWrite(writes, () => {
      if (!check()) throw new Error(ACCOUNT_CHANGED);
      return next.size;
    });
  }

  // Deletes the shared copy. The function it returns puts it back, for the toast's Undo.
  function clearLegacy() {
    const allowed = () => {
      if (memoryOnly()) throw new Error('Legacy activity is unavailable in this tab');
      if (!check()) throw new Error(ACCOUNT_CHANGED);
    };
    allowed();
    if (legacyClear?.active) return legacyClear.active;
    const operation = legacyClear ?? { snapshot: new Map(), pending: new Set(), active: null };
    legacyClear = operation;
    for (const key of ACTIVITY_KEYS) {
      const value = shared(key);
      if (value === undefined) continue;
      if (!operation.snapshot.has(key)) operation.snapshot.set(key, structuredClone(value));
      operation.pending.add(key);
    }
    const writes = inOrder([...operation.pending], (key) => {
      allowed();
      return afterWrite(storage.remove(key), () => operation.pending.delete(key));
    });
    let undoActive = null;
    const unconfirmed = new Set();
    const undo = () => {
      allowed();
      if (undoActive) return undoActive;
      const restored = afterWrite(inOrder(operation.snapshot, ([key, value]) => {
        allowed();
        const current = shared(key);
        if (current !== undefined && !(unconfirmed.has(key) && JSON.stringify(current) === JSON.stringify(value))) return;
        unconfirmed.add(key);
        return afterWrite((storage.setConfirmed ?? storage.set)(key, value), () => unconfirmed.delete(key));
      }), allowed);
      if (!isPromise(restored)) return undefined;
      undoActive = restored.finally(() => { undoActive = null; });
      return undoActive;
    };
    const done = () => {
      allowed();
      if (legacyClear === operation) legacyClear = null;
      return undo;
    };
    if (!isPromise(writes)) return done();
    operation.active = writes.then(done).finally(() => { operation.active = null; });
    return operation.active;
  }

  return {
    storage: scoped,
    check,
    watch,
    switched: () => switched,
    perAccount: Boolean(account),
    context,
    legacy,
    addLegacy,
    clearLegacy,
  };
}
