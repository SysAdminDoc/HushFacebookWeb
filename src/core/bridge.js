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
// Taken when the bundle loads, before the script's own JSON.parse hook or Facebook's code.
const { stringify } = JSON;

export function connectBridge({ doc = globalThis.document, win = globalThis, secret = win.crypto.randomUUID() } = {}) {
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

  listen.call(doc, toMain, (event) => {
    let message;
    try {
      message = parse(event.detail);
    } catch {
      return;
    }
    if (message?.ready) {
      ready = true;
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
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('the extension did not answer'));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        say(toIsolated, stringify({ id, type, payload }));
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
  const written = new Set();
  const listeners = new Map();
  const waiting = [];
  let loaded = false;
  const copy = (value) => (value === undefined ? undefined : structuredClone(value));
  const same = (a, b) => stringify(a) === stringify(b);
  const tell = (key, value) => {
    for (const listener of listeners.get(key) ?? []) {
      try {
        listener(copy(value));
      } catch (error) {
        log?.error('A storage listener failed', error);
      }
    }
  };
  const finish = () => {
    loaded = true;
    for (const run of waiting.splice(0)) run();
  };

  bridge.request('storage:load').then((saved) => {
    for (const [key, value] of Object.entries(saved ?? {})) {
      if (written.has(key) || same(data.get(key), value)) continue;
      data.set(key, value);
      tell(key, value);
    }
    finish();
  }, (error) => {
    log?.error("The extension's saved settings couldn't be read, so defaults are in use", error);
    finish();
  });
  bridge.on('storage', (changes) => {
    for (const [key, value] of Object.entries(changes ?? {})) {
      // This tab's own writes come back too, already in the copy.
      if (same(data.get(key), value)) continue;
      if (value === undefined || value === null) data.delete(key);
      else data.set(key, value);
      tell(key, value ?? undefined);
    }
  });

  const save = (type, payload) => bridge.request(type, payload).catch((error) => log?.error("A setting couldn't be saved in the extension", error));

  return {
    kind: 'extension',
    get: (key, fallback) => (data.has(key) ? copy(data.get(key)) : fallback),
    set(key, value) {
      const stored = copy(value);
      written.add(key);
      if (stored === undefined) data.delete(key);
      else data.set(key, stored);
      save('storage:set', { key, value: stored ?? null });
    },
    remove(key) {
      written.add(key);
      data.delete(key);
      save('storage:remove', { key });
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
