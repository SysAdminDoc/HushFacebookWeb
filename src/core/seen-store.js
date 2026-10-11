// Posts you've scrolled past, by post id, with when you first saw each one. They're kept in
// the userscript manager's storage under their own key, beside the settings. Anything older
// than the longest choice (30 days) is dropped when the script starts and once a day after,
// and only the newest 5,000 are kept. Writes wait a few seconds so a quick scroll is one write.
// Another tab's writes are merged in as they happen.

export const SEEN_KEY = 'seenPosts';
const DAY = 24 * 60 * 60 * 1000;
const MAX_AGE = 30 * DAY;
const MAX_ENTRIES = 5000;
const SAVE_DELAY = 3000;

function parse(raw) {
  const entries = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return entries;
  for (const [id, at] of Object.entries(raw)) {
    if (id && Number.isFinite(at) && at > 0) entries.set(id, at);
  }
  return entries;
}

export function createSeenStore({
  storage, log, now = Date.now, maxAge = MAX_AGE, maxEntries = MAX_ENTRIES,
  schedule = setTimeout, cancel = clearTimeout, every = setInterval,
} = {}) {
  let entries = new Map();
  try {
    entries = parse(storage?.get(SEEN_KEY, null));
  } catch (error) {
    log?.error("Couldn't read the seen posts list, starting a new one", error);
  }
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
    for (const [id, at] of parse(raw)) {
      const mine = entries.get(id);
      if (mine === undefined || at < mine) entries.set(id, at);
    }
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
    // The ids first seen at or after since (ms).
    since(since) {
      const ids = new Set();
      for (const [id, at] of entries) if (at >= since) ids.add(id);
      return ids;
    },
    has: (id) => entries.has(id),
    size: () => entries.size,
    clear() {
      entries.clear();
      if (timer !== null) cancel(timer);
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
