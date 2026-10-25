// Posts you've scrolled past, by post id, with when you first saw each one. They're kept in
// the userscript manager's storage under their own key, beside the settings. Anything older
// than the longest choice (30 days) is dropped, and only the newest 5,000 are kept, whenever
// the saved list loads or another tab's arrives, and once a day. Writes wait a few seconds so
// a quick scroll is one write. Another tab's writes are merged in as they happen. Forgetting
// the list writes the time it happened under a second key, so another tab's older copy can't
// bring the posts back.

import { SEEN_KEY, CLEARED_KEY, MAX_AGE, MAX_ENTRIES, seenBarrier, seenTime } from './seen.js';
export { SEEN_KEY, CLEARED_KEY, MAX_AGE, MAX_ENTRIES };
const DAY = 24 * 60 * 60 * 1000;
const SAVE_DELAY = 3000;

// Entries from before the list was last forgotten don't count.
function parse(raw, cleared = 0, strict = false) {
  const entries = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return entries;
  for (const [id, at] of Object.entries(raw)) {
    if (id && Number.isFinite(at) && at > 0 && (strict ? at > cleared : at >= cleared)) entries.set(id, at);
  }
  return entries;
}

const clearedAt = seenTime;

export function createSeenStore({
  storage, log, now = Date.now, maxAge = MAX_AGE, maxEntries = MAX_ENTRIES,
  schedule = setTimeout, cancel = clearTimeout, every = setInterval, uuid = () => crypto.randomUUID(),
} = {}) {
  let entries = new Map();
  let cleared = 0;
  let clearTokens = [];
  let timer = null;
  let ready = !storage?.whenReady;
  let savedBeforeReady = false;
  const atomic = storage?.seenSupported === true;
  const unsupported = storage?.seenSupported === false;
  let inactive = false;
  let pending = new Map();
  let pendingClear = null;
  let pruning = false;
  let running = null;
  let failed = null;
  const statusListeners = [];
  const statusChanged = () => tell(statusListeners, 'status');
  const waiting = [];
  const dropListeners = [];
  const tell = (listeners, what) => {
    for (const run of listeners) {
      try {
        run();
      } catch (error) {
        log?.error(`A seen-post ${what} listener failed`, error);
      }
    }
  };
  // The extension's storage fills a few milliseconds in, so the saved list joins whatever was
  // seen before then rather than the other way round.
  const read = () => {
    let trimmed = false;
    try {
      const get = storage?.getAtLoad ? storage.getAtLoad.bind(storage) : storage?.get?.bind(storage);
      cleared = Math.max(cleared, clearedAt(get?.(CLEARED_KEY, 0)));
      clearTokens = seenBarrier(get?.(CLEARED_KEY, 0)).tokens;
      trimmed = merge(parse(get?.(SEEN_KEY, null), cleared, atomic && !clearTokens.length));
    } catch (error) {
      log?.error("Couldn't read the seen posts list, starting a new one", error);
    }
    ready = true;
    if (atomic) void drain()?.catch?.(() => {});
    if (savedBeforeReady) {
      savedBeforeReady = false;
      save();
    } else if (trimmed) later();
    tell(waiting.splice(0), 'ready');
  };

  // Joins a saved list into this one, keeping the first time each post was seen, then keeps to
  // the limits. True when that left out some of the saved list, so storage should get the
  // trimmed one. A tab that receives a list already within the limits writes nothing back, so
  // two tabs settle on the same list instead of answering each other.
  function merge(saved) {
    for (const [id, at] of saved) {
      const mine = entries.get(id);
      if (mine === undefined || at < mine) entries.set(id, at);
    }
    prune();
    for (const id of saved.keys()) if (!entries.has(id)) return true;
    return false;
  }

  function save() {
    timer = null;
    if (inactive) return;
    if (atomic) return drain();
    if (!ready) savedBeforeReady = true;
    try {
      storage?.set(SEEN_KEY, Object.fromEntries(entries));
    } catch (error) {
      log?.error("Couldn't save the seen posts list", error);
    }
  }

  function drain() {
    if (running) return running;
    if (inactive || !ready) return;
    if (!pendingClear && !pending.size && !pruning) return;
    const clear = pendingClear;
    const additions = clear ? new Map() : pending;
    if (!clear) pending = new Map();
    pendingClear = null;
    pruning = false;
    const operation = clear ? { clear: clear.at, token: clear.token, at: Math.max(now(), clear.at) } : { add: Object.fromEntries(additions), after: clearTokens, at: Math.max(now(), cleared) };
    const success = (value) => {
      if (inactive) return;
      const marker = seenBarrier(storage.get(CLEARED_KEY, 0));
      if (marker.at > cleared || marker.at === cleared && marker.tokens.some((token) => !clearTokens.includes(token))) {
        cleared = marker.at;
        clearTokens = marker.tokens;
        for (const [id, at] of entries) if (at <= cleared && !(id in (value ?? {}))) entries.delete(id);
        for (const [id, at] of pending) if (at <= cleared) pending.delete(id);
        tell(dropListeners, 'drop');
      }
      if (marker.at === cleared && !pendingClear) clearTokens = marker.tokens;
      merge(parse(value, cleared, !clearTokens.length));
      failed = null;
      statusChanged();
    };
    const failure = (error) => {
      if (inactive) throw error;
      if (clear && !pendingClear) pendingClear = clear;
      if (!clear && !additions.size) pruning = true;
      for (const [id, at] of additions) {
        if (at < cleared || !entries.has(id)) continue;
        pending.set(id, Math.min(pending.get(id) ?? Infinity, at));
      }
      failed = error;
      log?.error("Couldn't save the seen posts list", error);
      statusChanged();
      throw error;
    };
    running = Promise.resolve().then(() => {
      if (inactive) throw new Error('The Facebook account changed');
      return storage.mutate(SEEN_KEY, { seen: operation });
    }).then(success, failure).finally(() => {
        running = null;
        if (!failed && !inactive) return drain();
      });
      // Pagehide and earlier callers may ignore flush; recovery is still exposed by status.
      void running.catch(() => {});
      statusChanged();
      return running;
  }

  if (storage?.whenReady) storage.whenReady(read);
  else read();

  function later() {
    if (timer === null) timer = schedule(save, SAVE_DELAY);
  }

  // Drops old entries, then the oldest beyond the cap. Returns how many went.
  function prune() {
    const before = entries.size;
    const cutoff = now() - maxAge;
    for (const [id, at] of entries) if (at < cutoff) entries.delete(id);
    if (entries.size > maxEntries) {
      const newest = [...entries].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, maxEntries);
      entries = new Map(newest);
    }
    const removed = before - entries.size;
    if (atomic && removed) pruning = true;
    return removed;
  }

  const daily = every?.(() => {
    if (prune()) later();
  }, DAY);
  // In Node (the tests) a daily timer would keep the process alive.
  daily?.unref?.();

  storage?.onChange?.(SEEN_KEY, (raw) => {
    if (merge(parse(raw, cleared, atomic && !clearTokens.length))) later();
  });
  // Another tab forgot the list.
  storage?.onChange?.(CLEARED_KEY, (raw) => {
    const at = clearedAt(raw);
    const marker = seenBarrier(raw);
    if (at < cleared || at === cleared && !marker.tokens.some((token) => !clearTokens.includes(token))) return;
    cleared = at;
    clearTokens = marker.tokens;
    const accepted = atomic ? storage.get(SEEN_KEY, {}) : {};
    for (const [id, seen] of entries) if (atomic ? seen < cleared || seen === cleared && !(id in accepted) : seen < cleared) entries.delete(id);
    if (atomic) for (const [id, seen] of pending) if (seen <= cleared) pending.delete(id);
    tell(dropListeners, 'drop');
  });
  // The page is signed in to someone else now (core/activity.js), and this list was the old account's.
  storage?.onAccountChange?.(() => {
    entries.clear();
    if (timer !== null) cancel(timer);
    timer = null;
    savedBeforeReady = false;
    inactive = true;
    pending.clear();
    pendingClear = null;
    failed = null;
    tell(dropListeners, 'drop');
  });

  return {
    // Remembers ids not already known, keeping the first time each was seen.
    add(ids) {
      if (inactive || unsupported) return false;
      let added = false;
      for (const id of [ids].flat()) {
        if (!id || entries.has(id)) continue;
        const at = atomic ? Math.max(now(), cleared) : now();
        entries.set(id, at);
        if (atomic) pending.set(id, at);
        added = true;
      }
      if (added) {
        if (entries.size > maxEntries) prune();
        if (atomic) for (const id of pending.keys()) if (!entries.has(id)) pending.delete(id);
        later();
      }
      return added;
    },
    // The ids first seen at or after from (ms), and before until.
    since(from, until = Infinity) {
      const ids = new Set();
      for (const [id, at] of entries) if (at >= from && at < until) ids.add(id);
      return ids;
    },
    has: (id) => entries.has(id),
    size: () => entries.size,
    whenReady(run) {
      if (ready) run();
      else waiting.push(run);
    },
    // Runs when posts leave the list without this tab asking: another tab forgot it, or the
    // page changed accounts.
    onDrop: (run) => dropListeners.push(run),
    clear() {
      if (inactive) return Promise.reject(new Error('The Facebook account changed'));
      if (unsupported) return Promise.reject(new Error('This userscript manager cannot merge seen history across tabs'));
      const previousClear = cleared;
      cleared = Math.max(now(), cleared, ...(atomic ? [...entries.values()] : []));
      entries.clear();
      if (timer !== null) cancel(timer);
      if (atomic) {
        pending.clear();
        const token = uuid();
        clearTokens = cleared > previousClear ? [token] : [...new Set([...clearTokens, token])];
        pendingClear = { at: cleared, token };
        failed = null;
        return save();
      }
      try {
        storage?.set(CLEARED_KEY, cleared);
      } catch (error) {
        log?.error("Couldn't save when the seen posts list was forgotten", error);
      }
      save();
    },
    // Writes now instead of waiting, for when the page is going away.
    flush() {
      if (timer === null && !atomic) return;
      if (timer !== null) cancel(timer);
      return save();
    },
    retry() { if (inactive) return Promise.reject(new Error('The Facebook account changed')); if (unsupported) return Promise.reject(new Error('This userscript manager cannot merge seen history across tabs')); failed = null; return drain(); },
    failed: () => Boolean(failed || unsupported),
    saving: () => Boolean(running || pendingClear || pending.size),
    onStatus: (run) => statusListeners.push(run),
  };
}
