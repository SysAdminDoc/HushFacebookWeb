// Watched-history records and atomic deltas. Legacy arrays remain readable; a clear keeps
// its timestamp beside the entries so a delayed or retried earlier add cannot revive them.
export const WATCHED_KEY = 'rememberWatched.list';
export const MAX_WATCHED = 50;
const STORY_PART = /^[\w.%=:-]{1,200}$/;
const record = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => record(value) && Object.keys(value).every((key) => keys.includes(key));
export const clearedAt = (value) => Number.isSafeInteger(value?.clearedAt) && value.clearedAt > 0 ? value.clearedAt : 0;
const newest = (a, b) => {
  const left = `${a.kind}:${a.id}`;
  const right = `${b.kind}:${b.id}`;
  return b.at - a.at || (left > right ? -1 : left < right ? 1 : 0);
};

export function entryOf(value) {
  if (!record(value) || !['reel', 'video', 'story'].includes(value.kind) || typeof value.id !== 'string' || !Number.isSafeInteger(value.at) || value.at <= 0) return null;
  if (value.kind === 'story' ? !(STORY_PART.test(value.id) && typeof value.bucket === 'string' && STORY_PART.test(value.bucket)) : !/^\d{6,30}$/.test(value.id)) return null;
  const entry = { kind: value.kind, id: value.id, at: value.at };
  if (value.kind === 'story') entry.bucket = value.bucket;
  if (typeof value.owner === 'string' && value.owner.trim() && value.owner.length <= 80) entry.owner = value.owner;
  const length = Number.isFinite(value.length) ? Math.round(value.length) : 0;
  if (length >= 1) entry.length = length;
  return entry;
}

export const validWatchedEntry = (entry) => (
  only(entry, ['kind', 'id', 'at', 'bucket', 'owner', 'length'])
  && entryOf(entry) !== null
  && (entry.kind === 'story' || entry.bucket === undefined)
  && (entry.owner === undefined || (typeof entry.owner === 'string' && entry.owner.length > 0 && entry.owner.length <= 80))
  && (entry.length === undefined || (Number.isFinite(entry.length) && entry.length >= 1))
);
const validList = (value) => Array.isArray(value) && value.length <= 200 && value.every(validWatchedEntry);
export const validWatchedRecord = (value) => validList(value) || (
  only(value, ['entries', 'clearedAt']) && validList(value.entries)
  && Number.isSafeInteger(value.clearedAt) && value.clearedAt > 0
);
export const validWatchedOperation = (operation) => (
  only(operation, ['add', 'clear']) && Object.keys(operation).length === 1
  && (Object.hasOwn(operation, 'add') ? validWatchedEntry(operation.add) : Number.isSafeInteger(operation.clear) && operation.clear > 0)
);

export function entriesOf(value) {
  const list = Array.isArray(value) ? value : value?.entries;
  return Array.isArray(list) ? list.map(entryOf).filter((entry) => entry && entry.at > clearedAt(value)) : [];
}

export function addWatched(list, entry) {
  const merged = new Map();
  for (const item of [entry, ...entriesOf(list)]) {
    const key = `${item.kind}:${item.id}`;
    if (!merged.has(key) || item.at > merged.get(key).at) merged.set(key, item);
  }
  return [...merged.values()].sort(newest).slice(0, MAX_WATCHED);
}

export function applyWatchedOperation(current, operation) {
  if (!validWatchedOperation(operation)) throw new TypeError('invalid watched-history operation');
  const clear = Math.max(clearedAt(current), operation.clear ?? 0);
  const before = entriesOf(current).filter((entry) => entry.at > clear).sort(newest);
  const entries = operation.add && operation.add.at > clear ? addWatched(before, entryOf(operation.add)) : before.slice(0, MAX_WATCHED);
  return clear ? { entries, clearedAt: clear } : entries;
}
