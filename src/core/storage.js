// Storage adapters. Settings code only sees { get, set, remove, onChange }.
//
// GM_getValue is synchronous in Tampermonkey and Violentmonkey, which matters at
// document-start: hooks need the saved settings before Facebook sends its first request.

export function createGmStorage() {
  if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') {
    return createLocalStorage();
  }
  return {
    kind: 'gm',
    get: (key, fallback) => GM_getValue(key, fallback),
    set: (key, value) => GM_setValue(key, value),
    remove: (key) => (typeof GM_deleteValue === 'function' ? GM_deleteValue(key) : GM_setValue(key, undefined)),
    onChange(key, listener) {
      if (typeof GM_addValueChangeListener !== 'function') return;
      GM_addValueChangeListener(key, (_name, _old, value, remote) => {
        if (remote) listener(value);
      });
    },
  };
}

// Fallback for managers without GM storage. Facebook can read this, so it's a last resort.
function createLocalStorage(prefix = 'hfw:') {
  return {
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
}

export function createMemoryStorage(initial = {}) {
  const data = new Map(Object.entries(structuredClone(initial)));
  return {
    kind: 'memory',
    get: (key, fallback) => (data.has(key) ? structuredClone(data.get(key)) : fallback),
    set: (key, value) => void data.set(key, structuredClone(value)),
    remove: (key) => void data.delete(key),
    onChange() {},
    dump: () => Object.fromEntries(data),
  };
}
