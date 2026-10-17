// Settings built from the feature list. Only values that differ from their default are
// stored, so changing a default in a later version reaches everyone who never touched it.
//
// Each Facebook account keeps its own settings, the way Social Fixer and F.B. Purity do it,
// under a key made from the account's id (the c_user cookie). The id itself isn't stored.
// An account seen for the first time starts from the settings everyone shared before, so
// nothing is lost on upgrade. Signed out, the shared settings are used.

const STORAGE_KEY = 'settings';
const REMOVED = Symbol('removed');
export const EXPORT_SCHEMA = 1;
export const MAX_BACKUP_BYTES = 1024 * 1024;
const isPromise = (value) => value && typeof value.then === 'function';
const isSettingsRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function accountFromCookie(cookie) {
  return /(?:^|;\s*)c_user=(\d+)(?:;|$)/.exec(String(cookie ?? ''))?.[1] ?? null;
}

// FNV-1a, enough to tell a few accounts apart without writing their ids down.
export function storageKeyFor(account) {
  if (!account) return STORAGE_KEY;
  let hash = 0x811c9dc5;
  for (const char of String(account)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${STORAGE_KEY}@${hash.toString(36)}`;
}

// One-time changes to stored settings. Each runs once for each settings key, recorded under a
// key of its own, so a later change by hand is left alone. An import of an export made before
// the version in `before` gets the same change.
export const MIGRATIONS = [
  {
    // In v0.0.1 Hide sponsored posts also took the ads out of search and Marketplace. Someone
    // who had it off keeps those ads now that each place has its own switch.
    id: 'split-ad-switch',
    before: '0.0.2',
    run(raw) {
      if (raw.hideSponsoredPosts !== false) return;
      for (const key of ['hideSponsoredSearch', 'hideSponsoredMarketplace']) {
        if (!Object.hasOwn(raw, key)) raw[key] = false;
      }
    },
  },
];

export function olderThan(version, before) {
  const parts = (text) => /^(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''))?.slice(1).map(Number);
  const a = parts(version);
  const b = parts(before);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

const GLOBAL_SETTINGS = [
  { key: 'paused', type: 'toggle', default: false, label: 'Pause HushFacebook Web' },
  { key: 'ui.launcher', type: 'toggle', default: true, label: 'Show the settings button on Facebook' },
  { key: 'ui.hiddenNote', type: 'toggle', default: false, label: 'Leave a note where a post was hidden' },
];

export function buildSchema(features) {
  const schema = new Map();
  const add = (spec) => {
    if (schema.has(spec.key)) throw new Error(`Duplicate setting key: ${spec.key}`);
    schema.set(spec.key, spec);
  };
  for (const spec of GLOBAL_SETTINGS) add(spec);
  for (const feature of features) {
    add({ key: feature.id, type: 'toggle', default: feature.default === true, label: feature.title, featureId: feature.id });
    for (const option of feature.options ?? []) {
      add({ ...option, key: `${feature.id}.${option.key}`, featureId: feature.id });
    }
  }
  return schema;
}

export function isValid(spec, value) {
  switch (spec.type) {
    case 'toggle':
      return typeof value === 'boolean';
    case 'select':
      return spec.choices.some((choice) => choice.value === value);
    case 'text':
      return typeof value === 'string' && value.length <= (spec.maxLength ?? 20000);
    case 'number':
      return Number.isFinite(value) && value >= (spec.min ?? -Infinity) && value <= (spec.max ?? Infinity);
    default:
      return false;
  }
}

export function createSettings({ storage, features, log, version = 'dev', account = null, migrations = MIGRATIONS }) {
  const schema = buildSchema(features);
  const listeners = new Set();
  const key = storageKeyFor(account);
  const doneKey = `${key}.migrated`;
  // The extension's storage fills a few milliseconds in (whenReady). Until then every setting
  // is at its default, and loading, copying and migrating wait so they see what's really saved.
  let ready = !storage.whenReady;
  let managerCopyRetry = null;
  let values = ready ? loadManagerSettings() : {};
  let pageLoadValues = ready ? structuredClone(values) : {};
  const drafts = new Map(managerCopyRetry?.drafts ?? []);
  const saveListeners = new Set();
  let saveState = 'idle';
  let saveError = null;
  let replacePending = false;
  let activeSave = null;
  let queuedWaiters = [];
  let pendingInternal = managerCopyRetry;
  let valueGeneration = 0;
  let reinitializeAccountOnWrite = false;
  let accountDeletionGeneration = -1;

  function read(get) {
    const own = get(key, undefined);
    if (key === STORAGE_KEY) return isSettingsRecord(own) ? own : {};
    if (isSettingsRecord(own)) return own;
    return sanitize(get(STORAGE_KEY, {}));
  }

  function migrationResult(raw, stored) {
    const done = Array.isArray(stored)
      ? [...new Set(stored.filter((id) => typeof id === 'string'))]
      : [];
    const original = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const before = sanitize(original);
    const pending = migrations.filter((migration) => !done.includes(migration.id));
    if (!pending.length) return { original, before, after: before, done, pending, owners: {} };
    const next = { ...original };
    const owners = {};
    let previous = before;
    for (const migration of pending) {
      migration.run(next);
      const current = sanitize(next);
      for (const name of schema.keys()) {
        const previousHas = Object.hasOwn(previous, name);
        const currentHas = Object.hasOwn(current, name);
        if (
          previousHas !== currentHas
          || (previousHas && JSON.stringify(previous[name]) !== JSON.stringify(current[name]))
        ) owners[name] = migration.id;
      }
      previous = current;
    }
    return { original, before, after: sanitize(next), done, pending, owners };
  }

  function migrationRecord(get) {
    const own = get(doneKey, undefined);
    const cleanOwn = Array.isArray(own) ? [...new Set(own.filter((id) => typeof id === 'string'))] : own;
    if (key === STORAGE_KEY || get(key, undefined) !== undefined) return cleanOwn;
    const shared = get(`${STORAGE_KEY}.migrated`, undefined);
    if (Array.isArray(own) || Array.isArray(shared)) {
      return [...new Set([
        ...(Array.isArray(cleanOwn) ? cleanOwn : []),
        ...(Array.isArray(shared) ? shared.filter((id) => typeof id === 'string') : []),
      ])];
    }
    return cleanOwn ?? shared;
  }

  function persistMigrationReceipt(receipt) {
    if (!receipt) return undefined;
    return storage.mutate
      ? storage.mutate(doneKey, { union: structuredClone(receipt) })
      : storage.set(doneKey, receipt);
  }

  function migrationDraftEntries(before, after) {
    const entries = [];
    for (const name of schema.keys()) {
      const beforeHas = Object.hasOwn(before, name);
      const afterHas = Object.hasOwn(after, name);
      if (beforeHas === afterHas && (!beforeHas || JSON.stringify(before[name]) === JSON.stringify(after[name]))) continue;
      entries.push([name, afterHas ? structuredClone(after[name]) : REMOVED]);
    }
    return entries;
  }

  function persistRecordMutation(mutation, message, onSaved) {
    const saved = () => onSaved?.();
    try {
      if (storage.mutate) {
        const result = storage.mutate(key, mutation);
        if (isPromise(result)) {
          const completed = result.then(saved);
          completed.catch((error) => log?.error(message, error));
          return completed;
        }
        const receipt = saved();
        if (isPromise(receipt)) {
          receipt.catch((error) => log?.error(message, error));
          return receipt;
        }
        return true;
      }
      const current = storage.get(key, {});
      const next = Object.hasOwn(mutation, 'replace') ? { ...mutation.replace } : { ...current, ...mutation.set };
      for (const name of mutation.remove ?? []) delete next[name];
      storage.set(key, next);
      const receipt = saved();
      if (isPromise(receipt)) {
        receipt.catch((error) => log?.error(message, error));
        return receipt;
      }
      return true;
    } catch (error) {
      log?.error(message, error);
      return false;
    }
  }

  function saveMigration({ original, before, after, done, pending }, valuesToSave = after, forceValues = false) {
    if (!pending.length && !forceValues) return { saved: true, retry: null };
    const set = {};
    for (const [name, value] of Object.entries(valuesToSave)) {
      if (forceValues || !Object.hasOwn(before, name) || JSON.stringify(before[name]) !== JSON.stringify(value)) set[name] = value;
    }
    const remove = Object.keys(original).filter((name) => !Object.hasOwn(valuesToSave, name));
    const saveReceipt = () => {
      if (pending.length) return persistMigrationReceipt([...done, ...pending.map((migration) => migration.id)]);
      return undefined;
    };
    const retry = { mutation: { set, remove }, onSaved: saveReceipt };
    if (Object.keys(set).length || remove.length) {
      return { saved: persistRecordMutation(retry.mutation, 'Could not save a settings update', saveReceipt), retry };
    } else {
      try {
        const receipt = saveReceipt();
        if (isPromise(receipt)) {
          receipt.catch((error) => log?.error('Could not save a settings update', error));
          return { saved: receipt, retry };
        }
        return { saved: true, retry };
      } catch (error) {
        log?.error('Could not save a settings update', error);
        return { saved: false, retry };
      }
    }
  }

  function loadManagerSettings() {
    const inheritedShared = key !== STORAGE_KEY && storage.get(key, undefined) === undefined;
    const storedMigrations = migrationRecord(storage.get);
    const migration = migrationResult(read(storage.get), storedMigrations);
    if (!inheritedShared) {
      const { saved, retry } = saveMigration(migration);
      if (saved === false) {
        const migrationDrafts = migrationDraftEntries(migration.before, migration.after);
        managerCopyRetry = { ...retry, fields: migrationDrafts.map(([name]) => name), drafts: migrationDrafts };
      }
      return saved === false || isPromise(saved) ? migration.before : migration.after;
    }

    const receipt = migration.pending.length
      ? [...migration.done, ...migration.pending.map((item) => item.id)]
      : Array.isArray(storedMigrations) ? storedMigrations : null;
    const saveReceipt = () => {
      if (receipt) return persistMigrationReceipt(receipt);
      return undefined;
    };
    let saved;
    const mutation = { replace: migration.after };
    saved = persistRecordMutation(mutation, 'Could not copy your settings to this account', saveReceipt);
    if (saved === false) {
      const migrationDrafts = migrationDraftEntries(migration.before, migration.after);
      managerCopyRetry = {
        mutation,
        onSaved: saveReceipt,
        fields: migrationDrafts.map(([name]) => name),
        drafts: migrationDrafts,
      };
    }
    return saved === false || isPromise(saved) ? migration.before : migration.after;
  }

  function stageMigration(migration, { copyAll = false, receipt = null } = {}) {
    if (!migration.pending.length && !copyAll) return;
    const changed = new Set([...schema.keys()].filter((name) => (
      !sameValue(savedValue(migration.after, name), savedValue(migration.before, name))
    )));
    const set = {};
    const remove = Object.keys(migration.original).filter((name) => !Object.hasOwn(migration.after, name) && !changed.has(name));
    const conditions = {};
    const guard = {};
    const guarded = [];
    const migrationOwners = {};
    const migrationValues = {};
    const migrationValueOwners = {};
    const rawCondition = (name) => (Object.hasOwn(migration.original, name)
      ? { exists: true, value: structuredClone(migration.original[name]) }
      : { exists: false });
    for (const name of schema.keys()) {
      if (drafts.has(name) && !replacePending) continue;
      guard[name] = rawCondition(name);
    }
    for (const name of changed) {
      const after = savedValue(migration.after, name);
      if (!drafts.has(name)) {
        conditions[name] = rawCondition(name);
        guarded.push(name);
        if (migration.owners?.[name]) migrationOwners[name] = migration.owners[name];
      }
      if (!drafts.has(name) || replacePending) {
        migrationValues[name] = after === REMOVED
          ? { exists: false }
          : { exists: true, value: structuredClone(after) };
        if (migration.owners?.[name]) migrationValueOwners[name] = migration.owners[name];
      }
    }
    const onSaved = () => {
      if (receipt) return persistMigrationReceipt(receipt);
      return undefined;
    };
    if (!copyAll && !migration.pending.length && !changed.size && !Object.keys(set).length && !remove.length) {
      try {
        onSaved();
      } catch (error) {
        log?.error(copyAll ? 'Could not copy your settings to this account' : 'Could not save a settings update', error);
      }
      return;
    }
    pendingInternal = {
      mutation: {
        ...(copyAll ? { initialize: structuredClone(migration.before) } : {}),
        set,
        remove,
        conditions,
        guard,
        guarded,
        migrationOwners,
      },
      onSaved,
      receipt,
      fields: guarded,
      migrationValues,
      migrationValueOwners,
      copyAll,
      sourceKey: copyAll ? STORAGE_KEY : null,
      sourceDoneKey: copyAll ? `${STORAGE_KEY}.migrated` : null,
    };
    for (const name of changed) {
      const wanted = savedValue(migration.after, name);
      if (!drafts.has(name)) {
        drafts.set(name, wanted === REMOVED ? REMOVED : structuredClone(wanted));
      }
    }
  }

  function stageAccountReinitialization() {
    if (
      !reinitializeAccountOnWrite
      || pendingInternal?.copyAll
      || activeSave?.internal?.copyAll
    ) return;
    if (isSettingsRecord(storage.get(key, undefined))) {
      reinitializeAccountOnWrite = false;
      return;
    }
    const storedMigrations = migrationRecord(storage.get);
    const migration = migrationResult(read(storage.get), storedMigrations);
    const receipt = migration.pending.length
      ? [...migration.done, ...migration.pending.map((item) => item.id)]
      : Array.isArray(storedMigrations) ? storedMigrations : null;
    stageMigration(migration, { copyAll: true, receipt });
  }

  function loadSavedSettings() {
    ready = true;
    if (storage.getAtLoad) {
      const get = (name, fallback) => storage.getAtLoad(name, fallback);
      const inheritedShared = key !== STORAGE_KEY && get(key, undefined) === undefined;
      const storedMigrations = migrationRecord(get);
      const migration = migrationResult(read(get), storedMigrations);
      values = { ...migration.before };
      pageLoadValues = structuredClone(values);
      const receipt = migration.pending.length
        ? [...migration.done, ...migration.pending.map((item) => item.id)]
        : inheritedShared && Array.isArray(storedMigrations) ? storedMigrations : null;
      stageMigration(migration, { copyAll: inheritedShared, receipt });
    } else {
      values = loadManagerSettings();
      if (managerCopyRetry) pendingInternal = managerCopyRetry;
      pageLoadValues = structuredClone(values);
    }
    notify([...schema.keys()], true);
    flush();
  }

  function sanitize(raw) {
    const clean = {};
    if (!raw || typeof raw !== 'object') return clean;
    for (const [key, value] of Object.entries(raw)) {
      const spec = schema.get(key);
      if (spec && isValid(spec, value) && value !== spec.default) clean[key] = value;
    }
    return clean;
  }

  const savedValue = (record, name) => (Object.hasOwn(record, name) ? record[name] : REMOVED);
  const sameValue = (a, b) => a === REMOVED ? b === REMOVED : b !== REMOVED && JSON.stringify(a) === JSON.stringify(b);
  const shownValue = (name) => {
    const draft = drafts.get(name);
    return drafts.has(name) ? (draft === REMOVED ? spec(name).default : draft) : get(name);
  };
  const pendingKeys = () => [...drafts.keys()];
  const saveStatus = () => ({ state: saveState, error: saveError, pending: pendingKeys() });
  const tellSaveStatus = (listener) => {
    try {
      listener(saveStatus());
    } catch (error) {
      log?.error('A settings save listener failed', error);
    }
  };
  const setSaveStatus = (state, error = null) => {
    saveState = state;
    saveError = error;
    for (const listener of saveListeners) tellSaveStatus(listener);
  };
  const makeWaiter = ({ returnPrevious = false, fallbackPrevious } = {}) => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return {
      promise,
      resolve,
      reject,
      pending: true,
      exposed: false,
      returnPrevious,
      fallbackPrevious,
      value: undefined,
    };
  };
  const resolveWaiters = (waiters, previous) => {
    for (const waiter of waiters) {
      waiter.pending = false;
      waiter.value = waiter.returnPrevious
        ? sanitize(previous === undefined ? waiter.fallbackPrevious : previous)
        : undefined;
      waiter.resolve(waiter.value);
    }
  };
  const migrationPrevious = (raw, internal, completedBefore) => {
    if (!internal?.migrationValues || !Object.keys(internal.migrationValues).length) return raw;
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const guardMatches = Object.entries(internal.mutation?.guard ?? {}).every(([name, condition]) => {
      const exists = Object.hasOwn(source, name);
      return exists === condition.exists && (!exists || sameValue(source[name], condition.value));
    });
    if (!guardMatches) return raw;
    const next = sanitize(source);
    const completed = new Set(Array.isArray(completedBefore) ? completedBefore : []);
    for (const [name, wanted] of Object.entries(internal.migrationValues)) {
      const owner = internal.migrationValueOwners?.[name];
      if (owner && completed.has(owner)) continue;
      const condition = internal.mutation?.conditions?.[name];
      const exists = Object.hasOwn(source, name);
      if (condition && (exists !== condition.exists || (exists && !sameValue(source[name], condition.value)))) continue;
      if (wanted.exists) next[name] = structuredClone(wanted.value);
      else delete next[name];
    }
    return sanitize(next);
  };
  const rejectWaiters = (waiters, error) => {
    for (const waiter of waiters) {
      waiter.pending = false;
      if (waiter.exposed) waiter.reject(error);
    }
  };
  const changedKeys = (before, after) => [...schema.keys()].filter((name) => !sameValue(savedValue(before, name), savedValue(after, name)));
  const mutationFor = (sent, replace) => {
    const set = {};
    const remove = [];
    for (const [name, value] of sent) {
      if (value === REMOVED) remove.push(name);
      else set[name] = value;
    }
    if (replace) return { replace: set };
    return { set, remove };
  };
  const mergeMutation = (sent, replace, internal) => {
    const mutation = mutationFor(sent, replace);
    if (!internal) return mutation;
    if (replace) {
      return {
        ...mutation,
        ...(internal.guard ? { guard: structuredClone(internal.guard) } : {}),
      };
    }
    const set = { ...(internal.set ?? {}), ...mutation.set };
    const remove = new Set(internal.remove ?? []);
    for (const name of Object.keys(mutation.set)) remove.delete(name);
    for (const name of mutation.remove) {
      delete set[name];
      remove.add(name);
    }
    return {
      ...(Object.hasOwn(internal, 'initialize')
        ? { initialize: structuredClone(internal.initialize) }
        : Object.hasOwn(internal, 'replace')
          ? { initialize: structuredClone(internal.replace) }
          : {}),
      set,
      remove: [...remove],
      ...(internal.conditions ? { conditions: structuredClone(internal.conditions) } : {}),
      ...(internal.guard ? { guard: structuredClone(internal.guard) } : {}),
      ...(internal.guarded ? { guarded: structuredClone(internal.guarded) } : {}),
      ...(internal.migrationOwners ? { migrationOwners: structuredClone(internal.migrationOwners) } : {}),
    };
  };
  const committedCandidate = (sent, replace) => {
    const next = replace ? {} : { ...values };
    for (const [name, value] of sent) {
      if (value === REMOVED) delete next[name];
      else next[name] = value;
    }
    return sanitize(next);
  };
  const settleSave = () => {
    if (activeSave || drafts.size || pendingInternal) return;
    setSaveStatus('idle');
    const waiters = queuedWaiters;
    queuedWaiters = [];
    resolveWaiters(waiters);
  };
  const supersededByAccountDeletion = (operation) => (
    key !== STORAGE_KEY
    && reinitializeAccountOnWrite
    && accountDeletionGeneration > operation.generation
  );
  const retryMigrationConflict = (error, operation) => {
    if (error?.code !== 'STORAGE_MIGRATION_CONFLICT' || !operation.internal) return false;
    const attempts = (operation.internal.conflicts ?? 0) + 1;
    if (attempts > 3) return false;
    const storageChangedLater = valueGeneration > operation.generation;
    const current = storageChangedLater ? read(storage.get) : error.current;
    const currentReceipt = storageChangedLater ? migrationRecord(storage.get) : error.receipt;
    activeSave = null;
    for (const name of operation.internal.fields ?? []) {
      const sent = operation.sent.get(name);
      if (drafts.has(name) && sameValue(drafts.get(name), sent)) drafts.delete(name);
    }
    const before = values;
    values = sanitize(current);
    valueGeneration++;
    const changed = changedKeys(before, values);
    if (changed.length) notify(changed, true);
    const migration = migrationResult(current, currentReceipt);
    const receipt = migration.pending.length
      ? [...migration.done, ...migration.pending.map((item) => item.id)]
      : Array.isArray(currentReceipt) ? currentReceipt : null;
    pendingInternal = null;
    replacePending = operation.replace;
    stageMigration(migration, {
      copyAll: supersededByAccountDeletion(operation) || error.copyAll === true,
      receipt,
    });
    if (pendingInternal) pendingInternal.conflicts = attempts;
    queuedWaiters = [...operation.waiters, ...queuedWaiters];
    setSaveStatus('saving');
    flush();
    return true;
  };
  const saveFailed = (error, operation) => {
    if (retryMigrationConflict(error, operation)) return;
    activeSave = null;
    if (operation.replace) replacePending = true;
    if (operation.internal) pendingInternal = operation.internal;
    log?.error('Could not save settings', error);
    setSaveStatus('error', error);
    rejectWaiters(operation.waiters, error);
    const blocked = queuedWaiters;
    queuedWaiters = [];
    rejectWaiters(blocked, error);
  };
  const finishSave = (raw, operation, previous, completedBefore) => {
    activeSave = null;
    const accountDeletedLater = supersededByAccountDeletion(operation);
    if (!accountDeletedLater && (operation.replace || operation.internal?.copyAll)) {
      reinitializeAccountOnWrite = false;
    }
    const before = values;
    if (!accountDeletedLater && valueGeneration === operation.ackGeneration) values = sanitize(raw);
    if (!replacePending) {
      for (const [name, sent] of operation.sent) {
        if (drafts.has(name) && sameValue(drafts.get(name), sent)) drafts.delete(name);
      }
    }
    const changed = changedKeys(before, values);
    if (changed.length) notify(changed);
    resolveWaiters(operation.waiters, migrationPrevious(previous, operation.internal, completedBefore));
    if (drafts.size) flush();
    else settleSave();
  };
  const receiptFailed = (error, raw, operation) => {
    activeSave = null;
    const accountDeletedLater = supersededByAccountDeletion(operation);
    const before = values;
    if (!accountDeletedLater && valueGeneration === operation.ackGeneration) values = sanitize(raw);
    for (const [name, sent] of operation.sent) {
      if (drafts.has(name) && sameValue(drafts.get(name), sent)) drafts.delete(name);
    }
    const changed = changedKeys(before, values);
    if (changed.length) notify(changed);
    pendingInternal = operation.internal && !accountDeletedLater ? {
      ...operation.internal,
      mutation: { set: {}, remove: [] },
      fields: [],
      receiptOnly: true,
    } : null;
    log?.error('Could not save settings', error);
    setSaveStatus('error', error);
    rejectWaiters(operation.waiters, error);
    const blocked = queuedWaiters;
    queuedWaiters = [];
    rejectWaiters(blocked, error);
  };
  const saveSucceeded = (raw, operation, previous, completedBefore) => {
    operation.ackGeneration = valueGeneration;
    if (operation.atomicMigration) {
      finishSave(raw, operation, previous, completedBefore);
      return;
    }
    let recorded;
    try {
      recorded = operation.internal?.onSaved?.();
    } catch (error) {
      const exposed = operation.waiters.some((waiter) => waiter.exposed);
      receiptFailed(error, raw, operation);
      if (!exposed) throw error;
      return;
    }
    if (isPromise(recorded)) {
      activeSave = operation;
      setSaveStatus('saving');
      recorded.then(
        () => finishSave(raw, operation, previous, completedBefore),
        (error) => receiptFailed(error, raw, operation),
      );
      return;
    }
    finishSave(raw, operation, previous);
  };
  const discardOperation = (operation) => {
    for (const [name, sent] of operation.sent) {
      if (drafts.has(name) && sameValue(drafts.get(name), sent)) drafts.delete(name);
    }
    replacePending = false;
  };

  function flush() {
    if (activeSave) return;
    stageAccountReinitialization();
    if (!drafts.size && !pendingInternal) {
      settleSave();
      return undefined;
    }
    if (!ready) {
      setSaveStatus('saving');
      return;
    }
    const operation = {
      sent: new Map(drafts),
      replace: replacePending,
      waiters: queuedWaiters,
      internal: pendingInternal,
      generation: valueGeneration,
    };
    for (const waiter of operation.waiters) {
      if (waiter.returnPrevious) waiter.fallbackPrevious = structuredClone(values);
    }
    queuedWaiters = [];
    replacePending = false;
    pendingInternal = null;
    const mutation = mergeMutation(operation.sent, operation.replace, operation.internal?.mutation);
    const candidate = committedCandidate(operation.sent, operation.replace);
    let result;
    if (operation.internal?.receiptOnly) {
      try {
        result = operation.internal.onSaved?.();
      } catch (error) {
        saveFailed(error, operation);
        const exposed = operation.waiters.some((waiter) => waiter.exposed);
        if (!exposed) throw error;
        return undefined;
      }
      if (!isPromise(result)) {
        operation.ackGeneration = valueGeneration;
        finishSave(values, operation);
        return undefined;
      }
      activeSave = operation;
      setSaveStatus('saving');
      result.then(
        () => {
          operation.ackGeneration = valueGeneration;
          finishSave(values, operation);
        },
        (error) => saveFailed(error, operation),
      );
      return undefined;
    }
    try {
      const wantsPrevious = operation.waiters.some((waiter) => waiter.returnPrevious);
      const accountWrite = key !== STORAGE_KEY;
      if ((accountWrite || operation.internal?.receipt || operation.internal?.copyAll) && storage.migrate) {
        operation.atomicMigration = true;
        operation.detailed = wantsPrevious && Boolean(storage.migrateDetailed);
        const migrationOptions = {
          sourceKey: operation.internal?.sourceKey ?? (accountWrite ? STORAGE_KEY : undefined),
          sourceDoneKey: operation.internal?.sourceDoneKey ?? (accountWrite ? `${STORAGE_KEY}.migrated` : undefined),
        };
        const atomicMutation = accountWrite && !Object.hasOwn(mutation, 'initialize')
          ? { ...mutation, initialize: {} }
          : mutation;
        result = operation.detailed
          ? storage.migrateDetailed(key, atomicMutation, doneKey, operation.internal?.receipt ?? [], migrationOptions)
          : storage.migrate(key, atomicMutation, doneKey, operation.internal?.receipt ?? [], migrationOptions);
      } else if (wantsPrevious && storage.mutateDetailed) {
        operation.detailed = true;
        result = storage.mutateDetailed(key, mutation);
      } else {
        result = storage.mutate ? storage.mutate(key, mutation) : (storage.set(key, candidate), candidate);
      }
    } catch (error) {
      if (operation.internal) pendingInternal = operation.internal;
      discardOperation(operation);
      log?.error('Could not save settings', error);
      setSaveStatus('idle');
      const exposed = operation.waiters.some((waiter) => waiter.exposed);
      rejectWaiters(operation.waiters, error);
      if (exposed) return;
      throw error;
    }
    if (!isPromise(result)) {
      const committed = operation.detailed ? result.value : (storage.mutate ? result : candidate);
      saveSucceeded(
        committed,
        operation,
        operation.detailed ? result.previous : undefined,
        operation.detailed ? result.completedBefore : undefined,
      );
      return undefined;
    }
    activeSave = operation;
    setSaveStatus('saving');
    result.then(
      (committed) => saveSucceeded(
        operation.detailed ? committed.value : committed,
        operation,
        operation.detailed ? committed.previous : undefined,
        operation.detailed ? committed.completedBefore : undefined,
      ),
      (error) => saveFailed(error, operation),
    );
  }

  function requestSave(options) {
    const waiter = makeWaiter(options);
    queuedWaiters.push(waiter);
    try {
      flush();
    } catch (error) {
      waiter.pending = false;
      throw error;
    }
    if (!waiter.pending) return waiter.value;
    waiter.exposed = true;
    return waiter.promise;
  }

  function retrySave() {
    if (pendingInternal?.conflicts) delete pendingInternal.conflicts;
    return requestSave();
  }

  function waitForActiveSave() {
    const waiter = makeWaiter();
    waiter.exposed = true;
    activeSave.waiters.push(waiter);
    return waiter.promise;
  }

  function queuePatch(next, keys) {
    stageAccountReinitialization();
    const internallyOwned = new Set();
    for (const name of keys) {
      for (const internal of [pendingInternal, activeSave?.internal]) {
        const mutation = internal?.mutation;
        if (
          internal?.fields?.includes(name)
          || Object.hasOwn(mutation?.set ?? {}, name)
          || mutation?.remove?.includes(name)
          || Object.hasOwn(mutation ?? {}, 'initialize')
          || Object.hasOwn(mutation ?? {}, 'replace')
        ) internallyOwned.add(name);
        if (internal?.mutation?.conditions) delete internal.mutation.conditions[name];
        if (internal?.mutation?.guard) delete internal.mutation.guard[name];
        if (internal?.mutation?.guarded) {
          internal.mutation.guarded = internal.mutation.guarded.filter((item) => item !== name);
        }
        if (internal?.mutation?.migrationOwners) delete internal.mutation.migrationOwners[name];
        if (internal?.fields) internal.fields = internal.fields.filter((item) => item !== name);
        if (internal?.migrationValues) delete internal.migrationValues[name];
        if (internal?.migrationValueOwners) delete internal.migrationValueOwners[name];
      }
    }
    const joinsActive = activeSave && keys.length > 0 && keys.every((name) => (
      !internallyOwned.has(name)
      &&
      !drafts.has(name)
      && activeSave.sent.has(name)
      && sameValue(savedValue(next, name), activeSave.sent.get(name))
    ));
    if (joinsActive) return waitForActiveSave();
    const unchanged = [];
    let needsSave = false;
    for (const name of keys) {
      const wanted = savedValue(next, name);
      const inFlight = activeSave?.sent.has(name);
      if (ready && !inFlight && sameValue(wanted, savedValue(values, name))) {
        if (replacePending || internallyOwned.has(name)) {
          drafts.set(name, wanted === REMOVED ? REMOVED : structuredClone(wanted));
          needsSave = true;
        } else drafts.delete(name);
        unchanged.push(name);
      }
      else {
        drafts.set(name, wanted === REMOVED ? REMOVED : structuredClone(wanted));
        needsSave = true;
      }
    }
    // An explicit same-value choice still matters to consumers such as the shared Instant
    // Games switch, where the Facebook account used most recently is authoritative.
    if (unchanged.length) notify(unchanged);
    if (!needsSave) {
      if (pendingInternal) return requestSave();
      flush();
      return undefined;
    }
    return requestSave();
  }

  function queueReplace(next, options) {
    drafts.clear();
    for (const [name] of schema) {
      const wanted = savedValue(next, name);
      drafts.set(name, wanted === REMOVED ? REMOVED : structuredClone(wanted));
    }
    replacePending = true;
    return requestSave(options);
  }

  function notify(keys, remote = false) {
    for (const listener of listeners) {
      try {
        listener({ keys, remote });
      } catch (error) {
        log?.error('A settings listener failed', error);
      }
    }
  }

  function spec(key) {
    const found = schema.get(key);
    if (!found) throw new Error(`Unknown setting: ${key}`);
    return found;
  }

  storage.onChange?.(key, (raw, change) => {
    valueGeneration++;
    const accountRecordMissing = key !== STORAGE_KEY && !isSettingsRecord(raw);
    if (accountRecordMissing) {
      reinitializeAccountOnWrite = true;
      accountDeletionGeneration = valueGeneration;
    }
    else if (key !== STORAGE_KEY) reinitializeAccountOnWrite = false;
    const incoming = accountRecordMissing ? read(storage.get) : raw;
    if (!ready) {
      if (change?.source === 'load') return;
      const before = values;
      values = sanitize(incoming);
      const changed = changedKeys(before, values);
      if (changed.length) notify(changed, true);
      return;
    }
    const before = values;
    values = sanitize(incoming);
    const changed = changedKeys(before, values);
    if (changed.length) notify(changed, true);
  });

  if (!ready) storage.whenReady(loadSavedSettings);

  const startupStatus = () => {
    if (ready) return 'ready';
    return storage.status?.().state === 'error' ? 'error' : 'loading';
  };
  const startup = {
    status: startupStatus,
    onStatus(listener) {
      if (storage.onStatus) return storage.onStatus(() => listener(startupStatus()));
      listener(startupStatus());
      return () => {};
    },
    matchesAccount: (candidate) => candidate === account,
  };

  function get(key) {
    return Object.hasOwn(values, key) ? values[key] : spec(key).default;
  }

  function pageLoadValue(key) {
    return Object.hasOwn(pageLoadValues, key) ? pageLoadValues[key] : spec(key).default;
  }

  return {
    schema,
    perAccount: key !== STORAGE_KEY,
    startup,
    // Runs once the saved choices are in: at once from a userscript manager, a few
    // milliseconds in from the extension's storage. For decisions made only as the page starts.
    whenLoaded: (run) => (storage.whenReady ? storage.whenReady(run) : run()),
    get,
    display: shownValue,
    pageLoadValue,
    saveStatus,
    onSaveStatus(listener) {
      saveListeners.add(listener);
      tellSaveStatus(listener);
      return () => saveListeners.delete(listener);
    },
    retry: retrySave,
    set(key, value) {
      const found = spec(key);
      if (!isValid(found, value)) throw new TypeError(`Invalid value for ${key}: ${JSON.stringify(value)}`);
      const next = { ...values };
      if (value === found.default) delete next[key];
      else next[key] = value;
      return queuePatch(next, [key]);
    },
    setMany(entries) {
      const next = { ...values };
      const keys = [];
      for (const [name, value] of Object.entries(entries)) {
        const found = spec(name);
        if (!isValid(found, value)) throw new TypeError(`Invalid value for ${name}: ${JSON.stringify(value)}`);
        if (value === found.default) delete next[name];
        else next[name] = value;
        keys.push(name);
      }
      return queuePatch(next, keys);
    },
    // A feature runs only when it's switched on and the whole script isn't paused.
    enabled(featureId) {
      return ready && get('paused') !== true && get(featureId) === true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => structuredClone(values),
    restore(snapshot) {
      return queueReplace(sanitize(snapshot));
    },
    reset() {
      const previous = structuredClone(values);
      return queueReplace({}, { returnPrevious: true, fallbackPrevious: previous });
    },
    exportJson(now = new Date()) {
      return JSON.stringify({ app: 'HushFacebook Web', schema: EXPORT_SCHEMA, version, exported: now.toISOString(), settings: values }, null, 2);
    },
    importJson(text) {
      if (typeof text !== 'string') throw new TypeError('Choose a JSON settings file');
      if (text.length > MAX_BACKUP_BYTES || new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) {
        throw new TypeError('Choose a settings file smaller than 1 MB');
      }
      const parsed = JSON.parse(text);
      const wrapped = parsed && typeof parsed === 'object' && ['app', 'schema', 'settings'].some((key) => Object.hasOwn(parsed, key));
      if (wrapped && (parsed.app !== 'HushFacebook Web' || parsed.schema !== EXPORT_SCHEMA)) {
        throw new TypeError('Choose a HushFacebook Web backup in format 1');
      }
      const incoming = wrapped ? parsed.settings : parsed;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        throw new TypeError('That file has no HushFacebook Web settings in it');
      }
      const changed = { ...incoming };
      for (const migration of migrations) {
        if (olderThan(parsed.version, migration.before)) migration.run(changed);
      }
      const applied = [];
      const skipped = [];
      const next = wrapped ? {} : { ...values };
      for (const [key, value] of Object.entries(changed)) {
        const found = schema.get(key);
        if (!found || !isValid(found, value)) {
          skipped.push(key);
          continue;
        }
        if (value === found.default) delete next[key];
        else next[key] = value;
        applied.push(key);
      }
      const saved = wrapped ? queueReplace(sanitize(next)) : queuePatch(sanitize(next), applied);
      const result = { applied, skipped };
      return isPromise(saved) ? saved.then(() => result) : result;
    },
  };
}
