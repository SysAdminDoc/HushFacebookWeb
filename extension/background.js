// The extension's service worker: saves photos and videos with chrome.downloads, and opens the
// settings panel from the toolbar button. A classic script, so openSettings is a global the
// live check can call the way a click would.

const FACEBOOK = ['www.facebook.com', 'web.facebook.com'];
// Where the script's downloads come from: Facebook's media servers.
const SAVABLE = /(^|\.)(fbcdn\.net|facebook\.com)$/;
// The worker answers by then even when a large file is still coming, so it never outlives the
// browser's limit on one event. The download carries on either way.
const ANSWER_WITHIN = 20000;
const STORAGE_REVISIONS_KEY = 'hushfacebookWeb.storageRevisions';
const STORAGE_REVISION_EPOCH_KEY = '__epoch';
const STORAGE_REVISION_ORDER_KEY = '__order';
const PREFERENCE_KEY = /^settings(?:@[a-z0-9]+)?(?:\.migrated)?$/;
const SETTINGS_KEY = /^settings(?:@[a-z0-9]+)?$/;
const PENDING_RECOVERY_KEY = 'hushfacebookWeb.pendingPreferenceRecovery';
const DIRECT_STORAGE_RETRY_DELAYS = [50, 150];
const FACEBOOK_ORIGINS = new Set(['https://www.facebook.com', 'https://web.facebook.com']);
const MESSAGE_MAX_BYTES = 1536 * 1024;
const VALUE_MAX_BYTES = 1024 * 1024;
const REQUEST_RATE_WINDOW = 10000;
const REQUESTS_PER_WINDOW = 120;
const DOWNLOADS_PER_WINDOW = 8;
const SAFE_FIELD = /^(?!__proto__$|prototype$|constructor$)[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const MIGRATION_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
let storageMutationTail = Promise.resolve();
const pendingStorageWrites = [];
const pendingStorageRemovals = new Set();
const pendingDirectRecoveries = new Map();
const deferredDirectChanges = new Map();
let pendingDirectRecoveriesLoad = null;
const senderRates = new Map();

function utf8Bytes(value, max = VALUE_MAX_BYTES) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return Infinity;
  }
  if (typeof text !== 'string' || text.length > max) return Infinity;
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index++;
    } else bytes += 3;
    if (bytes > max) return bytes;
  }
  return bytes;
}

// A page Chrome prerenders (Facebook typed into the address bar) has a top frame whose frameId
// isn't 0 until it's shown, and its content scripts load settings before then.
function trustedSender(sender) {
  if (!sender?.tab || !Number.isInteger(sender.tab.id)) return false;
  if (sender.frameId !== 0 && sender.documentLifecycle !== 'prerender') return false;
  if (!FACEBOOK_ORIGINS.has(sender.origin)) return false;
  const parsed = hostOf(sender.url);
  return parsed?.protocol === 'https:' && sender.origin === parsed.origin && FACEBOOK.includes(parsed.hostname);
}

function takeRate(list, limit, now) {
  while (list.length && now - list[0] >= REQUEST_RATE_WINDOW) list.shift();
  if (list.length >= limit) return false;
  list.push(now);
  return true;
}

function senderAllowedNow(sender, type, now = Date.now()) {
  const key = `${sender.tab.id}:${sender.documentId ?? sender.url}`;
  let rate = senderRates.get(key);
  if (!rate || now - rate.touched >= REQUEST_RATE_WINDOW) {
    rate = { requests: [], downloads: [], touched: now };
    senderRates.set(key, rate);
  }
  rate.touched = now;
  for (const [name, entry] of senderRates) {
    if (now - entry.touched >= REQUEST_RATE_WINDOW) senderRates.delete(name);
  }
  if (senderRates.size > 128) senderRates.delete(senderRates.keys().next().value);
  return takeRate(rate.requests, REQUESTS_PER_WINDOW, now)
    && (type !== 'download' || takeRate(rate.downloads, DOWNLOADS_PER_WINDOW, now));
}

function onlyKeys(value, names) {
  return isStorageRecord(value) && Object.keys(value).every((name) => names.includes(name));
}

// Custom CSS takes 50,000 characters, the longest text setting.
function primitiveSetting(value) {
  return typeof value === 'boolean'
    || (typeof value === 'string' && value.length <= 65536)
    || Number.isFinite(value);
}

function settingsRecord(value) {
  return isStorageRecord(value)
    && Object.keys(value).length <= 256
    && Object.entries(value).every(([name, setting]) => SAFE_FIELD.test(name) && primitiveSetting(setting));
}

function migrationReceipt(value) {
  return Array.isArray(value)
    && value.length <= 128
    && value.every((id) => typeof id === 'string' && MIGRATION_ID.test(id));
}

function conditionsRecord(value) {
  return value === undefined || (
    isStorageRecord(value)
    && Object.keys(value).length <= 256
    && Object.entries(value).every(([name, condition]) => (
      SAFE_FIELD.test(name)
      && isStorageRecord(condition)
      && Object.keys(condition).every((field) => field === 'exists' || field === 'value')
      && typeof condition.exists === 'boolean'
      && (!condition.exists || primitiveSetting(condition.value))
    ))
  );
}

function settingsMutation(mutation) {
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
    && (!isStorageRecord(mutation.migrationOwners) || Object.entries(mutation.migrationOwners).some(([name, id]) => !SAFE_FIELD.test(name) || !MIGRATION_ID.test(id)))
  ) return false;
  return utf8Bytes(mutation) <= VALUE_MAX_BYTES;
}

function receiptMutation(mutation) {
  return onlyKeys(mutation, ['union'])
    && migrationReceipt(mutation.union)
    && utf8Bytes(mutation) <= VALUE_MAX_BYTES;
}

function validWorkerRequest(message) {
  if (!isStorageRecord(message) || utf8Bytes(message, MESSAGE_MAX_BYTES) > MESSAGE_MAX_BYTES) return false;
  if (message.type === 'storage:recover') return onlyKeys(message, ['type']);
  if (message.type === 'storage:mutate') {
    if (!onlyKeys(message, ['type', 'key', 'mutation', 'generation', 'baseRevisions']) || !PREFERENCE_KEY.test(message.key)) return false;
    return message.key.endsWith('.migrated') ? receiptMutation(message.mutation) : settingsMutation(message.mutation);
  }
  if (message.type === 'storage:migrate') {
    if (!onlyKeys(message, ['type', 'key', 'doneKey', 'mutation', 'receipt', 'sourceKey', 'sourceDoneKey', 'generation', 'baseRevisions'])) return false;
    if (!SETTINGS_KEY.test(message.key) || message.doneKey !== `${message.key}.migrated`) return false;
    if (!settingsMutation(message.mutation) || !migrationReceipt(message.receipt)) return false;
    if (message.key === 'settings') return message.sourceKey == null && message.sourceDoneKey == null;
    return message.sourceKey === 'settings' && message.sourceDoneKey === 'settings.migrated';
  }
  if (message.type === 'download') {
    return onlyKeys(message, ['type', 'url', 'name'])
      && typeof message.url === 'string'
      && message.url.length > 0
      && message.url.length <= 8192
      && validFilename(message.name);
  }
  return false;
}

function validStorageRevisions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const epoch = value[STORAGE_REVISION_EPOCH_KEY];
  const order = value[STORAGE_REVISION_ORDER_KEY];
  if (typeof epoch !== 'string' || !epoch || !Number.isSafeInteger(order) || order < 0) return false;
  return Object.entries(value).every(([name, revision]) => (
    name === STORAGE_REVISION_EPOCH_KEY
      ? typeof revision === 'string' && revision.length > 0
      : name === STORAGE_REVISION_ORDER_KEY
        ? Number.isSafeInteger(revision) && revision >= 0
        : Number.isSafeInteger(revision) && revision >= 0 && revision <= order
  ));
}

function sameStorageRevisions(left, right) {
  if (left === undefined || right === undefined) return left === right;
  try {
    const names = (value) => Object.keys(value).sort().map((name) => [name, value[name]]);
    return JSON.stringify(names(left)) === JSON.stringify(names(right));
  } catch {
    return false;
  }
}

function sameStorageValue(left, right) {
  if (left === undefined || right === undefined) return left === right;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function isStorageRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function loadPendingDirectRecoveries() {
  if (pendingDirectRecoveriesLoad) return pendingDirectRecoveriesLoad;
  pendingDirectRecoveriesLoad = (async () => {
    if (!chrome.storage.session?.get) return;
    const saved = await chrome.storage.session.get(PENDING_RECOVERY_KEY);
    const record = saved?.[PENDING_RECOVERY_KEY];
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    for (const [key, entry] of Object.entries(record)) {
      if (
        !PREFERENCE_KEY.test(key)
        || !entry
        || typeof entry !== 'object'
        || Array.isArray(entry)
        || !entry.mutation
        || typeof entry.mutation !== 'object'
        || Array.isArray(entry.mutation)
      ) continue;
      pendingDirectRecoveries.set(key, {
        expected: entry.missing === true ? undefined : structuredClone(entry.expected),
        mutation: structuredClone(entry.mutation),
      });
    }
  })().catch((error) => {
    pendingDirectRecoveriesLoad = null;
    throw error;
  });
  return pendingDirectRecoveriesLoad;
}

async function persistPendingDirectRecoveries() {
  if (!chrome.storage.session?.set) return;
  const record = {};
  for (const [key, entry] of pendingDirectRecoveries) {
    record[key] = {
      missing: entry.expected === undefined,
      expected: entry.expected === undefined ? null : structuredClone(entry.expected),
      mutation: structuredClone(entry.mutation),
    };
  }
  await chrome.storage.session.set({ [PENDING_RECOVERY_KEY]: record });
}

async function rememberDirectRecovery(key, expected, mutation) {
  if (!PREFERENCE_KEY.test(key) || !mutation) return;
  await loadPendingDirectRecoveries();
  await replayDeferredDirectChanges();
  const previous = pendingDirectRecoveries.get(key);
  const retainedMutation = Object.hasOwn(mutation, 'union') && Object.hasOwn(previous?.mutation ?? {}, 'union')
    ? { union: [...new Set([...previous.mutation.union, ...mutation.union])] }
    : structuredClone(mutation);
  pendingDirectRecoveries.set(key, {
    expected: structuredClone(expected),
    mutation: retainedMutation,
  });
  await persistPendingDirectRecoveries();
}

async function pendingRecoveryFor(key, current) {
  await loadPendingDirectRecoveries();
  await replayDeferredDirectChanges();
  const recovery = pendingDirectRecoveries.get(key);
  if (!recovery) return { value: current, recovery: null };
  if (!Object.hasOwn(recovery.mutation, 'union') && !sameStorageValue(current, recovery.expected)) {
    pendingDirectRecoveries.delete(key);
    try {
      await persistPendingDirectRecoveries();
    } catch (error) {
      pendingDirectRecoveries.set(key, recovery);
      throw error;
    }
    return { value: current, recovery: null };
  }
  if (recovery.mutation.removeRecord === true) {
    return { value: undefined, recovery, removed: true };
  }
  const mutation = Object.hasOwn(recovery.mutation, 'union')
    ? structuredClone(recovery.mutation)
    : { ...structuredClone(recovery.mutation), expected: structuredClone(recovery.expected) };
  return { value: applyStorageMutation(current, mutation), recovery, removed: false };
}

async function finishDirectRecovery(key, recovery) {
  if (!recovery || pendingDirectRecoveries.get(key) !== recovery) return;
  pendingDirectRecoveries.delete(key);
  try {
    await persistPendingDirectRecoveries();
  } catch (error) {
    pendingDirectRecoveries.set(key, recovery);
    throw error;
  }
}

function storageRevisionsRegressed(current, base) {
  if (!validStorageRevisions(current) || !validStorageRevisions(base)) return false;
  if (current[STORAGE_REVISION_EPOCH_KEY] !== base[STORAGE_REVISION_EPOCH_KEY]) return false;
  if (current[STORAGE_REVISION_ORDER_KEY] < base[STORAGE_REVISION_ORDER_KEY]) return true;
  return Object.entries(base).some(([name, revision]) => (
    name !== STORAGE_REVISION_EPOCH_KEY
    && name !== STORAGE_REVISION_ORDER_KEY
    && (!Number.isSafeInteger(current[name]) || current[name] < revision)
  ));
}

function applyStorageMutation(current, mutation) {
  if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) throw new TypeError('invalid storage mutation');
  for (const conditions of [mutation.conditions, mutation.guard]) {
    if (conditions !== undefined && (!conditions || typeof conditions !== 'object' || Array.isArray(conditions))) {
      throw new TypeError('invalid storage conditions');
    }
    for (const condition of Object.values(conditions ?? {})) {
      if (!condition || typeof condition !== 'object' || Array.isArray(condition) || typeof condition.exists !== 'boolean') {
        throw new TypeError('invalid storage condition');
      }
    }
  }
  if (mutation.guarded !== undefined && (!Array.isArray(mutation.guarded) || mutation.guarded.some((name) => typeof name !== 'string'))) {
    throw new TypeError('invalid guarded storage fields');
  }
  if (
    mutation.migrationOwners !== undefined
    && (
      !mutation.migrationOwners
      || typeof mutation.migrationOwners !== 'object'
      || Array.isArray(mutation.migrationOwners)
      || Object.values(mutation.migrationOwners).some((id) => typeof id !== 'string')
    )
  ) throw new TypeError('invalid migration field owners');
  if (Object.hasOwn(mutation, 'expected') && !sameStorageValue(current, mutation.expected)) {
    return structuredClone(current);
  }
  const replacement = Object.hasOwn(mutation, 'replace');
  if (replacement) return structuredClone(mutation.replace);
  if (Object.hasOwn(mutation, 'union')) {
    if (!Array.isArray(mutation.union) || mutation.union.some((id) => typeof id !== 'string')) {
      throw new TypeError('union mutations require string ids');
    }
    const existing = Array.isArray(current) ? current.filter((id) => typeof id === 'string') : [];
    return [...new Set([...structuredClone(existing), ...structuredClone(mutation.union)])];
  }
  if (
    mutation.initialize !== undefined
    && (!mutation.initialize || typeof mutation.initialize !== 'object' || Array.isArray(mutation.initialize))
  ) throw new TypeError('invalid initial storage fields');
  const source = current === undefined && Object.hasOwn(mutation, 'initialize') ? mutation.initialize : current ?? {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError('storage records must be objects');
  const next = structuredClone(source);
  if (mutation.set !== undefined && (!mutation.set || typeof mutation.set !== 'object' || Array.isArray(mutation.set))) throw new TypeError('invalid storage fields');
  if (mutation.remove !== undefined && (!Array.isArray(mutation.remove) || mutation.remove.some((name) => typeof name !== 'string'))) throw new TypeError('invalid removed fields');
  const allowed = (name) => {
    const condition = mutation.conditions?.[name];
    if (!condition) return true;
    const exists = Object.hasOwn(source, name);
    return exists === condition.exists && (!exists || sameStorageValue(source[name], condition.value));
  };
  for (const name of mutation.remove ?? []) {
    if (allowed(name)) delete next[name];
  }
  for (const [name, value] of Object.entries(mutation.set ?? {})) {
    if (allowed(name)) next[name] = structuredClone(value);
  }
  return next;
}

function withoutConditionalFields(mutation) {
  const conditional = new Set(Object.keys(mutation?.conditions ?? {}));
  if (!conditional.size) return mutation;
  const set = Object.fromEntries(Object.entries(mutation.set ?? {}).filter(([name]) => !conditional.has(name)));
  const remove = (mutation.remove ?? []).filter((name) => !conditional.has(name));
  return {
    ...(Object.hasOwn(mutation, 'initialize') ? { initialize: structuredClone(mutation.initialize) } : {}),
    set,
    remove,
  };
}

function withoutCompletedMigrationFields(mutation, pending) {
  const owners = mutation?.migrationOwners;
  if (!owners || typeof owners !== 'object' || Array.isArray(owners)) return mutation;
  const completed = Object.entries(owners)
    .filter(([, migration]) => !pending.includes(migration))
    .map(([name]) => name);
  if (!completed.length) return mutation;
  const next = structuredClone(mutation);
  for (const name of completed) {
    if (next.set) delete next.set[name];
    if (next.conditions) delete next.conditions[name];
    if (next.migrationOwners) delete next.migrationOwners[name];
  }
  if (next.remove) next.remove = next.remove.filter((name) => !completed.includes(name));
  if (next.guarded) next.guarded = next.guarded.filter((name) => !completed.includes(name));
  return next;
}

function storageConditionsMatch(current, conditions) {
  const source = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  return Object.entries(conditions ?? {}).every(([name, condition]) => {
    const exists = Object.hasOwn(source, name);
    return exists === condition.exists && (!exists || sameStorageValue(source[name], condition.value));
  });
}

function nextStorageRevision(saved, keys, generation, baseRevisions) {
  const storedRevisions = saved[STORAGE_REVISIONS_KEY];
  const storedValid = validStorageRevisions(storedRevisions);
  const requestedGeneration = typeof generation === 'string' && generation ? generation : null;
  const resetMatchesStorage = requestedGeneration
    && requestedGeneration !== storedRevisions?.[STORAGE_REVISION_EPOCH_KEY]
    && sameStorageRevisions(storedRevisions, baseRevisions);
  const resetPrecededRequest = storageRevisionsRegressed(storedRevisions, baseRevisions);
  const overflowed = storedValid && storedRevisions[STORAGE_REVISION_ORDER_KEY] >= Number.MAX_SAFE_INTEGER;
  const continuing = storedValid && !overflowed && !resetMatchesStorage && !resetPrecededRequest;
  const epoch = continuing
    ? storedRevisions[STORAGE_REVISION_EPOCH_KEY]
    : resetMatchesStorage ? requestedGeneration : crypto.randomUUID();
  const revisions = continuing ? structuredClone(storedRevisions) : {
    [STORAGE_REVISION_EPOCH_KEY]: epoch,
    [STORAGE_REVISION_ORDER_KEY]: 0,
  };
  const order = revisions[STORAGE_REVISION_ORDER_KEY] + 1;
  revisions[STORAGE_REVISION_ORDER_KEY] = order;
  for (const key of keys) revisions[key] = order;
  return { epoch, order, revisions };
}

async function writeStorageCommit(values, revisions) {
  const expected = { values: structuredClone(values), revisions: structuredClone(revisions) };
  pendingStorageWrites.push(expected);
  if (pendingStorageWrites.length > 64) pendingStorageWrites.splice(0, pendingStorageWrites.length - 64);
  try {
    await chrome.storage.local.set({ ...values, [STORAGE_REVISIONS_KEY]: revisions });
  } catch (error) {
    const index = pendingStorageWrites.indexOf(expected);
    if (index >= 0) pendingStorageWrites.splice(index, 1);
    throw error;
  }
}

function queueStorageTask(run) {
  const result = storageMutationTail.then(run, run);
  storageMutationTail = result.then(() => undefined, () => undefined);
  return result;
}

// Every tab sends field mutations here. One worker queue makes the read, merge and write order
// authoritative across tabs. Independent fields survive; for one field, the accepted request
// that reaches this queue last wins.
async function commitStorageMutation({ key, mutation, generation = null, baseRevisions }, { recoverPending = true } = {}) {
  const saved = await chrome.storage.local.get([key, STORAGE_REVISIONS_KEY]);
  const recovered = recoverPending
    ? await pendingRecoveryFor(key, saved[key])
    : { value: saved[key], recovery: null, removed: false };
  const malformedPreference = PREFERENCE_KEY.test(key)
    && !key.endsWith('.migrated')
    && recovered.value !== undefined
    && !isStorageRecord(recovered.value);
  const conditionalRecovery = Object.hasOwn(mutation ?? {}, 'expected');
  const current = malformedPreference && !conditionalRecovery ? undefined : recovered.value;
  const previous = structuredClone(current);
  const completedRemoval = mutation?.removeRecord === true && current === undefined;
  if (
    Object.hasOwn(mutation ?? {}, 'expected')
    && !sameStorageValue(current, mutation.expected)
    && !completedRemoval
  ) {
    const revisions = saved[STORAGE_REVISIONS_KEY];
    return {
      value: structuredClone(current),
      previous,
      revision: validStorageRevisions(revisions) ? revisions[key] : null,
      epoch: validStorageRevisions(revisions) ? revisions[STORAGE_REVISION_EPOCH_KEY] : null,
      revisions,
      committed: false,
    };
  }
  if (mutation?.removeRecord === true) {
    if (Object.keys(mutation).some((name) => name !== 'removeRecord' && name !== 'expected')) {
      throw new TypeError('invalid record removal');
    }
    const { epoch, order, revisions } = nextStorageRevision(saved, [key], generation, baseRevisions);
    if (Object.hasOwn(saved, key)) {
      pendingStorageRemovals.add(key);
      try {
        await chrome.storage.local.remove(key);
      } catch (error) {
        pendingStorageRemovals.delete(key);
        throw error;
      }
    }
    await writeStorageCommit({}, revisions);
    await finishDirectRecovery(key, recovered.recovery);
    return { value: undefined, previous, revision: order, epoch, revisions, committed: true };
  }
  const next = applyStorageMutation(current, mutation);
  const { epoch, order, revisions } = nextStorageRevision(saved, [key], generation, baseRevisions);
  // The record and its accepted-order marker change together, so every tab can reject a
  // delayed push or response without guessing from delivery order.
  await writeStorageCommit({ [key]: next }, revisions);
  await finishDirectRecovery(key, recovered.recovery);
  return { value: next, previous, revision: order, epoch, revisions, committed: true };
}

async function commitPendingDirectRecovery(key, { keepOnMismatch = false } = {}) {
  await loadPendingDirectRecoveries();
  await replayDeferredDirectChanges();
  const recovery = pendingDirectRecoveries.get(key);
  if (!recovery) return null;
  const mutation = Object.hasOwn(recovery.mutation, 'union')
    ? structuredClone(recovery.mutation)
    : { ...structuredClone(recovery.mutation), expected: structuredClone(recovery.expected) };
  const result = await commitStorageMutation({ key, mutation }, { recoverPending: false });
  if (result.committed !== false || !keepOnMismatch) await finishDirectRecovery(key, recovery);
  return result;
}

function mutateStorage(request) {
  if (typeof request?.key !== 'string' || !request.key) return Promise.reject(new TypeError('invalid storage key'));
  return queueStorageTask(() => commitStorageMutation(request));
}

function migrateStorage({
  key,
  doneKey,
  mutation,
  receipt,
  sourceKey = null,
  sourceDoneKey = null,
  generation = null,
  baseRevisions,
}) {
  if (typeof key !== 'string' || !key || typeof doneKey !== 'string' || !doneKey) {
    return Promise.reject(new TypeError('invalid migration storage keys'));
  }
  if (!Array.isArray(receipt) || receipt.some((id) => typeof id !== 'string')) {
    return Promise.reject(new TypeError('invalid migration receipt'));
  }
  if (
    (sourceKey !== null && (typeof sourceKey !== 'string' || !sourceKey))
    || (sourceDoneKey !== null && (typeof sourceDoneKey !== 'string' || !sourceDoneKey))
  ) return Promise.reject(new TypeError('invalid migration source keys'));
  const run = async () => {
    let recoveredDependency = false;
    for (const dependency of [...new Set([key, doneKey, sourceKey, sourceDoneKey].filter(Boolean))]) {
      const recovered = await commitPendingDirectRecovery(dependency);
      if (recovered?.committed === true) recoveredDependency = true;
    }
    const saved = await chrome.storage.local.get([
      key,
      doneKey,
      ...(sourceKey ? [sourceKey] : []),
      ...(sourceDoneKey ? [sourceDoneKey] : []),
      STORAGE_REVISIONS_KEY,
    ]);
    const recovered = await pendingRecoveryFor(key, saved[key]);
    const recoveredTarget = recovered.value;
    const targetMissing = saved[key] === undefined
      || recovered.removed === true
      || !isStorageRecord(recoveredTarget);
    const target = targetMissing ? undefined : recoveredTarget;
    const copiesSource = targetMissing && sourceKey && sourceKey !== key;
    const rawSource = copiesSource ? saved[sourceKey] : target;
    const source = isStorageRecord(rawSource) ? rawSource : {};
    const previous = structuredClone(source);
    const targetDone = Array.isArray(saved[doneKey]) ? saved[doneKey].filter((id) => typeof id === 'string') : [];
    const sourceDone = copiesSource && Array.isArray(saved[sourceDoneKey])
      ? saved[sourceDoneKey].filter((id) => typeof id === 'string')
      : [];
    const done = [...new Set([...structuredClone(targetDone), ...structuredClone(sourceDone)])];
    const pending = receipt.filter((id) => !done.includes(id));
    const initializes = targetMissing && Object.hasOwn(mutation ?? {}, 'initialize');
    const filteredMutation = pending.length
      ? withoutCompletedMigrationFields(mutation, pending)
      : withoutConditionalFields(mutation);
    if (pending.length && !storageConditionsMatch(source, filteredMutation?.guard)) {
      const revisions = saved[STORAGE_REVISIONS_KEY];
      return {
        value: source,
        previous,
        receipt: done,
        completedBefore: done,
        revision: validStorageRevisions(revisions) ? revisions[key] : null,
        epoch: validStorageRevisions(revisions) ? revisions[STORAGE_REVISION_EPOCH_KEY] : null,
        revisions,
        committed: false,
        conflict: true,
        copyAll: copiesSource,
      };
    }
    const effectiveMutation = initializes
      ? { ...filteredMutation, initialize: structuredClone(source ?? {}) }
      : filteredMutation;
    const next = applyStorageMutation(target, effectiveMutation);
    const nextDone = [...new Set([...structuredClone(done), ...structuredClone(receipt)])];
    if (!pending.length && sameStorageValue(next, saved[key])) {
      const revisions = saved[STORAGE_REVISIONS_KEY];
      return {
        value: previous,
        previous,
        receipt: done,
        completedBefore: done,
        revision: validStorageRevisions(revisions) ? revisions[key] : null,
        epoch: validStorageRevisions(revisions) ? revisions[STORAGE_REVISION_EPOCH_KEY] : null,
        revisions,
        committed: recoveredDependency,
      };
    }
    const state = nextStorageRevision(saved, [key, doneKey], generation, baseRevisions);
    await writeStorageCommit({ [key]: next, [doneKey]: nextDone }, state.revisions);
    await finishDirectRecovery(key, recovered.recovery);
    return {
      value: next,
      previous,
      receipt: nextDone,
      completedBefore: done,
      revision: state.order,
      epoch: state.epoch,
      revisions: state.revisions,
      committed: true,
    };
  };
  return queueStorageTask(run);
}

function directPreferenceMutation(key, change) {
  if (!/^settings(?:@[a-z0-9]+)?(?:\.migrated)?$/.test(key)) return null;
  if (key.endsWith('.migrated')) {
    const malformedNew = change.newValue !== undefined && (
      !Array.isArray(change.newValue)
      || change.newValue.some((id) => typeof id !== 'string')
    );
    if (change.oldValue === undefined && malformedNew) {
      return { removeRecord: true, expected: structuredClone(change.newValue) };
    }
    const before = Array.isArray(change.oldValue) ? change.oldValue.filter((id) => typeof id === 'string') : [];
    const after = Array.isArray(change.newValue) ? change.newValue.filter((id) => typeof id === 'string') : [];
    if (change.newValue === undefined && before.length === 0) return { removeRecord: true };
    return { union: [...new Set([...structuredClone(before), ...structuredClone(after)])] };
  }
  const before = change.oldValue;
  const after = change.newValue;
  const validBefore = isStorageRecord(before);
  const validAfter = isStorageRecord(after);
  const oldRecord = validBefore ? before : {};
  if (after !== undefined && (!after || typeof after !== 'object' || Array.isArray(after))) {
    if (before === undefined) return { removeRecord: true, expected: structuredClone(after) };
    return { replace: structuredClone(oldRecord), expected: structuredClone(after) };
  }
  if (after === undefined && before !== undefined) return { removeRecord: true };
  const newRecord = validAfter ? after : {};
  const set = {};
  const remove = [];
  for (const [name, value] of Object.entries(newRecord)) {
    if (!Object.hasOwn(oldRecord, name) || !sameStorageValue(oldRecord[name], value)) {
      set[name] = structuredClone(value);
    }
  }
  for (const name of Object.keys(oldRecord)) {
    if (!Object.hasOwn(newRecord, name)) remove.push(name);
  }
  if (Object.keys(set).length || remove.length) return { set, remove };
  return !validBefore && validAfter ? { replace: structuredClone(newRecord) } : null;
}

function applyDirectMutation(current, mutation) {
  if (!mutation) return structuredClone(current);
  if (mutation.removeRecord === true) return undefined;
  if (current === undefined && Array.isArray(mutation.union) && mutation.union.length === 0) return undefined;
  const effective = structuredClone(mutation);
  delete effective.expected;
  return applyStorageMutation(current, effective);
}

function deferredRecordMutation(change, mutation) {
  const beforeRecord = isStorageRecord(change.oldValue);
  const afterRecord = isStorageRecord(change.newValue);
  if (change.newValue !== undefined && !afterRecord) {
    return change.oldValue === undefined ? { removeRecord: true } : null;
  }
  if (
    afterRecord
    && change.oldValue !== undefined
    && !beforeRecord
    && Object.keys(change.newValue).length === 0
  ) return null;
  return mutation ? structuredClone(mutation) : null;
}

function mergeDeferredRecordMutations(previous, next) {
  if (!next) return previous ? structuredClone(previous) : null;
  if (next.removeRecord === true || Object.hasOwn(next, 'replace')) return structuredClone(next);
  if (!previous) return structuredClone(next);
  if (previous.removeRecord === true || Object.hasOwn(previous, 'replace')) {
    const base = previous.removeRecord === true ? undefined : previous.replace;
    const desired = applyDirectMutation(base, next);
    return desired === undefined ? { removeRecord: true } : { replace: structuredClone(desired) };
  }
  const set = structuredClone(previous.set ?? {});
  const remove = new Set(previous.remove ?? []);
  for (const [name, value] of Object.entries(next.set ?? {})) {
    set[name] = structuredClone(value);
    remove.delete(name);
  }
  for (const name of next.remove ?? []) {
    delete set[name];
    remove.add(name);
  }
  return Object.keys(set).length || remove.size ? { set, remove: [...remove] } : null;
}

function deferDirectChange(key, change, mutation, current) {
  const previous = deferredDirectChanges.get(key);
  if (key.endsWith('.migrated')) {
    const deferred = previous?.kind === 'receipt' ? previous : {
      kind: 'receipt',
      firstValue: structuredClone(change.oldValue),
      expected: structuredClone(change.newValue),
      ids: [],
      present: Array.isArray(change.newValue)
        && change.newValue.every((id) => typeof id === 'string'),
      authoritative: false,
    };
    deferred.ids = [...new Set([
      ...deferred.ids,
      ...(Array.isArray(mutation?.union) ? mutation.union : []),
    ])];
    if (!deferred.authoritative || current) {
      deferred.expected = structuredClone(change.newValue);
      deferred.present = Array.isArray(change.newValue)
        && change.newValue.every((id) => typeof id === 'string');
    }
    deferred.authoritative ||= current;
    deferredDirectChanges.set(key, deferred);
    return;
  }

  const step = deferredRecordMutation(change, mutation);
  const contiguous = previous?.kind === 'record'
    && sameStorageValue(previous.lastValue, change.oldValue);
  if (previous?.kind === 'record' && !contiguous && !current) return;
  const deferred = previous?.kind === 'record' && contiguous ? previous : {
    kind: 'record',
    firstValue: structuredClone(change.oldValue),
    lastValue: structuredClone(change.oldValue),
    mutation: null,
    authoritative: false,
  };
  deferred.lastValue = structuredClone(change.newValue);
  deferred.mutation = mergeDeferredRecordMutations(deferred.mutation, step);
  deferred.authoritative ||= current;
  deferredDirectChanges.set(key, deferred);
}

async function composeDirectRecovery(key, change, mutation, {
  create = false,
  current = false,
  observed,
  loaded = false,
} = {}) {
  if (!loaded) {
    try {
      await loadPendingDirectRecoveries();
      await replayDeferredDirectChanges();
    } catch (error) {
      if (mutation) deferDirectChange(key, change, mutation, current);
      throw error;
    }
  }
  const previous = pendingDirectRecoveries.get(key);
  if (Array.isArray(previous?.mutation?.union)) {
    const incoming = Array.isArray(mutation?.union) ? mutation.union : [];
    const union = [...new Set([...previous.mutation.union, ...incoming])];
    const recovery = union.length === previous.mutation.union.length
      ? previous
      : { expected: structuredClone(change.newValue), mutation: { union: structuredClone(union) } };
    if (recovery !== previous) pendingDirectRecoveries.set(key, recovery);
    if (recovery !== previous) await persistPendingDirectRecoveries();
    return recovery;
  }
  const validReceiptAfter = key.endsWith('.migrated')
    && Array.isArray(change.newValue)
    && change.newValue.every((id) => typeof id === 'string');
  const continues = previous
    && !Object.hasOwn(previous.mutation, 'union')
    && sameStorageValue(change.oldValue, previous.expected);
  if (
    previous
    && !Object.hasOwn(previous.mutation, 'union')
    && !continues
    && Array.isArray(mutation?.union)
  ) {
    if (mutation.union.length === 0) {
      if (!current || !validReceiptAfter) return previous;
      const recovery = {
        expected: structuredClone(observed),
        mutation: { replace: structuredClone(change.newValue) },
      };
      pendingDirectRecoveries.set(key, recovery);
      await persistPendingDirectRecoveries();
      return recovery;
    }
    const base = applyDirectMutation(previous.expected, previous.mutation);
    const desired = applyDirectMutation(base, mutation);
    const recovery = {
      expected: structuredClone(current ? observed : previous.expected),
      mutation: { union: structuredClone(desired) },
    };
    pendingDirectRecoveries.set(key, recovery);
    await persistPendingDirectRecoveries();
    return recovery;
  }
  if (
    previous
    && !Object.hasOwn(previous.mutation, 'union')
    && !continues
    && (!current || sameStorageValue(observed, previous.expected))
  ) return previous;
  if (!continues && !create) return null;
  const base = continues
    ? applyDirectMutation(change.oldValue, previous.mutation)
    : structuredClone(change.oldValue);
  const malformedRecordSuccessor = continues
    && !key.endsWith('.migrated')
    && change.oldValue !== undefined
    && !isStorageRecord(change.oldValue)
    && change.newValue !== undefined
    && (
      !isStorageRecord(change.newValue)
      || Object.keys(change.newValue).length === 0
    );
  const desired = malformedRecordSuccessor
    ? base
    : continues && validReceiptAfter && mutation?.union?.length === 0
      ? structuredClone(change.newValue)
      : applyDirectMutation(base, mutation);
  const recovery = {
    expected: structuredClone(change.newValue),
    mutation: desired === undefined
      ? { removeRecord: true }
      : { replace: structuredClone(desired) },
  };
  pendingDirectRecoveries.set(key, recovery);
  await persistPendingDirectRecoveries();
  return recovery;
}

async function replayDeferredDirectChanges() {
  if (!deferredDirectChanges.size) return;
  for (const [key, deferred] of [...deferredDirectChanges]) {
    const previous = pendingDirectRecoveries.get(key);
    let recovery;
    if (deferred.kind === 'receipt') {
      const ids = new Set(deferred.ids);
      if (previous) {
        const retained = Object.hasOwn(previous.mutation, 'union')
          ? previous.mutation.union
          : applyDirectMutation(previous.expected, previous.mutation);
        if (Array.isArray(retained)) {
          for (const id of retained) if (typeof id === 'string') ids.add(id);
        }
      }
      recovery = ids.size
        ? { expected: structuredClone(deferred.expected), mutation: { union: [...ids] } }
        : deferred.present
          ? { expected: structuredClone(deferred.expected), mutation: { replace: [] } }
          : previous && !deferred.authoritative && !sameStorageValue(deferred.firstValue, previous.expected)
            ? previous
            : { expected: structuredClone(deferred.expected), mutation: { removeRecord: true } };
    } else {
      let base = isStorageRecord(deferred.firstValue)
        ? structuredClone(deferred.firstValue)
        : deferred.firstValue === undefined ? undefined : {};
      if (previous && !Object.hasOwn(previous.mutation, 'union')) {
        if (sameStorageValue(deferred.firstValue, previous.expected)) {
          base = applyDirectMutation(deferred.firstValue, previous.mutation);
        } else if (!deferred.authoritative) {
          deferredDirectChanges.delete(key);
          continue;
        }
      }
      const desired = applyDirectMutation(base, deferred.mutation);
      recovery = {
        expected: structuredClone(deferred.lastValue),
        mutation: desired === undefined
          ? { removeRecord: true }
          : { replace: structuredClone(desired) },
      };
    }
    pendingDirectRecoveries.set(key, recovery);
    deferredDirectChanges.delete(key);
  }
  await persistPendingDirectRecoveries();
}

const pause = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

async function reportDirectStorageFailure(error) {
  const detail = String(error?.message ?? error ?? '') || 'the browser could not verify a storage change';
  console.error('Could not reconcile a direct storage change', error);
  try {
    const tabs = await chrome.tabs.query?.({}) ?? [];
    await Promise.allSettled(tabs.map((tab) => (
      chrome.tabs.sendMessage(tab.id, { type: 'storage-error', error: detail }, { frameId: 0 })
    )));
  } catch {
    // A later page or preference write will retry against the value still in storage.
  }
}

function recoverDirectPreferences() {
  return queueStorageTask(async () => {
    await loadPendingDirectRecoveries();
    await replayDeferredDirectChanges();
    const results = [];
    for (const key of [...pendingDirectRecoveries.keys()]) {
      results.push(await commitPendingDirectRecovery(key));
    }
    return results;
  });
}

async function verifyDirectPreference(key, expected) {
  let lastError;
  for (let attempt = 0; attempt <= DIRECT_STORAGE_RETRY_DELAYS.length; attempt++) {
    let saved;
    try {
      saved = await chrome.storage.local.get([key]);
    } catch (error) {
      lastError = error;
      if (attempt < DIRECT_STORAGE_RETRY_DELAYS.length) {
        await pause(DIRECT_STORAGE_RETRY_DELAYS[attempt]);
        continue;
      }
      throw lastError;
    }
    if (sameStorageValue(saved[key], expected)) return { current: true, value: saved[key] };
    if (lastError) {
      throw new Error('the storage value changed before the direct preference write could be verified', { cause: lastError });
    }
    return { current: false, value: saved[key] };
  }
  throw lastError;
}

function reconcileDirectPreference(key, change) {
  // Start this read while the event's physical value is still current. The worker task reserves
  // its queue position now, then reapplies the verified delta after any older commit finishes.
  const mutation = directPreferenceMutation(key, change);
  const verified = verifyDirectPreference(key, change.newValue);
  return queueStorageTask(async () => {
    let current = false;
    let observed;
    let verificationError = null;
    try {
      const verification = await verified;
      current = verification.current;
      observed = verification.value;
    } catch (error) {
      verificationError = error;
    }
    const monotonic = Object.hasOwn(mutation ?? {}, 'union');
    let chained;
    try {
      chained = await composeDirectRecovery(key, change, mutation, { current, observed });
    } catch (error) {
      await reportDirectStorageFailure(error);
      return;
    }
    if (!mutation && !chained) {
      if (verificationError) await reportDirectStorageFailure(verificationError);
      return;
    }
    if (monotonic && verificationError) {
      if (!chained) {
        try {
          await rememberDirectRecovery(key, change.newValue, mutation);
        } catch (error) {
          verificationError = error;
        }
      }
      await reportDirectStorageFailure(verificationError);
      return;
    }
    if (!current) {
      if (!chained && !monotonic) {
        try {
          await composeDirectRecovery(key, change, mutation, { create: true, current, observed });
        } catch (error) {
          await reportDirectStorageFailure(error);
          return;
        }
      }
      if (verificationError) await reportDirectStorageFailure(verificationError);
      if (!monotonic) return;
    }
    let lastError = verificationError;
    for (let attempt = 0; attempt <= DIRECT_STORAGE_RETRY_DELAYS.length; attempt++) {
      try {
        if (chained) {
          const result = await commitPendingDirectRecovery(key, { keepOnMismatch: true });
          if (result?.committed === false) return;
        } else {
          await commitStorageMutation({ key, mutation });
        }
        return;
      } catch (error) {
        lastError = error;
        if (attempt < DIRECT_STORAGE_RETRY_DELAYS.length) await pause(DIRECT_STORAGE_RETRY_DELAYS[attempt]);
      }
    }
    try {
      if (monotonic) await rememberDirectRecovery(key, change.newValue, mutation);
      else await composeDirectRecovery(key, change, mutation, { create: true, current, observed });
    } catch (error) {
      lastError = error;
    }
    await reportDirectStorageFailure(lastError);
  });
}

chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== 'local') return;
  const visibleChanges = Object.fromEntries(Object.entries(changes).filter(([key, change]) => {
    if (change.newValue !== undefined || !pendingStorageRemovals.delete(key)) return true;
    return false;
  }));
  if (!Object.keys(visibleChanges).length) return;
  const changedRevisions = visibleChanges[STORAGE_REVISIONS_KEY]?.newValue;
  const own = pendingStorageWrites.findIndex((expected) => (
    sameStorageRevisions(expected.revisions, changedRevisions)
    && Object.entries(expected.values).every(([key, value]) => (
      !visibleChanges[key] || sameStorageValue(visibleChanges[key].newValue, value)
    ))
  ));
  if (own >= 0) {
    pendingStorageWrites.splice(own, 1);
    return;
  }
  for (const [key, change] of Object.entries(visibleChanges)) {
    if (!/^settings(?:@[a-z0-9]+)?(?:\.migrated)?$/.test(key)) continue;
    void reconcileDirectPreference(key, change);
  }
});

function hostOf(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function savable(url) {
  const parsed = hostOf(url);
  return parsed?.protocol === 'https:'
    && !parsed.username
    && !parsed.password
    && !parsed.port
    && SAVABLE.test(parsed.hostname);
}

// C0 and C1 control characters, checked by code point rather than as a regex range of them.
const hasControl = (name) => [...name].some((char) => {
  const code = char.codePointAt(0);
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
});

function validFilename(name) {
  if (typeof name !== 'string' || !name || name !== name.normalize('NFC') || utf8Bytes(name, 512) > 512) return false;
  if (name.startsWith('.') || name.startsWith('~') || /[. ]$/.test(name) || !/\.[A-Za-z0-9]{1,10}$/.test(name)) return false;
  if (hasControl(name) || /[\\/:*?"<>|\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/u.test(name)) return false;
  return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

async function save({ url, name }) {
  if (!savable(url)) throw new Error('that address is not a Facebook file');
  if (!validFilename(name)) throw new Error('that file name is not safe');
  // The page cannot prove a remote file's size. chrome.downloads owns and reports the transfer.
  const id = await chrome.downloads.download({ url, filename: name, saveAs: false, conflictAction: 'uniquify' });
  return new Promise((resolve, reject) => {
    const done = (error) => {
      chrome.downloads.onChanged.removeListener(watch);
      clearTimeout(timer);
      if (error) reject(new Error(error));
      else resolve();
    };
    const watch = (delta) => {
      if (delta.id !== id) return;
      if (delta.state?.current === 'complete') done();
      else if (delta.state?.current === 'interrupted') done(delta.error?.current ?? 'the download stopped');
    };
    const timer = setTimeout(() => done(), ANSWER_WITHIN);
    chrome.downloads.onChanged.addListener(watch);
  });
}

const tellTab = (tabId) => chrome.tabs.sendMessage(tabId, { type: 'open-settings' }, { frameId: 0 });

// Opens the panel once the tab has finished loading.
function openWhenLoaded(tabId) {
  const loaded = (id, change) => {
    if (id !== tabId || change.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(loaded);
    tellTab(tabId).catch(() => {});
  };
  chrome.tabs.onUpdated.addListener(loaded);
}

// The toolbar button. On Facebook it opens the panel. A Facebook tab opened before the
// extension was there has no script yet, so it reloads first. Anywhere else, Facebook opens in
// a new tab with the panel up. activeTab lets the click see the tab's address.
async function openSettings(tab) {
  if (!FACEBOOK.includes(hostOf(tab.url)?.hostname)) {
    const opened = await chrome.tabs.create({ url: 'https://www.facebook.com/', index: tab.index + 1 });
    openWhenLoaded(opened.id);
    return 'new tab';
  }
  try {
    await tellTab(tab.id);
    return 'opened';
  } catch {
    openWhenLoaded(tab.id);
    await chrome.tabs.reload(tab.id);
    return 'reloaded';
  }
}

// A loaded-unpacked extension never updates itself, so once a day the worker asks GitHub for
// the latest release (api.github.com allows any origin, so no host permission). A newer one
// lights the toolbar badge, and the page shows a notice in General from the saved record
// (src/core/extension.js reads UPDATE_KEY). Offline or rate limited, it tries again the next day.
const RELEASES = 'https://api.github.com/repos/SysAdminDoc/HushFacebookWeb/releases/latest';
const UPDATE_KEY = 'extensionUpdate';
const DAY = 24 * 60 * 60 * 1000;

function isNewer(candidate, current) {
  const a = String(candidate).split('.').map(Number);
  const b = String(current).split('.').map(Number);
  if (a.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

async function checkForUpdate(now = Date.now()) {
  const current = chrome.runtime.getManifest().version;
  const { [UPDATE_KEY]: last } = await chrome.storage.local.get(UPDATE_KEY);
  let record = last;
  if (!(last?.at && now - last.at >= 0 && now - last.at < DAY && last.current === current)) {
    record = { at: now, current, latest: last?.latest ?? null, url: last?.url ?? null };
    try {
      const response = await fetch(RELEASES, { headers: { accept: 'application/vnd.github+json' }, cache: 'no-store' });
      if (response.ok) {
        const release = await response.json();
        const tag = String(release.tag_name ?? '').replace(/^v/, '');
        if (/^\d+(\.\d+)*$/.test(tag)) record = { ...record, latest: tag, url: String(release.html_url ?? '') || null };
      }
    } catch {
      // Offline. The record's time means the next try is tomorrow.
    }
    record.newer = Boolean(record.latest && isNewer(record.latest, current));
    await chrome.storage.local.set({ [UPDATE_KEY]: record });
  }
  await chrome.action.setBadgeText({ text: record.newer ? 'NEW' : '' });
  if (record.newer) await chrome.action.setBadgeBackgroundColor({ color: '#9D70EB' });
  return record;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'update-check') checkForUpdate();
});
chrome.alarms.get('update-check').then((alarm) => {
  if (!alarm) chrome.alarms.create('update-check', { delayInMinutes: 1, periodInMinutes: 360 });
});

// Only Facebook's top frame talks to the worker, with a known request shape, at a bounded rate.
// The isolated script checks the same things first; this holds even if a page gets past it.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!sender?.tab) return false;
  if (!trustedSender(sender)) {
    respond({ ok: false, error: 'that page cannot ask the extension for this' });
    return false;
  }
  if (!validWorkerRequest(message)) {
    respond({ ok: false, error: 'that extension request is not allowed' });
    return false;
  }
  if (!senderAllowedNow(sender, message.type)) {
    respond({ ok: false, error: 'too many extension requests were sent' });
    return false;
  }
  const task = message?.type === 'download'
    ? save(message)
    : message?.type === 'storage:mutate'
      ? mutateStorage(message)
      : message?.type === 'storage:migrate'
        ? migrateStorage(message)
        : message?.type === 'storage:recover'
          ? recoverDirectPreferences()
      : null;
  if (!task) return false;
  task.then(
    (result) => respond({ ok: true, result: result ?? null }),
    (error) => respond({ ok: false, error: String(error?.message ?? error) }),
  );
  return true;
});

chrome.action.onClicked.addListener((tab) => {
  openSettings(tab);
});
