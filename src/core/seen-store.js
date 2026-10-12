// Posts you've scrolled past, by post id, with when you first saw each one. They're kept in
// the userscript manager's storage under their own key, beside the settings. Anything older
// than the longest choice (30 days) is dropped when the script starts and once a day after,
// and only the newest 5,000 are kept. Writes wait a few seconds so a quick scroll is one write.
// Another tab's writes are merged in as they happen. Forgetting the list writes the time it
// happened under a second key, so another tab's older copy can't bring the posts back.

export const SEEN_KEY = 'seenPosts';
export const CLEARED_KEY = 'seenPostsCleared';
const DAY = 24 * 60 * 60 * 1000;
const MAX_AGE = 30 * DAY;
const MAX_ENTRIES = 5000;
const SAVE_DELAY = 3000;

// Entries from before the list was last forgotten don't count.
function parse(raw, cleared = 0) {
  const entries = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return entries;
  for (const [id, at] of Object.entries(raw)) {
    if (id && Number.isFinite(at) && at > 0 && at >= cleared) entries.set(id, at);
  }
  return entries;
}

const clearedAt = (raw) => (Number.isFinite(raw) && raw > 0 ? raw : 0);

export function createSeenStore({
  storage, log, now = Date.now, maxAge = MAX_AGE, maxEntries = MAX_ENTRIES,
  schedule = setTimeout, cancel = clearTimeout, every = setInterval,
} = {}) {
  let entries = new Map();
  let cleared = 0;
  // The extension's storage fills a few milliseconds in, so the saved list joins whatever was
  // seen before then rather than the other way round.
  const read = () => {
    try {
      cleared = clearedAt(storage?.get(CLEARED_KEY, 0));
      for (const [id, at] of parse(storage?.get(SEEN_KEY, null), cleared)) if (!entries.has(id)) entries.set(id, at);
    } catch (error) {
      log?.error("Couldn't read the seen posts list, starting a new one", error);
    }
  };
  if (storage?.whenReady) storage.whenReady(read);
  else read();
  let timer = null;

  function save() {
    timer = null;
    try {
      storage?.set(SEEN_KEY, Object.fromEntries(entries));
    } catch (error) {
      log?.error("Couldn't save the seen posts list", error);
    }
  }

  function later() {
    if (timer === null) timer = schedule(save, SAVE_DELAY);
  }

  // Drops old entries, then the oldest beyond the cap. Returns how many went.
  function prune() {
    const before = entries.size;
    const cutoff = now() - maxAge;
    for (const [id, at] of entries) if (at < cutoff) entries.delete(id);
    if (entries.size > maxEntries) {
      const newest = [...entries].sort((a, b) => b[1] - a[1]).slice(0, maxEntries);
      entries = new Map(newest);
    }
    return before - entries.size;
  }

  if (prune()) later();
  const daily = every?.(() => {
    if (prune()) later();
  }, DAY);
  // In Node (the tests) a daily timer would keep the process alive.
  daily?.unref?.();

  storage?.onChange?.(SEEN_KEY, (raw) => {
    for (const [id, at] of parse(raw, cleared)) {
      const mine = entries.get(id);
      if (mine === undefined || at < mine) entries.set(id, at);
    }
  });
  // Another tab forgot the list.
  storage?.onChange?.(CLEARED_KEY, (raw) => {
    const at = clearedAt(raw);
    if (at <= cleared) return;
    cleared = at;
    for (const [id, seen] of entries) if (seen < cleared) entries.delete(id);
  });

  return {
    // Remembers ids not already known, keeping the first time each was seen.
    add(ids) {
      let added = false;
      for (const id of [ids].flat()) {
        if (!id || entries.has(id)) continue;
        entries.set(id, now());
        added = true;
      }
      if (added) {
        if (entries.size > maxEntries) prune();
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
    clear() {
      cleared = Math.max(now(), cleared);
      entries.clear();
      if (timer !== null) cancel(timer);
      try {
        storage?.set(CLEARED_KEY, cleared);
      } catch (error) {
        log?.error("Couldn't save when the seen posts list was forgotten", error);
      }
      save();
    },
    // Writes now instead of waiting, for when the page is going away.
    flush() {
      if (timer === null) return;
      cancel(timer);
      save();
    },
  };
}
