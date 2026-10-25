// The page half of the browser extension's bridge. The script runs in Facebook's page, where
// chrome.storage and chrome.downloads don't exist, so it asks the extension's isolated content
// script (extension/isolated.js) over DOM events on the document.
//
// Facebook's code shares that document, so a random event name keeps ordinary page traffic out
// of the way. It is routing, not authentication: MAIN runs in the page's world, and the page can
// observe or forge every DOM event it uses. The isolated half therefore treats every request as
// untrusted and grants only the current document's bounded capabilities. Details are JSON strings,
// since objects don't cross between the two worlds, and the DOM functions used are taken before
// Facebook can wrap them.

export const HELLO_MAIN = 'hushfacebook-web:hello-main';
export const HELLO_ISOLATED = 'hushfacebook-web:hello-isolated';
export const STORAGE_REVISIONS_KEY = 'hushfacebookWeb.storageRevisions';
export const STORAGE_REVISION_EPOCH_KEY = '__epoch';
export const STORAGE_REVISION_ORDER_KEY = '__order';
export const validStorageRevisions = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const epoch = value[STORAGE_REVISION_EPOCH_KEY];
  const order = value[STORAGE_REVISION_ORDER_KEY];
  if (typeof epoch !== 'string' || !epoch || !Number.isSafeInteger(order) || order < 0) return false;
  return Object.entries(value).every(([key, revision]) => (
    key === STORAGE_REVISION_EPOCH_KEY
      ? typeof revision === 'string' && revision.length > 0
      : key === STORAGE_REVISION_ORDER_KEY
        ? Number.isSafeInteger(revision) && revision >= 0
        : Number.isSafeInteger(revision) && revision >= 0 && revision <= order
  ));
};
export const storageRevisionEpoch = (value) => (
  validStorageRevisions(value) && typeof value[STORAGE_REVISION_EPOCH_KEY] === 'string'
    ? value[STORAGE_REVISION_EPOCH_KEY]
    : null
);
export const channelNames = (secret) => ({ toIsolated: `hushfacebook-web:${secret}:in`, toMain: `hushfacebook-web:${secret}:out` });

const TIMEOUT = 15000;
export const BRIDGE_MAX_PENDING = 64;
export const BRIDGE_MAX_MESSAGE_BYTES = 1536 * 1024;
export const BRIDGE_MAX_VALUE_BYTES = 1024 * 1024;
export const BRIDGE_RATE_WINDOW = 10000;
export const BRIDGE_MAX_REQUESTS_PER_WINDOW = 120;
// Remembered volume writes on every volumechange, so a slider drag runs near 60 a second.
export const BRIDGE_MAX_WRITES_PER_WINDOW = 600;
export const BRIDGE_MAX_DOWNLOADS_PER_WINDOW = 8;
// A page's name for one of its downloads (a UUID). The background keeps the same pattern.
export const BRIDGE_DOWNLOAD_KEY = /^[A-Za-z0-9-]{8,64}$/;
// The browser takes a download once the server starts answering, which a slow one can delay.
const DOWNLOAD_ANSWER_WITHIN = 60000;
// Taken when the bundle loads, before the script's own JSON.parse hook or Facebook's code.
const { stringify } = JSON;
const Encoder = TextEncoder;
const serializedBytes = (text) => {
  if (text.length > BRIDGE_MAX_MESSAGE_BYTES) return BRIDGE_MAX_MESSAGE_BYTES + 1;
  return new Encoder().encode(text).byteLength;
};

export function connectBridge({
  doc = globalThis.document,
  win = globalThis,
  secret = win.crypto.randomUUID(),
  maxPending = BRIDGE_MAX_PENDING,
  maxMessageBytes = BRIDGE_MAX_MESSAGE_BYTES,
} = {}) {
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
        listener(message.data, message.meta);
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
    activityContext: () => 'managed',
    // Resolves with the isolated half's answer, or rejects with its error.
    request(type, payload, { timeout = TIMEOUT } = {}) {
      if (pending.size >= maxPending) return Promise.reject(new Error('too many extension requests are waiting'));
      const id = nextId++;
      let message;
      try {
        message = stringify({ id, type, payload });
      } catch {
        return Promise.reject(new Error('the extension request could not be encoded'));
      }
      if (message.length > maxMessageBytes || serializedBytes(message) > maxMessageBytes) {
        return Promise.reject(new Error('the extension request is too large'));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('the extension did not answer'));
        }, timeout);
        const waiting = { id, resolve, reject, timer, sent: false, message };
        pending.set(id, waiting);
        if (ready) send(waiting);
      });
    },
    // Messages the extension sends on its own: 'storage' (changes from other tabs), 'open-settings'.
    on(push, listener) {
      pushes.set(push, [...(pushes.get(push) ?? []), listener]);
      return () => pushes.set(push, (pushes.get(push) ?? []).filter((entry) => entry !== listener));
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
  const confirmedWrites = new Map();
  const directVersions = new Map();
  const keyEvents = new Map();
  const remoteChanges = new Map();
  const keyVersions = new Map();
  const acceptedRevisions = new Map();
  const appliedRevisions = new Map();
  const retiredStorageEpochs = new Set();
  const latestMutation = new Map();
  const listeners = new Map();
  const statusListeners = new Set();
  const waiting = [];
  let loaded = false;
  let finishing = false;
  let revision = 0;
  let state = 'loading';
  let lastError = null;
  let loadPromise = null;
  let nextMutation = 0;
  let revisionEpoch = 0;
  let storageEpoch = null;
  let loadPending = false;
  let storageFailureRevision = 0;
  let writeRetry = null;
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
    for (const { type, payload, confirmed } of queuedWrites.values()) save(type, payload, confirmed);
    queuedWrites.clear();
    written.clear();
    if ([...confirmedWrites.values()].some((operation) => operation.failed)) setStatus('error', lastError);
    else setStatus('ready');
  };
  const load = () => {
    if (state === 'ready') return Promise.resolve(true);
    if (loadPromise && loadPending) return loadPromise;
    const recovering = loaded && state === 'error';
    const startedAt = revision;
    const startedEpoch = revisionEpoch;
    const startedFailureRevision = storageFailureRevision;
    loadPending = true;
    setStatus('loading');
    loadPromise = bridge.request('storage:load').then((saved) => {
      if (storageFailureRevision !== startedFailureRevision) return false;
      const stored = { ...(saved ?? {}) };
      const savedRevisions = stored[STORAGE_REVISIONS_KEY];
      const savedRevisionsValid = validStorageRevisions(savedRevisions);
      const savedStorageEpoch = storageRevisionEpoch(savedRevisions);
      const uncontested = revisionEpoch === startedEpoch && revision === startedAt;
      delete stored[STORAGE_REVISIONS_KEY];
      if (uncontested && recovering && savedRevisionsValid && savedStorageEpoch) {
        if (storageEpoch && storageEpoch !== savedStorageEpoch) retiredStorageEpochs.add(storageEpoch);
        retiredStorageEpochs.delete(savedStorageEpoch);
        acceptedRevisions.clear();
        appliedRevisions.clear();
        revisionEpoch++;
        storageEpoch = savedStorageEpoch;
      }
      if (
        uncontested
        && savedRevisionsValid
        && (!storageEpoch || !savedStorageEpoch || storageEpoch === savedStorageEpoch)
      ) {
        if (savedStorageEpoch) storageEpoch = savedStorageEpoch;
        for (const [key, value] of Object.entries(savedRevisions)) {
          if (key === STORAGE_REVISION_EPOCH_KEY || key === STORAGE_REVISION_ORDER_KEY) continue;
          if (Number.isSafeInteger(value) && value >= 0) {
            acceptedRevisions.set(key, Math.max(acceptedRevisions.get(key) ?? 0, value));
          }
        }
      }
      const snapshot = new Map(Object.entries(stored));
      const savedRevisionFor = (key) => (savedRevisionsValid && Number.isSafeInteger(savedRevisions[key]) ? savedRevisions[key] : null);
      const newerRemote = (key) => {
        const change = remoteChanges.get(key);
        if (!change || change.revision <= startedAt || change.epoch !== revisionEpoch) return false;
        if (revisionEpoch !== startedEpoch) return true;
        const savedRevision = savedRevisionFor(key);
        if (Number.isSafeInteger(change.storageRevision)) {
          return savedRevision === null || change.storageRevision > savedRevision;
        }
        if (Number.isSafeInteger(change.barrier) && savedRevision !== null) return change.barrier >= savedRevision;
        return true;
      };
      pageLoadData.clear();
      for (const [key, value] of snapshot) pageLoadData.set(key, copy(value));
      for (const [key, change] of remoteChanges) {
        if (newerRemote(key)) pageLoadData.set(key, copy(change.value));
      }

      for (const key of data.keys()) {
        if (snapshot.has(key) || written.has(key) || newerRemote(key)) continue;
        data.delete(key);
        tell(key, undefined, 'load');
      }
      for (const [key, value] of snapshot) {
        if (written.has(key) || newerRemote(key) || same(data.get(key), value)) continue;
        data.set(key, copy(value));
        tell(key, value, 'load');
      }
      if (savedRevisionsValid && savedStorageEpoch === storageEpoch) {
        for (const key of snapshot.keys()) {
          if (written.has(key) || newerRemote(key)) continue;
          const savedRevision = savedRevisionFor(key);
          if (savedRevision !== null) appliedRevisions.set(key, savedRevision);
        }
      } else if (revisionEpoch !== startedEpoch) {
        for (const key of snapshot.keys()) {
          if (written.has(key) || newerRemote(key)) continue;
          const accepted = acceptedRevisions.get(key);
          if (Number.isSafeInteger(accepted)) appliedRevisions.set(key, accepted);
        }
      }
      finish();
      return true;
    }, (error) => {
      log?.error("The extension's saved settings couldn't be read", error);
      setStatus('error', error);
      return false;
    }).finally(() => { loadPending = false; });
    return loadPromise;
  };
  bridge.on('storage', (changes, meta) => {
    if (meta && Object.hasOwn(meta, 'error')) {
      storageFailureRevision++;
      const error = new Error(String(meta.error) || 'the browser could not verify a storage change');
      log?.error("A storage change couldn't be verified", error);
      setStatus('error', error);
      return;
    }
    const incoming = { ...(changes ?? {}) };
    if (meta?.snapshot) {
      for (const key of data.keys()) {
        if (!Object.hasOwn(incoming, key)) incoming[key] = null;
      }
    }
    const pushedEpoch = typeof meta?.epoch === 'string' && meta.epoch ? meta.epoch : null;
    const pushedState = validStorageRevisions(meta?.state)
      && storageRevisionEpoch(meta.state) === pushedEpoch ? meta.state : null;
    const reactivatesPushedEpoch = pushedEpoch && meta?.reactivatedEpoch === pushedEpoch;
    if (pushedEpoch && retiredStorageEpochs.has(pushedEpoch) && !reactivatesPushedEpoch) return;
    if (pushedEpoch && storageEpoch && pushedEpoch !== storageEpoch && !meta?.resetRevisions) return;
    const changesEpoch = Boolean(meta?.resetRevisions && (!storageEpoch || pushedEpoch !== storageEpoch));
    if (changesEpoch || (meta?.resetRevisions && pushedEpoch === storageEpoch)) {
      if (reactivatesPushedEpoch) retiredStorageEpochs.delete(pushedEpoch);
      if (storageEpoch && storageEpoch !== pushedEpoch) retiredStorageEpochs.add(storageEpoch);
      acceptedRevisions.clear();
      appliedRevisions.clear();
      revisionEpoch++;
      storageEpoch = pushedEpoch;
    } else if (pushedEpoch) {
      storageEpoch = pushedEpoch;
    }
    const changedKeys = new Set(Object.keys(incoming));
    if (pushedState) {
      for (const [key, value] of Object.entries(pushedState)) {
        if (key === STORAGE_REVISION_EPOCH_KEY || key === STORAGE_REVISION_ORDER_KEY) continue;
        acceptedRevisions.set(key, Math.max(acceptedRevisions.get(key) ?? 0, value));
      }
      if (meta?.resetRevisions) {
        for (const [key, value] of acceptedRevisions) {
          if (data.has(key) && !changedKeys.has(key)) appliedRevisions.set(key, value);
        }
      }
    }
    for (const [key, value] of Object.entries(incoming)) {
      const next = value === undefined || value === null ? undefined : copy(value);
      const accepted = meta?.revisions?.[key];
      const barrier = meta?.barriers?.[key];
      if (Number.isSafeInteger(accepted) && accepted >= 0) {
        const floor = acceptedRevisions.get(key) ?? accepted;
        acceptedRevisions.set(key, Math.max(floor, accepted));
        if (
          accepted !== acceptedRevisions.get(key)
          || (!meta?.snapshot && accepted <= (appliedRevisions.get(key) ?? 0))
        ) continue;
        appliedRevisions.set(key, accepted);
      } else {
        if (Number.isSafeInteger(barrier) && barrier >= 0) {
          const floor = acceptedRevisions.get(key) ?? 0;
          if (barrier < floor) continue;
          acceptedRevisions.set(key, Math.max(floor, barrier));
          appliedRevisions.set(key, Math.max(appliedRevisions.get(key) ?? 0, barrier));
        }
        keyVersions.set(key, (keyVersions.get(key) ?? 0) + 1);
      }
      // This tab's own writes come back too, already in the copy.
      const ownEcho = written.has(key) && same(data.get(key), next);
      keyEvents.set(key, (keyEvents.get(key) ?? 0) + 1);
      const newerRemote = (!loaded || loadPending) && !ownEcho;
      if (newerRemote) {
        remoteChanges.set(key, {
          revision: ++revision,
          epoch: revisionEpoch,
          storageRevision: Number.isSafeInteger(accepted) ? accepted : null,
          barrier: Number.isSafeInteger(barrier) ? barrier : null,
          value: next,
        });
        const queued = queuedWrites.get(key);
        if (queued?.confirmed) {
          confirmedWrites.delete(key);
          queued.confirmed.reject(new Error('Saved activity changed before it could be updated'));
        }
        queuedWrites.delete(key);
        written.delete(key);
      }
      if (same(data.get(key), next) && !newerRemote) continue;
      if (next === undefined) data.delete(key);
      else data.set(key, next);
      tell(key, next);
    }
  });

  void load();

  const sendConfirmed = async (operation) => {
    const { key, version } = operation;
    const events = keyEvents.get(key) ?? 0;
    const before = operation.failed ? copy(data.get(key)) : operation.previous;
    operation.failed = false;
    try {
      await bridge.request(operation.type, operation.payload);
      if (confirmedWrites.get(key) === operation) {
        confirmedWrites.delete(key);
        if (directVersions.get(key) === version && (keyEvents.get(key) ?? 0) === events && !same(data.get(key), operation.value)) {
          if (operation.value === undefined) data.delete(key);
          else data.set(key, copy(operation.value));
          tell(key, operation.value, 'ack');
        }
      }
      operation.resolve();
      return true;
    } catch (error) {
      log?.error("Saved activity couldn't be changed in the extension", error);
      if (confirmedWrites.get(key) === operation) {
        operation.failed = true;
        if (directVersions.get(key) === version && (keyEvents.get(key) ?? 0) === events) {
          const previous = !operation.loaded && before === undefined ? copy(pageLoadData.get(key)) : before;
          if (previous === undefined) data.delete(key);
          else data.set(key, previous);
          written.delete(key);
          tell(key, previous, 'rollback');
        }
        storageFailureRevision++;
        setStatus('error', error);
      }
      operation.reject(error);
      return false;
    }
  };
  const save = (type, payload, confirmed) => confirmed ? sendConfirmed(confirmed)
    : bridge.request(type, payload).catch((error) => log?.error("A setting couldn't be saved in the extension", error));
  const persist = (key, type, payload, confirmed) => {
    if (!loaded || finishing) queuedWrites.set(key, { type, payload, confirmed });
    else void save(type, payload, confirmed);
  };
  const retry = () => {
    if (writeRetry) return writeRetry;
    const failed = [...confirmedWrites.values()].filter((operation) => operation.failed);
    if (!failed.length) return load();
    writeRetry = (async () => {
      setStatus('loading');
      for (const operation of failed) {
        if (confirmedWrites.get(operation.key) === operation && !await sendConfirmed(operation)) return false;
      }
      // Read the authoritative snapshot after recovery, including other tabs' newer writes.
      setStatus('error', lastError);
      return load();
    })().finally(() => { writeRetry = null; });
    return writeRetry;
  };
  const supersedeWrite = (key) => {
    const queued = queuedWrites.get(key);
    if (queued?.confirmed) queued.confirmed.reject(new Error('A newer activity change replaced the queued write'));
    confirmedWrites.delete(key);
    const version = (directVersions.get(key) ?? 0) + 1;
    directVersions.set(key, version);
    return version;
  };
  const confirmedWrite = (key, type, payload, value) => {
    const version = supersedeWrite(key);
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Older feature actions may ignore a returned promise. The status still exposes failure.
    void promise.catch(() => {});
    const operation = { key, type, payload, value: copy(value), version, previous: copy(data.get(key)), loaded, failed: false, resolve, reject };
    confirmedWrites.set(key, operation);
    written.add(key);
    if (value === undefined) data.delete(key);
    else data.set(key, copy(value));
    persist(key, type, payload, operation);
    return promise;
  };

  const commitMutation = (type, key, payload, { detailed = false } = {}) => {
    const order = ++nextMutation;
    const version = keyVersions.get(key) ?? 0;
    latestMutation.set(key, order);
    return bridge.request(type, payload).then((answer) => {
      const envelope = Boolean(
        answer
        && typeof answer === 'object'
        && !Array.isArray(answer)
        && Object.hasOwn(answer, 'value')
        && (
          Object.hasOwn(answer, 'revision')
          || Object.hasOwn(answer, 'committed')
          || Object.hasOwn(answer, 'previous')
        )
      );
      const answerEpoch = typeof answer?.epoch === 'string' && answer.epoch ? answer.epoch : null;
      const versioned = Boolean(
        envelope
        && answerEpoch
        && Number.isSafeInteger(answer?.revision)
        && answer.revision >= 0
      );
      const committed = envelope ? answer.value : answer;
      let superseded;
      if (versioned) {
        if (!storageEpoch) {
          revisionEpoch++;
          acceptedRevisions.clear();
          appliedRevisions.clear();
          storageEpoch = answerEpoch;
        }
        superseded = retiredStorageEpochs.has(answerEpoch) || storageEpoch !== answerEpoch;
        const answerState = validStorageRevisions(answer?.revisions)
          && storageRevisionEpoch(answer.revisions) === answerEpoch ? answer.revisions : null;
        if (!superseded && answerState) {
          for (const [name, accepted] of Object.entries(answerState)) {
            if (name === STORAGE_REVISION_EPOCH_KEY || name === STORAGE_REVISION_ORDER_KEY) continue;
            acceptedRevisions.set(name, Math.max(acceptedRevisions.get(name) ?? 0, accepted));
          }
        }
        if (!superseded) {
          acceptedRevisions.set(key, Math.max(acceptedRevisions.get(key) ?? 0, answer.revision));
          superseded = acceptedRevisions.get(key) !== answer.revision
            || (appliedRevisions.get(key) ?? 0) >= answer.revision;
        }
      } else {
        superseded = latestMutation.get(key) !== order || (keyVersions.get(key) ?? 0) > version;
      }
      if (!superseded) {
        const next = committed === undefined || committed === null ? undefined : copy(committed);
        if (next === undefined) data.delete(key);
        else data.set(key, next);
        if (versioned) appliedRevisions.set(key, answer.revision);
        tell(key, next, 'ack');
      }
      const value = superseded ? (data.has(key) ? copy(data.get(key)) : undefined) : copy(committed);
      if (answer?.conflict === true) {
        const error = new Error('saved settings changed while their migration was being prepared');
        error.code = 'STORAGE_MIGRATION_CONFLICT';
        error.current = copy(value);
        error.receipt = copy(answer.receipt);
        error.copyAll = answer.copyAll === true;
        throw error;
      }
      return detailed ? {
        value,
        previous: envelope ? copy(answer.previous) : undefined,
        completedBefore: envelope ? copy(answer.completedBefore) : undefined,
      } : value;
    }, (error) => {
      log?.error("A setting couldn't be saved in the extension", error);
      throw error;
    });
  };

  return {
    kind: 'extension',
    activityContext: () => 'managed',
    get: (key, fallback) => (data.has(key) ? copy(data.get(key)) : fallback),
    getAtLoad: (key, fallback) => (pageLoadData.has(key) ? copy(pageLoadData.get(key)) : fallback),
    status,
    onStatus(listener) {
      statusListeners.add(listener);
      tellStatus(listener);
      return () => statusListeners.delete(listener);
    },
    retry,
    mutate: (key, mutation) => commitMutation('storage:mutate', key, { key, mutation }),
    mutateDetailed: (key, mutation) => commitMutation('storage:mutate', key, { key, mutation }, { detailed: true }),
    migrate: (key, mutation, doneKey, receipt, options = {}) => (
      commitMutation('storage:migrate', key, { key, mutation, doneKey, receipt, ...options })
    ),
    migrateDetailed: (key, mutation, doneKey, receipt, options = {}) => (
      commitMutation('storage:migrate', key, { key, mutation, doneKey, receipt, ...options }, { detailed: true })
    ),
    set(key, value) {
      const stored = copy(value);
      supersedeWrite(key);
      written.add(key);
      if (stored === undefined) data.delete(key);
      else data.set(key, stored);
      persist(key, 'storage:set', { key, value: stored ?? null });
    },
    setConfirmed: (key, value) => value === undefined
      ? confirmedWrite(key, 'storage:remove', { key })
      : confirmedWrite(key, 'storage:set', { key, value: copy(value) }, value),
    remove(key) {
      return confirmedWrite(key, 'storage:remove', { key });
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

// chrome.downloads names why a download stopped (SERVER_CONTENT_LENGTH_MISMATCH, FILE_NO_SPACE).
// The name stays in the message for Diagnostics, and USER_CANCELED still reads as a cancel.
function stoppedBecause(reason) {
  const code = String(reason || '');
  if (!/^[A-Z_]+$/.test(code)) return code || 'the download stopped';
  if (code === 'FILE_NO_SPACE') return `the disk is full (${code})`;
  if (code.startsWith('NETWORK_')) return `the connection dropped (${code})`;
  if (code.startsWith('SERVER_')) return `Facebook's server stopped sending it (${code})`;
  if (code.startsWith('FILE_')) return `the browser couldn't write the file (${code})`;
  return `the browser stopped it (${code})`;
}

// GM_download's shape, through chrome.downloads in the extension's background, abort() handle
// included. The background answers once the browser has taken the download, and says later
// how it ended (the 'download' push), so a long video counts as saved only when the browser
// has all of it. The key ties both to this one download, and lets the background find it again
// when the same request is sent twice (the isolated half asks again if the worker went away).
// A download the browser took and then stopped is final: Chrome has already retried the
// transfer itself, and the page's own fetch can't read Facebook's files.
export const bridgeDownload = (bridge, { makeKey = () => globalThis.crypto.randomUUID() } = {}) => ({ url, name, onload, onerror, ontimeout }) => {
  const key = makeKey();
  let over = false;
  const cancel = () => bridge.request('download:cancel', { key }).catch(() => {});
  const end = (report) => {
    if (over) return;
    over = true;
    stopListening();
    report?.();
  };
  const ended = ({ state, error } = {}) => {
    if (state === 'complete') end(onload);
    else if (state === 'interrupted') end(() => onerror?.({ error: stoppedBecause(error), final: true }));
  };
  const stopListening = bridge.on('download', (data) => {
    if (data?.key === key) ended(data);
  });
  bridge.request('download', { url, name, key }, { timeout: DOWNLOAD_ANSWER_WITHIN }).then(ended, (error) => {
    if (over) return;
    // The browser may have started it all the same, and nothing should go on behind a failure.
    cancel();
    end(() => (/did not answer/.test(error.message) ? ontimeout?.() : onerror?.({ error: error.message })));
  });
  return {
    abort() {
      if (over) return;
      end(null);
      cancel();
    },
  };
};
