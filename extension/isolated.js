// The extension's isolated half. It runs beside the page script (src/core/bridge.js) in its own
// world, where chrome.storage and messages to the background work. MAIN shares Facebook's world,
// so every DOM message is untrusted. The random event name prevents accidental collisions but is
// not authentication. The first well-formed hello only chooses a route; document-derived
// capabilities, validation and bounds protect it even when the page chooses that route first.

import {
  BRIDGE_MAX_DOWNLOADS_PER_WINDOW,
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_PENDING,
  BRIDGE_MAX_REQUESTS_PER_WINDOW,
  BRIDGE_MAX_VALUE_BYTES,
  BRIDGE_MAX_WRITES_PER_WINDOW,
  BRIDGE_RATE_WINDOW,
  HELLO_ISOLATED,
  HELLO_MAIN,
  STORAGE_REVISION_EPOCH_KEY,
  STORAGE_REVISION_ORDER_KEY,
  STORAGE_REVISIONS_KEY,
  channelNames,
  storageRevisionEpoch,
  validStorageRevisions,
} from '../src/core/bridge.js';
import { accountFromCookie, storageKeyFor } from '../src/core/settings.js';

const SECRET = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVISION_WAIT = 5000;
const STORAGE_READ_RETRY_DELAYS = [50, 150];
const FACEBOOK = new Set(['www.facebook.com', 'web.facebook.com']);
const GAME_KEY = 'instantGamesAds.enabled';
const READ_ONLY_KEY = 'extensionUpdate';
const SAFE_FIELD = /^(?!__proto__$|prototype$|constructor$)[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const MIGRATION_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const UPDATE_VERSION = /^\d+(?:\.\d+)*$/;
// Custom CSS takes 50,000 characters, the longest text setting.
const SETTING_TEXT_MAX = 65536;
const encoder = new TextEncoder();
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

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const jsonBytes = (value, max = BRIDGE_MAX_VALUE_BYTES) => {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string' || text.length > max) return Infinity;
    return encoder.encode(text).byteLength;
  } catch {
    return Infinity;
  }
};
const boundedString = (value, max = 20000) => typeof value === 'string' && value.length <= max;
const finite = (value, min = -Infinity, max = Infinity) => Number.isFinite(value) && value >= min && value <= max;
const primitiveSetting = (value) => (
  typeof value === 'boolean'
  || boundedString(value, SETTING_TEXT_MAX)
  || finite(value)
);
const settingsRecord = (value) => (
  isRecord(value)
  && Object.keys(value).length <= 256
  && Object.entries(value).every(([name, setting]) => SAFE_FIELD.test(name) && primitiveSetting(setting))
);
const migrationReceipt = (value) => (
  Array.isArray(value)
  && value.length <= 128
  && value.every((id) => typeof id === 'string' && MIGRATION_ID.test(id))
);
// The stores keep 5,000 seen posts and 200 positions, but a record over that is still read, so a
// late prune can't hide the whole history and let the next save write over it.
const seenRecord = (value) => (
  isRecord(value)
  && Object.keys(value).length <= 20000
  && Object.entries(value).every(([id, at]) => boundedString(id, 256) && id.length > 0 && finite(at, 1))
);
const taskRecord = (value) => (
  isRecord(value)
  && Object.keys(value).length <= 32
  && Object.entries(value).every(([id, at]) => SAFE_FIELD.test(id) && finite(at, 0))
);
const storageCheckRecord = (value) => (
  isRecord(value)
  && Object.keys(value).every((name) => name === 'token' || name === 'at')
  && boundedString(value.token, 80)
  && value.token.length > 0
  && finite(value.at, 0)
);
const volumeRecord = (value) => (
  isRecord(value)
  && Object.keys(value).every((name) => name === 'volume' || name === 'muted')
  && finite(value.volume, 0, 1)
  && typeof value.muted === 'boolean'
);
const positionRecord = (value) => (
  isRecord(value)
  && Object.keys(value).length <= 1000
  && Object.entries(value).every(([id, spot]) => (
    boundedString(id, 256)
    && id.length > 0
    && isRecord(spot)
    && Object.keys(spot).every((name) => name === 't' || name === 'd' || name === 'at')
    && finite(spot.t, 0)
    && finite(spot.d, 0)
    && finite(spot.at, 0)
  ))
);
const updateRecord = (value) => (
  isRecord(value)
  && Object.keys(value).every((name) => ['at', 'current', 'latest', 'url', 'newer'].includes(name))
  && finite(value.at, 0)
  && boundedString(value.current, 32)
  && UPDATE_VERSION.test(value.current)
  && (value.latest === null || (boundedString(value.latest, 32) && UPDATE_VERSION.test(value.latest)))
  && (value.url === null || (boundedString(value.url, 512) && value.url.startsWith('https://github.com/SysAdminDoc/HushFacebookWeb/')))
  && typeof value.newer === 'boolean'
);

const FACEBOOK_VALUES = new Map([
  ['seenPosts', seenRecord],
  ['seenPostsCleared', (value) => finite(value, 0)],
  ['tasks', taskRecord],
  ['storageCheck', storageCheckRecord],
  [READ_ONLY_KEY, updateRecord],
  ['extensionUpdate.told', (value) => boundedString(value, 32) && UPDATE_VERSION.test(value)],
  ['keepSpeed.rate', (value) => finite(value, 0.25, 4)],
  ['keepVolume.state', volumeRecord],
  ['resumeVideos.positions', positionRecord],
  [GAME_KEY, (value) => typeof value === 'boolean'],
  ['hidePostsByWords.cssWarned', (value) => boundedString(value, 64) && /^\d+:[0-9a-f]+$/.test(value)],
]);

function storageAccessFor(doc) {
  let url;
  try {
    url = new URL(doc.location.href);
  } catch {
    return { kind: 'none', values: new Map(), writable: new Set(), settingsKey: null, receiptKey: null };
  }
  const hostname = url.hostname.toLowerCase();
  const top = doc.defaultView?.top === doc.defaultView;
  if (url.protocol === 'https:' && (hostname === 'apps.fbsbx.com' || hostname.endsWith('.apps.fbsbx.com'))) {
    return {
      kind: 'game',
      values: new Map([[GAME_KEY, (value) => typeof value === 'boolean']]),
      writable: new Set([GAME_KEY]),
      settingsKey: null,
      receiptKey: null,
    };
  }
  if (url.protocol !== 'https:' || !FACEBOOK.has(hostname) || !top) {
    return { kind: 'none', values: new Map(), writable: new Set(), settingsKey: null, receiptKey: null };
  }
  const account = accountFromCookie(doc.cookie);
  const settingsKey = storageKeyFor(account);
  const receiptKey = `${settingsKey}.migrated`;
  const values = new Map(FACEBOOK_VALUES);
  values.set('settings', settingsRecord);
  values.set('settings.migrated', migrationReceipt);
  values.set(settingsKey, settingsRecord);
  values.set(receiptKey, migrationReceipt);
  const writable = new Set([...FACEBOOK_VALUES.keys()].filter((key) => key !== READ_ONLY_KEY));
  writable.add(settingsKey);
  writable.add(receiptKey);
  return { kind: 'facebook', values, writable, settingsKey, receiptKey };
}

const storageAccess = storageAccessFor(document);
const allowedValue = (key, value) => (
  storageAccess.values.get(key)?.(value) === true
  && jsonBytes(value) <= BRIDGE_MAX_VALUE_BYTES
);
const visibleRevisions = (value) => {
  if (!validStorageRevisions(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => (
    key === STORAGE_REVISION_EPOCH_KEY
    || key === STORAGE_REVISION_ORDER_KEY
    || storageAccess.values.has(key)
  )));
};
const visibleStorage = (saved) => {
  const result = {};
  for (const [key, value] of Object.entries(saved ?? {})) {
    if (key === STORAGE_REVISIONS_KEY) {
      result[key] = visibleRevisions(value);
      continue;
    }
    if (allowedValue(key, value)) result[key] = clone(value);
  }
  if (jsonBytes(result, BRIDGE_MAX_MESSAGE_BYTES) > BRIDGE_MAX_MESSAGE_BYTES) throw new Error('the saved values are too large');
  return result;
};

const onlyKeys = (value, names) => (
  isRecord(value) && Object.keys(value).every((name) => names.includes(name))
);
const conditionsRecord = (value) => (
  value === undefined
  || (
    isRecord(value)
    && Object.keys(value).length <= 256
    && Object.entries(value).every(([name, condition]) => (
      SAFE_FIELD.test(name)
      && isRecord(condition)
      && Object.keys(condition).every((field) => field === 'exists' || field === 'value')
      && typeof condition.exists === 'boolean'
      && (!condition.exists || primitiveSetting(condition.value))
    ))
  )
);
const settingsMutation = (mutation) => {
  if (!onlyKeys(mutation, ['replace', 'initialize', 'set', 'remove', 'conditions', 'guard', 'guarded', 'migrationOwners', 'expected', 'removeRecord'])) return false;
  if (mutation.removeRecord === true) {
    return Object.keys(mutation).every((name) => name === 'removeRecord' || name === 'expected')
      && (mutation.expected === undefined || settingsRecord(mutation.expected));
  }
  if (Object.hasOwn(mutation, 'replace') && !settingsRecord(mutation.replace)) return false;
  if (Object.hasOwn(mutation, 'initialize') && !settingsRecord(mutation.initialize)) return false;
  if (Object.hasOwn(mutation, 'expected') && !settingsRecord(mutation.expected)) return false;
  if (mutation.set !== undefined && !settingsRecord(mutation.set)) return false;
  if (mutation.remove !== undefined && (!Array.isArray(mutation.remove) || mutation.remove.length > 256 || mutation.remove.some((name) => !SAFE_FIELD.test(name)))) return false;
  if (!conditionsRecord(mutation.conditions) || !conditionsRecord(mutation.guard)) return false;
  if (mutation.guarded !== undefined && (!Array.isArray(mutation.guarded) || mutation.guarded.length > 256 || mutation.guarded.some((name) => !SAFE_FIELD.test(name)))) return false;
  if (
    mutation.migrationOwners !== undefined
    && (!isRecord(mutation.migrationOwners) || Object.entries(mutation.migrationOwners).some(([name, id]) => !SAFE_FIELD.test(name) || !MIGRATION_ID.test(id)))
  ) return false;
  return jsonBytes(mutation) <= BRIDGE_MAX_VALUE_BYTES;
};
const receiptMutation = (mutation) => (
  onlyKeys(mutation, ['union'])
  && migrationReceipt(mutation.union)
  && jsonBytes(mutation) <= BRIDGE_MAX_VALUE_BYTES
);
const validStorageRequest = (type, payload) => {
  if (!isRecord(payload)) return false;
  if (type === 'storage:load') return Object.keys(payload).length === 0 && storageAccess.kind !== 'none';
  // The settings record and its receipt change only through storage:mutate and storage:migrate.
  const directWrite = (key) => (
    storageAccess.writable.has(key) && key !== storageAccess.settingsKey && key !== storageAccess.receiptKey
  );
  if (type === 'storage:set') {
    return onlyKeys(payload, ['key', 'value'])
      && directWrite(payload.key)
      && (payload.value === null || allowedValue(payload.key, payload.value));
  }
  if (type === 'storage:remove') {
    return onlyKeys(payload, ['key']) && directWrite(payload.key);
  }
  if (type === 'storage:mutate') {
    if (!onlyKeys(payload, ['key', 'mutation']) || !storageAccess.writable.has(payload.key)) return false;
    if (payload.key === storageAccess.settingsKey) return settingsMutation(payload.mutation);
    if (payload.key === storageAccess.receiptKey) return receiptMutation(payload.mutation);
    return false;
  }
  if (type === 'storage:migrate') {
    if (!onlyKeys(payload, ['key', 'doneKey', 'mutation', 'receipt', 'sourceKey', 'sourceDoneKey'])) return false;
    const accountScoped = storageAccess.settingsKey !== 'settings';
    return payload.key === storageAccess.settingsKey
      && payload.doneKey === storageAccess.receiptKey
      && settingsMutation(payload.mutation)
      && migrationReceipt(payload.receipt)
      && (
        accountScoped
          ? payload.sourceKey === 'settings' && payload.sourceDoneKey === 'settings.migrated'
          : payload.sourceKey === undefined && payload.sourceDoneKey === undefined
      );
  }
  return false;
};
const validDownloadRequest = (payload) => (
  storageAccess.kind === 'facebook'
  && onlyKeys(payload, ['url', 'name'])
  && boundedString(payload.url, 8192)
  && payload.url.length > 0
  && boundedString(payload.name, 512)
  && payload.name.length > 0
);
const activeRequests = new Set();
// Separate buckets, so a volume-slider drag can't use up the quota a settings save needs.
const requestTimes = [];
const writeTimes = [];
const downloadTimes = [];
const takeQuota = (times, limit, now = Date.now()) => {
  while (times.length && now - times[0] >= BRIDGE_RATE_WINDOW) times.shift();
  if (times.length >= limit) return false;
  times.push(now);
  return true;
};
const requestAllowedNow = (type) => {
  if (type === 'download') return takeQuota(downloadTimes, BRIDGE_MAX_DOWNLOADS_PER_WINDOW);
  if (type === 'storage:set' || type === 'storage:remove') return takeQuota(writeTimes, BRIDGE_MAX_WRITES_PER_WINDOW);
  return takeQuota(requestTimes, BRIDGE_MAX_REQUESTS_PER_WINDOW);
};

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

const toMain = (message) => {
  const detail = JSON.stringify(message);
  if (detail.length > BRIDGE_MAX_MESSAGE_BYTES || encoder.encode(detail).byteLength > BRIDGE_MAX_MESSAGE_BYTES) {
    throw new Error('the extension answer is too large');
  }
  document.dispatchEvent(new CustomEvent(channel.toMain, { detail }));
};

async function workerStorageRequest(type, payload) {
  const answer = await chrome.runtime.sendMessage({
    type,
    ...payload,
    generation: storageEpoch,
    baseRevisions: clone(physicalRevisions),
  });
  if (!answer?.ok) throw new Error(answer?.error || 'the browser could not save the settings');
  if (answer.result?.committed !== false) await waitForRevision(answer.result ?? {});
  const result = clone(answer.result);
  if (isRecord(result) && Object.hasOwn(result, 'revisions')) result.revisions = visibleRevisions(result.revisions);
  return result;
}

const handlers = {
  'storage:load': async () => {
    const generation = storageRevisionGeneration;
    const recovering = revisionsInitialized;
    // Game frames hold no settings record to recover, and the worker only answers Facebook's top frame.
    if (storageAccess.kind === 'facebook') {
      const recovery = await chrome.runtime.sendMessage({ type: 'storage:recover' });
      if (!recovery?.ok) throw new Error(recovery?.error || 'the browser could not recover the saved settings');
    }
    const saved = await chrome.storage.local.get(null);
    const revisions = saved?.[STORAGE_REVISIONS_KEY];
    if (storageRevisionGeneration === generation) {
      if (recovering) {
        acceptRevisionEvent(revisions, physicalRevisions, revisions);
        return visibleStorage({ ...saved, [STORAGE_REVISIONS_KEY]: clone(storageRevisions) });
      }
      initializeRevisions(revisions);
    }
    return visibleStorage(saved);
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
  if (typeof event.detail !== 'string') return;
  if (
    event.detail.length > BRIDGE_MAX_MESSAGE_BYTES
    || encoder.encode(event.detail).byteLength > BRIDGE_MAX_MESSAGE_BYTES
  ) return;
  let message;
  try {
    message = JSON.parse(event.detail);
  } catch {
    return;
  }
  const { id, type, payload } = message ?? {};
  const handler = Object.hasOwn(handlers, type) ? handlers[type] : null;
  if (!Number.isSafeInteger(id) || id < 0) return;
  const fail = (error) => toMain({ id, ok: false, error });
  if (activeRequests.has(id)) {
    fail('that extension request is already running');
    return;
  }
  if (activeRequests.size >= BRIDGE_MAX_PENDING) {
    fail('too many extension requests are running');
    return;
  }
  if (!requestAllowedNow(type)) {
    fail('too many extension requests were sent');
    return;
  }
  try {
    if (!handler) throw new Error(`unknown request ${type}`);
    const body = payload ?? {};
    if (type.startsWith('storage:') && !validStorageRequest(type, body)) throw new Error('that storage request is not allowed');
    if (type === 'download' && !validDownloadRequest(body)) throw new Error('that download request is not allowed');
    activeRequests.add(id);
    const result = await handler(body);
    toMain({ id, ok: true, result: result ?? null });
  } catch (error) {
    toMain({ id, ok: false, error: String(error?.message ?? error) });
  } finally {
    activeRequests.delete(id);
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
      ? Object.fromEntries(Object.entries(currentSnapshot)
        .filter(([key]) => key === STORAGE_REVISIONS_KEY || storageAccess.values.has(key))
        .map(([key, newValue]) => [key, { newValue }]))
      : changes;
    if (fullSnapshot && validStorageRevisions(revisions)) {
      for (const key of Object.keys(revisions)) {
        if (
          key !== STORAGE_REVISION_EPOCH_KEY
          && key !== STORAGE_REVISION_ORDER_KEY
          && storageAccess.values.has(key)
          && !Object.hasOwn(currentSnapshot, key)
        ) forwarded[key] = { newValue: undefined };
      }
    }
    for (const [key, { newValue: eventValue }] of Object.entries(forwarded)) {
      if (key === STORAGE_REVISIONS_KEY) continue;
      if (!storageAccess.values.has(key)) continue;
      let newValue = eventValue;
      if (!fullSnapshot && currentSnapshot) {
        const currentValue = currentSnapshot[key];
        if (Object.hasOwn(changes, STORAGE_REVISIONS_KEY)) {
          if (!sameRevisions(currentValue, eventValue)) continue;
        } else {
          newValue = currentValue;
        }
      }
      if (newValue !== undefined && !allowedValue(key, newValue)) newValue = undefined;
      data[key] = newValue ?? null;
      if (
        validStorageRevisions(revisions)
        && storageRevisionEpoch(revisions) === storageEpoch
        && Number.isSafeInteger(revisions[key])
      ) accepted[key] = revisions[key];
      else if (Number.isSafeInteger(storageRevisions?.[key])) barriers[key] = storageRevisions[key];
    }
    if (Object.keys(data).length || resetRevisions) {
      try {
        toMain({
          push: 'storage',
          data,
          meta: {
            revisions: accepted,
            barriers,
            state: visibleRevisions(storageRevisions),
            resetRevisions,
            reactivatedEpoch,
            snapshot: fullSnapshot,
            epoch: storageEpoch,
          },
        });
      } catch (error) {
        toMain({
          push: 'storage',
          data: {},
          meta: { error: String(error?.message ?? error) },
        });
      }
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
