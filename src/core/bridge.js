// The page half of the browser extension's bridge. The script runs in Facebook's page, where
// chrome.storage and chrome.downloads don't exist, so it asks the extension's isolated content
// script (extension/isolated.js) over DOM events on the document.
//
// Facebook's code shares that document, so the event names carry a secret. This half makes it
// before any of Facebook's scripts run and hands it over in the same moment: the isolated half
// listens for HELLO_MAIN, or, when it starts second, says HELLO_ISOLATED and gets the hello once.
// Its "ready" on the secret channel closes the door, so a page script saying hello later learns
// nothing. Details are JSON strings, since objects don't cross between the two worlds, and the
// DOM functions used are taken before Facebook can wrap them.

export const HELLO_MAIN = 'hushfacebook-web:hello-main';
export const HELLO_ISOLATED = 'hushfacebook-web:hello-isolated';
export const channelNames = (secret) => ({ toIsolated: `hushfacebook-web:${secret}:in`, toMain: `hushfacebook-web:${secret}:out` });

const TIMEOUT = 15000;
const MAX_PENDING = 64;
// Taken when the bundle loads, before the script's own JSON.parse hook or Facebook's code.
const { stringify } = JSON;

export function connectBridge({ doc = globalThis.document, win = globalThis, secret = win.crypto.randomUUID(), maxPending = MAX_PENDING } = {}) {
  const { toIsolated, toMain } = channelNames(secret);
  const Custom = win.CustomEvent;
  const dispatch = win.EventTarget.prototype.dispatchEvent;
  const listen = win.EventTarget.prototype.addEventListener;
  const parse = win.JSON.parse;
  const pending = new Map();
  const pushes = new Map();
  let nextId = 0;
  let ready = false;

  const say = (type, detail) => dispatch.call(doc, new Custom(type, { detail }));
  const send = (waiting) => {
    if (waiting.sent) return;
    waiting.sent = true;
    try {
      say(toIsolated, waiting.message);
    } catch (error) {
      pending.delete(waiting.id);
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
  };

  listen.call(doc, toMain, (event) => {
    let message;
    try {
      message = parse(event.detail);
    } catch {
      return;
    }
    if (message?.ready) {
      if (ready) return;
      ready = true;
      for (const waiting of pending.values()) send(waiting);
      return;
    }
    if (message?.id !== undefined) {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.ok) waiting.resolve(message.result);
      else waiting.reject(new Error(message.error || 'the extension could not do it'));
      return;
    }
    for (const listener of pushes.get(message?.push) ?? []) {
      try {
        listener(message.data);
      } catch {
        // One listener failing leaves the others.
      }
    }
  });
  listen.call(doc, HELLO_ISOLATED, () => {
    if (!ready) say(HELLO_MAIN, secret);
  });
  say(HELLO_MAIN, secret);

  return {
    connected: () => ready,
    // Resolves with the isolated half's answer, or rejects with its error.
    request(type, payload, { timeout = TIMEOUT } = {}) {
      if (pending.size >= maxPending) return Promise.reject(new Error('too many extension requests are waiting'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('the extension did not answer'));
        }, timeout);
        const waiting = { id, resolve, reject, timer, sent: false, message: stringify({ id, type, payload }) };
        pending.set(id, waiting);
        if (ready) send(waiting);
      });
    },
    // Messages the extension sends on its own: 'storage' (changes from other tabs), 'open-settings'.
    on(push, listener) {
      pushes.set(push, [...(pushes.get(push) ?? []), listener]);
    },
  };
}

// Storage over the bridge, shaped like createGmStorage's. Reads come from a copy in memory, so
// they stay synchronous. The copy starts empty (every setting at its default) and fills from
// chrome.storage a few milliseconds after the page starts; each saved key then reaches its
// onChange listeners the way a change from another tab does, and whenReady callbacks run. A key
// written before that keeps the newer value.
export function createBridgeStorage(bridge, { log } = {}) {
  const data = new Map();
  const pageLoadData = new Map();
  const written = new Set();
  const queuedWrites = new Map();
  const remoteChanges = new Map();
  const listeners = new Map();
  const statusListeners = new Set();
  const waiting = [];
  let loaded = false;
  let finishing = false;
  let revision = 0;
  let state = 'loading';
  let lastError = null;
  let loadPromise = null;
  const copy = (value) => (value === undefined ? undefined : structuredClone(value));
  const same = (a, b) => stringify(a) === stringify(b);
  const tell = (key, value, source = 'remote') => {
    for (const listener of listeners.get(key) ?? []) {
      try {
        listener(copy(value), { source });
      } catch (error) {
        log?.error('A storage listener failed', error);
      }
    }
  };
  const status = () => ({ state, error: lastError });
  const tellStatus = (listener) => {
    try {
      listener(status());
    } catch (error) {
      log?.error('A storage status listener failed', error);
    }
  };
  const setStatus = (next, error = null) => {
    state = next;
    lastError = error;
    for (const listener of statusListeners) tellStatus(listener);
  };
  const finish = () => {
    loaded = true;
    finishing = true;
    for (const run of waiting.splice(0)) {
      try {
        run();
      } catch (error) {
        log?.error('A storage ready listener failed', error);
      }
    }
    finishing = false;
    for (const { type, payload } of queuedWrites.values()) save(type, payload);
    queuedWrites.clear();
    written.clear();
    setStatus('ready');
  };
  const load = () => {
    if (state === 'ready') return Promise.resolve(true);
    if (loadPromise && state === 'loading') return loadPromise;
    const startedAt = revision;
    setStatus('loading');
    loadPromise = bridge.request('storage:load').then((saved) => {
      const snapshot = new Map(Object.entries(saved ?? {}));
      pageLoadData.clear();
      for (const [key, value] of snapshot) pageLoadData.set(key, copy(value));
      for (const [key, change] of remoteChanges) {
        if (change.revision > startedAt) pageLoadData.set(key, copy(change.value));
      }

      for (const key of data.keys()) {
        if (snapshot.has(key) || written.has(key) || (remoteChanges.get(key)?.revision ?? 0) > startedAt) continue;
        data.delete(key);
        tell(key, undefined, 'load');
      }
      for (const [key, value] of snapshot) {
        if (written.has(key) || (remoteChanges.get(key)?.revision ?? 0) > startedAt || same(data.get(key), value)) continue;
        data.set(key, copy(value));
        tell(key, value, 'load');
      }
      finish();
      return true;
    }, (error) => {
      log?.error("The extension's saved settings couldn't be read", error);
      setStatus('error', error);
      return false;
    });
    return loadPromise;
  };
  bridge.on('storage', (changes) => {
    for (const [key, value] of Object.entries(changes ?? {})) {
      const next = value === undefined || value === null ? undefined : copy(value);
      // This tab's own writes come back too, already in the copy.
      const ownEcho = written.has(key) && same(data.get(key), next);
      if (!loaded && !ownEcho) {
        remoteChanges.set(key, { revision: ++revision, value: next });
        queuedWrites.delete(key);
        written.delete(key);
      }
      if (same(data.get(key), next)) continue;
      if (next === undefined) data.delete(key);
      else data.set(key, next);
      tell(key, next);
    }
  });

  void load();

  const save = (type, payload) => bridge.request(type, payload).catch((error) => log?.error("A setting couldn't be saved in the extension", error));
  const persist = (key, type, payload) => {
    if (!loaded || finishing) queuedWrites.set(key, { type, payload });
    else save(type, payload);
  };

  return {
    kind: 'extension',
    get: (key, fallback) => (data.has(key) ? copy(data.get(key)) : fallback),
    getAtLoad: (key, fallback) => (pageLoadData.has(key) ? copy(pageLoadData.get(key)) : fallback),
    status,
    onStatus(listener) {
      statusListeners.add(listener);
      tellStatus(listener);
      return () => statusListeners.delete(listener);
    },
    retry: load,
    set(key, value) {
      const stored = copy(value);
      written.add(key);
      if (stored === undefined) data.delete(key);
      else data.set(key, stored);
      persist(key, 'storage:set', { key, value: stored ?? null });
    },
    remove(key) {
      written.add(key);
      data.delete(key);
      persist(key, 'storage:remove', { key });
    },
    onChange(key, listener) {
      listeners.set(key, [...(listeners.get(key) ?? []), listener]);
    },
    whenReady(run) {
      if (loaded) run();
      else waiting.push(run);
    },
  };
}

// GM_download's shape, through chrome.downloads in the extension's background.
export const bridgeDownload = (bridge) => ({ url, name, timeout, onload, onerror, ontimeout }) => {
  bridge.request('download', { url, name }, { timeout: timeout ?? 600000 }).then(
    () => onload?.(),
    (error) => (/did not answer/.test(error.message) ? ontimeout?.() : onerror?.({ error: error.message })),
  );
};
