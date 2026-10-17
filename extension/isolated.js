// The extension's isolated half. It runs beside the page script (src/core/bridge.js) in its own
// world, where chrome.storage and the messages to the background work, and answers the page
// script's requests over DOM events named with the secret the page script makes.
//
// The first well-formed hello wins. Both halves start at document_start, before any of
// Facebook's scripts, so the hello it hears is the page script's own.

import {
  HELLO_ISOLATED,
  HELLO_MAIN,
  STORAGE_REVISION_EPOCH_KEY,
  STORAGE_REVISION_ORDER_KEY,
  STORAGE_REVISIONS_KEY,
  channelNames,
  storageRevisionEpoch,
  validStorageRevisions,
} from '../src/core/bridge.js';

const SECRET = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVISION_WAIT = 5000;
const STORAGE_READ_RETRY_DELAYS = [50, 150];
let channel = null;
let physicalRevisions;
let storageRevisions;
let storageEpoch;
let revisionsInitialized = false;
let storageRevisionGeneration = 0;
let storageChangeTail = Promise.resolve();
const retiredStorageEpochs = new Set();
const observedRevisionOrders = new Map();
const revisionWaiters = new Set();

const clone = (value) => (value === undefined ? undefined : structuredClone(value));
const pause = (delay) => new Promise((resolve) => setTimeout(resolve, delay));
const readCurrentStorage = async () => {
  let lastError;
  for (let attempt = 0; attempt <= STORAGE_READ_RETRY_DELAYS.length; attempt++) {
    try {
      return await chrome.storage.local.get(null);
    } catch (error) {
      lastError = error;
      if (attempt < STORAGE_READ_RETRY_DELAYS.length) {
        await pause(STORAGE_READ_RETRY_DELAYS[attempt]);
      }
    }
  }
  throw lastError;
};
const orderedEntries = (value) => {
  if (value === undefined) return [['<undefined>', null]];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [['<value>', value]];
  return Object.keys(value).sort().map((name) => [name, value[name]]);
};
const sameRevisions = (left, right) => JSON.stringify(orderedEntries(left)) === JSON.stringify(orderedEntries(right));
const resetGeneration = (oldValue, newValue) => {
  const text = JSON.stringify([orderedEntries(oldValue), orderedEntries(newValue)]);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `reset-${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
};
const logicalRevisions = (record, epoch) => {
  if (validStorageRevisions(record) && storageRevisionEpoch(record) === epoch) return clone(record);
  return { [STORAGE_REVISION_EPOCH_KEY]: epoch, [STORAGE_REVISION_ORDER_KEY]: 0 };
};
const revisionsRegress = (next, current) => {
  if (!validStorageRevisions(next) || !validStorageRevisions(current)) return false;
  if (next[STORAGE_REVISION_ORDER_KEY] < current[STORAGE_REVISION_ORDER_KEY]) return true;
  for (const [name, revision] of Object.entries(current)) {
    if (name === STORAGE_REVISION_EPOCH_KEY || name === STORAGE_REVISION_ORDER_KEY) continue;
    if (!Number.isSafeInteger(next[name]) || next[name] < revision) return true;
  }
  return next[STORAGE_REVISION_ORDER_KEY] === current[STORAGE_REVISION_ORDER_KEY]
    && !sameRevisions(next, current);
};

function noteObservedRevision(record, { reset = false } = {}) {
  if (!validStorageRevisions(record)) return;
  const epoch = storageRevisionEpoch(record);
  const order = record[STORAGE_REVISION_ORDER_KEY];
  observedRevisionOrders.set(epoch, reset ? order : Math.max(observedRevisionOrders.get(epoch) ?? 0, order));
  for (const waiter of [...revisionWaiters]) {
    if (waiter.epoch !== epoch || order < waiter.order) continue;
    revisionWaiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve();
  }
}

function clearRevisionEpoch(epoch) {
  if (!epoch) return;
  observedRevisionOrders.delete(epoch);
  for (const waiter of [...revisionWaiters]) {
    if (waiter.epoch !== epoch) continue;
    revisionWaiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.reject(new Error('the browser changed storage generations before confirming the change'));
  }
}

function retireRevisionEpoch(epoch) {
  if (!epoch) return;
  retiredStorageEpochs.add(epoch);
  clearRevisionEpoch(epoch);
}

function replaceRevisionEpoch(epoch) {
  const previous = storageEpoch;
  const reactivated = retiredStorageEpochs.has(epoch) && previous !== epoch;
  if (previous === epoch) clearRevisionEpoch(previous);
  else if (previous) retireRevisionEpoch(previous);
  retiredStorageEpochs.delete(epoch);
  return reactivated;
}

function waitForRevision({ epoch, revisions, revision }) {
  const order = validStorageRevisions(revisions) ? revisions[STORAGE_REVISION_ORDER_KEY] : revision;
  if (typeof epoch !== 'string' || !epoch || !Number.isSafeInteger(order)) {
    return Promise.reject(new Error('the browser returned an invalid storage acknowledgement'));
  }
  if ((observedRevisionOrders.get(epoch) ?? 0) >= order) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const waiter = { epoch, order, resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      revisionWaiters.delete(waiter);
      reject(new Error('the browser did not confirm the storage change'));
    }, REVISION_WAIT);
    revisionWaiters.add(waiter);
  });
}

function initializeRevisions(record) {
  physicalRevisions = clone(record);
  storageEpoch = validStorageRevisions(record)
    ? storageRevisionEpoch(record)
    : resetGeneration(undefined, record);
  storageRevisions = logicalRevisions(record, storageEpoch);
  revisionsInitialized = true;
  noteObservedRevision(storageRevisions, { reset: true });
}

function acceptRevisionEvent(record, oldValue, currentRecord) {
  const valid = validStorageRevisions(record);
  const physicalValid = validStorageRevisions(physicalRevisions);
  const physicalEpoch = storageRevisionEpoch(physicalRevisions);
  const nextEpoch = storageRevisionEpoch(record);
  const changesLogicalEpoch = nextEpoch !== storageEpoch;
  const followsPhysicalRecord = revisionsInitialized && sameRevisions(oldValue, physicalRevisions);
  let reactivated = false;
  const matchesCurrentRecord = sameRevisions(currentRecord, record);
  if (!valid) {
    if (!followsPhysicalRecord && !matchesCurrentRecord) return { accepted: false };
    const epoch = resetGeneration(oldValue, record);
    reactivated = replaceRevisionEpoch(epoch);
    physicalRevisions = clone(record);
    storageEpoch = epoch;
    storageRevisions = logicalRevisions(record, epoch);
    revisionsInitialized = true;
    storageRevisionGeneration++;
    noteObservedRevision(storageRevisions, { reset: true });
    return { accepted: true, reset: true, stale: false, reactivated };
  }
  if (nextEpoch !== storageEpoch && !followsPhysicalRecord && !matchesCurrentRecord) {
    return { accepted: false };
  }
  if (nextEpoch === storageEpoch) {
    if (!followsPhysicalRecord && !matchesCurrentRecord) return { accepted: false };
    if (
      matchesCurrentRecord
      && sameRevisions(record, physicalRevisions)
      && !sameRevisions(oldValue, physicalRevisions)
    ) {
      const epoch = resetGeneration(oldValue, record);
      reactivated = replaceRevisionEpoch(epoch);
      physicalRevisions = clone(record);
      storageEpoch = epoch;
      storageRevisions = logicalRevisions(record, epoch);
      storageRevisionGeneration++;
      noteObservedRevision(storageRevisions, { reset: true });
      return { accepted: true, reset: true, stale: false, reactivated };
    }
    if (physicalValid && physicalEpoch === nextEpoch && revisionsRegress(record, physicalRevisions)) {
      if (!sameRevisions(oldValue, physicalRevisions) && !matchesCurrentRecord) {
        return { accepted: true, reset: false, stale: true };
      }
      const epoch = resetGeneration(oldValue, record);
      reactivated = replaceRevisionEpoch(epoch);
      physicalRevisions = clone(record);
      storageEpoch = epoch;
      storageRevisions = logicalRevisions(record, epoch);
      storageRevisionGeneration++;
      noteObservedRevision(storageRevisions, { reset: true });
      return { accepted: true, reset: true, stale: false, reactivated };
    }
  } else if (physicalValid && nextEpoch === physicalEpoch) {
    const epoch = resetGeneration(oldValue, record);
    reactivated = replaceRevisionEpoch(epoch);
    physicalRevisions = clone(record);
    storageEpoch = epoch;
    storageRevisions = logicalRevisions(record, epoch);
    revisionsInitialized = true;
    storageRevisionGeneration++;
    noteObservedRevision(storageRevisions, { reset: true });
    return { accepted: true, reset: true, stale: false, reactivated };
  } else {
    reactivated = retiredStorageEpochs.has(nextEpoch) && storageEpoch !== nextEpoch;
    retiredStorageEpochs.delete(nextEpoch);
    if (storageEpoch) retireRevisionEpoch(storageEpoch);
    storageEpoch = nextEpoch;
    storageRevisionGeneration++;
  }
  physicalRevisions = clone(record);
  storageRevisions = logicalRevisions(record, storageEpoch);
  revisionsInitialized = true;
  noteObservedRevision(storageRevisions, { reset: changesLogicalEpoch || reactivated });
  return { accepted: true, reset: changesLogicalEpoch, stale: false, reactivated };
}

const toMain = (message) => document.dispatchEvent(new CustomEvent(channel.toMain, { detail: JSON.stringify(message) }));

async function workerStorageRequest(type, payload) {
  const answer = await chrome.runtime.sendMessage({
    type,
    ...payload,
    generation: storageEpoch,
    baseRevisions: clone(physicalRevisions),
  });
  if (!answer?.ok) throw new Error(answer?.error || 'the browser could not save the settings');
  if (answer.result?.committed !== false) await waitForRevision(answer.result ?? {});
  return answer.result;
}

const handlers = {
  'storage:load': async () => {
    const generation = storageRevisionGeneration;
    const recovering = revisionsInitialized;
    const recovery = await chrome.runtime.sendMessage({ type: 'storage:recover' });
    if (!recovery?.ok) throw new Error(recovery?.error || 'the browser could not recover the saved settings');
    const saved = await chrome.storage.local.get(null);
    const revisions = saved?.[STORAGE_REVISIONS_KEY];
    if (storageRevisionGeneration === generation) {
      if (recovering) acceptRevisionEvent(revisions, physicalRevisions, revisions);
      else initializeRevisions(revisions);
      if (recovering) return { ...saved, [STORAGE_REVISIONS_KEY]: clone(storageRevisions) };
    }
    return saved;
  },
  'storage:set': ({ key, value }) => (value === null ? chrome.storage.local.remove(key) : chrome.storage.local.set({ [key]: value })),
  'storage:remove': ({ key }) => chrome.storage.local.remove(key),
  'storage:mutate': ({ key, mutation }) => workerStorageRequest('storage:mutate', { key, mutation }),
  'storage:migrate': ({ key, doneKey, mutation, receipt, sourceKey, sourceDoneKey }) => (
    workerStorageRequest('storage:migrate', {
      key,
      doneKey,
      mutation,
      receipt,
      sourceKey,
      sourceDoneKey,
    })
  ),
  download: async ({ url, name }) => {
    const answer = await chrome.runtime.sendMessage({ type: 'download', url, name });
    if (!answer?.ok) throw new Error(answer?.error || 'the browser could not save it');
  },
};

async function onRequest(event) {
  let message;
  try {
    message = JSON.parse(event.detail);
  } catch {
    return;
  }
  const { id, type, payload } = message ?? {};
  const handler = Object.hasOwn(handlers, type) ? handlers[type] : null;
  if (!Number.isInteger(id)) return;
  try {
    if (!handler) throw new Error(`unknown request ${type}`);
    const result = await handler(payload ?? {});
    toMain({ id, ok: true, result: result ?? null });
  } catch (error) {
    toMain({ id, ok: false, error: String(error?.message ?? error) });
  }
}

document.addEventListener(HELLO_MAIN, (event) => {
  if (channel || typeof event.detail !== 'string' || !SECRET.test(event.detail)) return;
  channel = channelNames(event.detail);
  document.addEventListener(channel.toIsolated, onRequest);

  // Changes from other tabs and the extension's own pages. This tab's writes come back too,
  // and the page script skips those.
  const forwardStorageChange = async (changes) => {
    let currentSnapshot;
    try {
      currentSnapshot = await readCurrentStorage();
    } catch (error) {
      const detail = String(error?.message ?? error ?? '') || 'the browser could not verify a storage change';
      toMain({
        push: 'storage',
        data: {},
        meta: { error: detail },
      });
      return;
    }
    const data = {};
    const revisionChange = changes[STORAGE_REVISIONS_KEY];
    let revisions = revisionChange?.newValue;
    let revisionOldValue = revisionChange?.oldValue;
    const currentRevisions = currentSnapshot?.[STORAGE_REVISIONS_KEY];
    let fullSnapshot = Boolean(
      Object.hasOwn(changes, STORAGE_REVISIONS_KEY)
      && currentSnapshot
      && sameRevisions(currentRevisions, revisions),
    );
    if (
      Object.hasOwn(changes, STORAGE_REVISIONS_KEY)
      && currentSnapshot
      && !sameRevisions(currentRevisions, revisions)
    ) {
      if (sameRevisions(currentRevisions, physicalRevisions)) return;
      revisions = currentRevisions;
      revisionOldValue = physicalRevisions;
      fullSnapshot = true;
    }
    let resetRevisions = false;
    let reactivatedEpoch = null;
    if (Object.hasOwn(changes, STORAGE_REVISIONS_KEY)) {
      const acceptedEvent = acceptRevisionEvent(revisions, revisionOldValue, currentRevisions);
      if (!acceptedEvent.accepted) return;
      storageRevisionGeneration++;
      resetRevisions = acceptedEvent.reset;
      if (acceptedEvent.reactivated) reactivatedEpoch = storageEpoch;
    }
    const accepted = {};
    const barriers = {};
    const forwarded = fullSnapshot
      ? Object.fromEntries(Object.entries(currentSnapshot).map(([key, newValue]) => [key, { newValue }]))
      : changes;
    if (fullSnapshot && validStorageRevisions(revisions)) {
      for (const key of Object.keys(revisions)) {
        if (
          key !== STORAGE_REVISION_EPOCH_KEY
          && key !== STORAGE_REVISION_ORDER_KEY
          && !Object.hasOwn(currentSnapshot, key)
        ) forwarded[key] = { newValue: undefined };
      }
    }
    for (const [key, { newValue: eventValue }] of Object.entries(forwarded)) {
      if (key === STORAGE_REVISIONS_KEY) continue;
      let newValue = eventValue;
      if (!fullSnapshot && currentSnapshot) {
        const currentValue = currentSnapshot[key];
        if (Object.hasOwn(changes, STORAGE_REVISIONS_KEY)) {
          if (!sameRevisions(currentValue, eventValue)) continue;
        } else {
          newValue = currentValue;
        }
      }
      data[key] = newValue ?? null;
      if (
        validStorageRevisions(revisions)
        && storageRevisionEpoch(revisions) === storageEpoch
        && Number.isSafeInteger(revisions[key])
      ) accepted[key] = revisions[key];
      else if (Number.isSafeInteger(storageRevisions?.[key])) barriers[key] = storageRevisions[key];
    }
    if (Object.keys(data).length || resetRevisions) {
      toMain({
        push: 'storage',
        data,
        meta: {
          revisions: accepted,
          barriers,
          state: clone(storageRevisions),
          resetRevisions,
          reactivatedEpoch,
          snapshot: fullSnapshot,
          epoch: storageEpoch,
        },
      });
    }
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    storageChangeTail = storageChangeTail.then(
      () => forwardStorageChange(changes),
      () => forwardStorageChange(changes),
    );
  });
  // The toolbar button.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'open-settings') toMain({ push: 'open-settings' });
    if (message?.type === 'storage-error') {
      toMain({
        push: 'storage',
        data: {},
        meta: { error: String(message.error) || 'the browser could not verify a storage change' },
      });
    }
  });
  // Ready comes last, so every queued request sees the storage and toolbar listeners in place.
  toMain({ ready: true });
});

// For when the page script started first and its hello went unheard.
document.dispatchEvent(new CustomEvent(HELLO_ISOLATED));
