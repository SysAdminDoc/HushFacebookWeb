// Ordinary playback writes replace a nonce-bearing epoch. Rare confirmed legacy changes
// append conditional proposals within that epoch; retries never replace the raw value.
// Committed proposal history is retained: pruning a causal predecessor from a stale cache
// can reactivate an older restore. Only our rejected physical attempts are removed. The
// caps below refuse further rare repairs visibly; ordinary nonce epochs remain available.
// Concurrent divergent repairs have no provable real-time order in a cached GM store.
// Keep every branch and surface a conflict. A later explicit observed write can resolve it.
export const GM_ACTIVITY_MAX_RECORDS = 4096;
export const GM_ACTIVITY_MAX_BYTES = 4 * 1024 * 1024;
const RETRY_DELAYS = [250, 1000];
const RECORD_TAG = 'hfw-activity-v1';
const ENVELOPE_TAG = 'hfw-activity-value-v1';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => isRecord(value) && Object.keys(value).every((key) => keys.includes(key));
const copy = (value) => structuredClone(value);
export const gmActivityRegisterKey = (key) => typeof key === 'string' && (
  /^(?:seenPosts|seenPostsCleared)$/.test(key)
  || /^(?:keepSpeed\.rate|keepVolume\.state|resumeVideos\.positions)(?:@(?:[a-f0-9]{32}|signed-out))?$/.test(key)
);
export const gmActivityPulseKey = (key) => `${key}#activityChanged`;
const prefix = (key) => `${key}#activity:`;
const changedAccount = () => Object.assign(new Error('The Facebook account changed'), { code: 'ACTIVITY_ACCOUNT_CHANGED' });
const superseded = () => Object.assign(new Error('A newer activity change replaced this save'), { code: 'ACTIVITY_SUPERSEDED' });
const full = () => Object.assign(new Error('Activity recovery storage is full. Your earlier data stays saved'), { code: 'ACTIVITY_REGISTER_FULL' });
const conflict = () => Object.assign(new Error('Activity recovery has conflicting changes. Choose a new value to continue'), { code: 'ACTIVITY_REGISTER_CONFLICT' });

// Exact canonical equality avoids depending on object insertion order or a lossy hash.
function fingerprint(value, seen = new Set()) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' && !Number.isFinite(value)) return `number:${String(value)}`;
  if (value === null || typeof value !== 'object') return `${typeof value}:${JSON.stringify(value)}`;
  if (seen.has(value)) throw new TypeError('Activity values cannot contain cycles');
  seen.add(value);
  const encoded = Array.isArray(value)
    ? `[${value.map((part) => fingerprint(part, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${fingerprint(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return encoded;
}

const envelope = (value) => only(value, ['tag', 'nonce', 'deleted', 'value'])
  && value.tag === ENVELOPE_TAG && typeof value.nonce === 'string' && ID.test(value.nonce) && typeof value.deleted === 'boolean'
  && (value.deleted ? !Object.hasOwn(value, 'value') : Object.hasOwn(value, 'value'));
const unpack = (raw) => envelope(raw) ? raw.deleted ? undefined : raw.value : raw;
const valid = (operation) => only(operation, ['tag', 'id', 'seed', 'at', 'parents', 'kind', 'value', 'restoreFrom'])
  && operation.tag === RECORD_TAG && typeof operation.id === 'string' && ID.test(operation.id) && typeof operation.seed === 'string'
  && Number.isSafeInteger(operation.at) && operation.at >= 0
  && Array.isArray(operation.parents) && operation.parents.length <= GM_ACTIVITY_MAX_RECORDS
  && operation.parents.every((id) => typeof id === 'string' && ID.test(id) && id !== operation.id)
  && new Set(operation.parents).size === operation.parents.length
  && ['set', 'erase', 'restore'].includes(operation.kind)
  && (operation.kind === 'erase' ? !Object.hasOwn(operation, 'value') : Object.hasOwn(operation, 'value'))
  && (operation.kind === 'restore' ? typeof operation.restoreFrom === 'string' && ID.test(operation.restoreFrom) : !Object.hasOwn(operation, 'restoreFrom'));

export function createGmActivityRegister({
  get, list, set, remove, uuid = () => crypto.randomUUID(), now = Date.now,
  schedule = setTimeout, cancel = clearTimeout, log,
}) {
  const unconfirmed = new Set();
  const jobs = new Map();
  const rawWrites = new Map();
  const listeners = new Map();
  const checkKey = (key) => { if (!gmActivityRegisterKey(key)) throw new TypeError('This key does not hold activity'); };
  const allowed = (job) => {
    try { return job.allowed() !== false; } catch { return false; }
  };
  const requireAllowed = (job) => { if (!allowed(job)) throw changedAccount(); };
  const nextId = () => {
    const id = uuid();
    if (typeof id !== 'string' || !ID.test(id)) throw new TypeError('Invalid activity operation id');
    return id;
  };
  const previousRaw = (pending) => {
    let current = pending;
    while (current) {
      if (current.acknowledged) return current.value;
      if (!current.previousPending) return current.previous;
      current = current.previousPending;
    }
  };
  const collapseRaw = (key) => {
    let current = rawWrites.get(key);
    while (current) {
      while (current.previousPending?.settled) {
        const previous = current.previousPending;
        current.previous = previous.acknowledged ? previous.value : previous.previous;
        current.previousPending = previous.acknowledged ? null : previous.previousPending;
      }
      current = current.previousPending;
    }
  };
  const rawValue = (key) => {
    const raw = get(key, undefined);
    const pending = rawWrites.get(key);
    return pending && fingerprint(raw) === fingerprint(pending.value) ? copy(previousRaw(pending)) : raw;
  };

  function snapshot(key) {
    checkKey(key);
    const raw = rawValue(key);
    const seed = fingerprint(raw);
    const names = list().filter((name) => typeof name === 'string' && name.startsWith(prefix(key)));
    const operations = new Map();
    const conflicts = new Set();
    let bytes = 0;
    for (const name of names) {
      const operation = get(name, undefined);
      bytes += new TextEncoder().encode(JSON.stringify(operation) ?? '').byteLength;
      if (unconfirmed.has(name) || !valid(operation) || operation.seed !== seed) continue;
      const previous = operations.get(operation.id);
      if (previous && fingerprint(previous) !== fingerprint(operation)) conflicts.add(operation.id);
      else operations.set(operation.id, copy(operation));
    }
    for (const id of conflicts) operations.delete(id);
    const ancestors = (operation) => {
      const found = new Set();
      const todo = [...operation.parents];
      while (todo.length) {
        const id = todo.pop();
        if (found.has(id)) continue;
        found.add(id);
        for (const parent of operations.get(id)?.parents ?? []) todo.push(parent);
      }
      return found;
    };
    const dominated = new Set();
    const ordinaryDominated = new Set();
    for (const operation of operations.values()) {
      for (const id of ancestors(operation)) {
        dominated.add(id);
        if (operation.kind !== 'restore') ordinaryDominated.add(id);
      }
    }
    const heads = [...operations.values()].filter((operation) => !dominated.has(operation.id));
    const ordinary = [...operations.values()].filter((operation) => operation.kind !== 'restore' && !ordinaryDominated.has(operation.id));
    const deletions = ordinary.filter((operation) => operation.kind === 'erase');
    const deletionIds = new Set(deletions.map((operation) => operation.id));
    const restorations = [...operations.values()].filter((operation) => operation.kind === 'restore'
      && deletionIds.has(operation.restoreFrom) && ancestors(operation).has(operation.restoreFrom));
    // An Undo cancels only its own deletion token. Observing another Undo does not revoke it.
    const undone = new Set(restorations.map((operation) => operation.restoreFrom));
    const stillDeleted = deletions.some((operation) => !undone.has(operation.id));
    const sets = ordinary.filter((operation) => operation.kind === 'set');
    const replacedRestorations = new Set(restorations.flatMap((operation) => [...ancestors(operation)]));
    const restoreHeads = restorations.filter((operation) => !replacedRestorations.has(operation.id));
    const candidates = stillDeleted ? [] : sets.length ? sets : restoreHeads;
    const divergent = (stillDeleted && sets.length > 0)
      || (candidates.length > 1 && candidates.some((operation) => fingerprint(operation.value) !== fingerprint(candidates[0].value)));
    const value = stillDeleted ? undefined : candidates.length ? copy(candidates[0].value) : copy(unpack(raw));
    return {
      seed, names, bytes, heads: heads.map((operation) => operation.id), value, conflict: divergent,
    };
  }

  const read = (key, fallback) => {
    const state = snapshot(key);
    if (state.conflict) throw conflict();
    return state.value === undefined ? fallback : state.value;
  };
  // Explicit recovery source only. This is not the current projected playback value.
  const source = (key, fallback) => {
    checkKey(key);
    const value = unpack(rawValue(key));
    return value === undefined ? fallback : copy(value);
  };
  function refresh(key, source = 'remote') {
    const value = read(key, undefined);
    for (const listener of listeners.get(key) ?? []) {
      try { listener(copy(value), { source }); } catch (error) { log?.error('An activity recovery listener failed', error); }
    }
    return value;
  }
  async function pulse(key, job) {
    requireAllowed(job);
    try { await set(gmActivityPulseKey(key), nextId()); }
    catch (error) { log?.warn('Activity was saved, but another tab could not be notified', error); }
    requireAllowed(job);
  }
  function discard(name, job) {
    if (!allowed(job) || typeof remove !== 'function') return;
    try {
      Promise.resolve(remove(name)).then(() => {
        if (allowed(job)) unconfirmed.delete(name);
      }, (error) => log?.warn('A rejected activity proposal could not be removed', error));
    } catch (error) { log?.warn('A rejected activity proposal could not be removed', error); }
  }

  function propose(key, kind, value, options = {}) {
    checkKey(key);
    const permission = { allowed: options.allowed ?? (() => true) };
    requireAllowed(permission);
    if (kind === 'restore' && (typeof options.restoreFrom !== 'string' || !ID.test(options.restoreFrom))) throw new TypeError('Choose the activity deletion to undo');
    const desired = fingerprint([kind, value, options.restoreFrom]);
    const previous = jobs.get(key);
    if (previous && previous.desired === desired) {
      previous.allowed = permission.allowed;
      if (previous.active) return previous.active;
      return run(previous);
    }
    const state = snapshot(key);
    if (state.names.length >= GM_ACTIVITY_MAX_RECORDS || state.bytes >= GM_ACTIVITY_MAX_BYTES) return Promise.reject(full());
    if (previous?.timer !== null && previous?.timer !== undefined) cancel(previous.timer);
    previous?.reject?.(superseded());
    const operation = {
      tag: RECORD_TAG, id: nextId(), seed: state.seed, at: Math.max(0, Math.trunc(now())),
      parents: [...new Set([...state.heads, ...(previous ? [previous.operation.id] : [])])], kind,
      ...(kind === 'erase' ? {} : { value: copy(value) }),
      ...(kind === 'restore' ? { restoreFrom: options.restoreFrom } : {}),
    };
    if (kind === 'restore' && !operation.parents.includes(options.restoreFrom)) operation.parents.push(options.restoreFrom);
    if (!valid(operation)) throw new TypeError('Invalid activity recovery proposal');
    const job = { key, desired, operation, allowed: permission.allowed, active: null, timer: null, reject: null };
    jobs.set(key, job);
    return run(job);
  }

  function run(job) {
    let resolve;
    let reject;
    const active = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Ordinary callers may ignore a returned save promise; failure remains in the retained job.
    void active.catch(() => {});
    job.active = active;
    job.reject = reject;
    const finish = (error, result) => {
      job.active = null;
      job.timer = null;
      job.reject = null;
      if (error) {
        // A user can explicitly resolve the observed heads; automatic retries cannot.
        if (error.code === 'ACTIVITY_REGISTER_CONFLICT' && jobs.get(job.key) === job) jobs.delete(job.key);
        reject(error);
      }
      else { if (jobs.get(job.key) === job) jobs.delete(job.key); resolve(result); }
    };
    const attempt = async (number) => {
      job.timer = null;
      let name;
      let acknowledged = false;
      try {
        requireAllowed(job);
        if (jobs.get(job.key) !== job) throw superseded();
        const state = snapshot(job.key);
        const size = new TextEncoder().encode(JSON.stringify(job.operation)).byteLength;
        if (state.names.length >= GM_ACTIVITY_MAX_RECORDS || state.bytes + size > GM_ACTIVITY_MAX_BYTES) throw full();
        name = `${prefix(job.key)}${nextId()}`;
        if (get(name, undefined) !== undefined) throw new Error('Activity operation ids collided');
        unconfirmed.add(name);
        requireAllowed(job);
        await set(name, copy(job.operation));
        acknowledged = true;
        unconfirmed.delete(name);
        requireAllowed(job);
        if (jobs.get(job.key) !== job) throw superseded();
        await pulse(job.key, job);
        requireAllowed(job);
        const current = refresh(job.key, 'ack');
        finish(null, job.operation.kind === 'erase' ? job.operation.id : current);
      } catch (error) {
        if (name && !acknowledged) discard(name, job);
        if (!allowed(job)) return finish(changedAccount());
        if (jobs.get(job.key) !== job) return finish(superseded());
        if (['ACTIVITY_REGISTER_FULL', 'ACTIVITY_REGISTER_CONFLICT'].includes(error.code) || number >= RETRY_DELAYS.length) return finish(error);
        try {
          job.timer = schedule(() => { void attempt(number + 1); }, RETRY_DELAYS[number]);
          job.timer?.unref?.();
        } catch (schedulingError) { finish(schedulingError); }
      }
    };
    void attempt(0);
    return active;
  }

  function ordinary(key, value, options = {}, deleted = false) {
    checkKey(key);
    const job = { allowed: options.allowed ?? (() => true) };
    requireAllowed(job);
    const previous = rawValue(key);
    const earlier = rawWrites.get(key);
    const previousPending = earlier && fingerprint(get(key, undefined)) === fingerprint(earlier.value) ? earlier : null;
    const stored = { tag: ENVELOPE_TAG, nonce: nextId(), deleted, ...(deleted ? {} : { value: copy(value) }) };
    const pending = { value: stored, previous: copy(previous), previousPending, acknowledged: false, settled: false };
    rawWrites.set(key, pending);
    collapseRaw(key);
    const saved = (async () => {
      try {
        requireAllowed(job);
        await set(key, copy(stored));
        pending.acknowledged = true;
        pending.settled = true;
        if (rawWrites.get(key) === pending) rawWrites.delete(key);
        collapseRaw(key);
        requireAllowed(job);
        return refresh(key, 'ack');
      } catch (error) {
        pending.settled = true;
        collapseRaw(key);
        // Keep this cache-only epoch hidden until an actual later value replaces it.
        log?.error('An ordinary activity change could not be saved', error);
        throw error;
      }
    })();
    void saved.catch(() => {});
    return saved;
  }

  return {
    read, source, refresh,
    write: (key, value, options = {}) => propose(key, options.restoreFrom === undefined ? 'set' : 'restore', value, options),
    erase: (key, options) => propose(key, 'erase', undefined, options),
    set: (key, value, options) => ordinary(key, value, options),
    remove: (key, options) => ordinary(key, undefined, options, true),
    subscribe(key, listener) {
      checkKey(key);
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(listener);
      return () => listeners.get(key)?.delete(listener);
    },
  };
}
