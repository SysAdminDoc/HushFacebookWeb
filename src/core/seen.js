// First-seen additions and a retained clear barrier. The wire operation is bounded; the
// stored entries keep the original id -> timestamp shape for older history and imports.
export const SEEN_KEY = 'seenPosts';
export const CLEARED_KEY = 'seenPostsCleared';
export const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
export const MAX_ENTRIES = 5000;
export const seenStorageKey = (key) => /^seenPosts@(?:[a-f0-9]{32}|signed-out)$/.test(key);
export const seenClearKey = (key) => key.replace(/^seenPosts(?=@|$)/, CLEARED_KEY);
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
export const seenTime = (value) => Number.isFinite(value) && value > 0 ? value : Number.isFinite(value?.at) && value.at > 0 ? value.at : 0;
const validTokens = (tokens) => Array.isArray(tokens) && tokens.length <= 256 && tokens.every((id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id));
export const validSeenBarrier = (value) => Number.isFinite(value) && value >= 0 || Boolean(record(value)) && Object.keys(value).every((key) => key === 'at' || key === 'tokens') && Number.isFinite(value.at) && value.at >= 0 && validTokens(value.tokens);
export const seenBarrier = (value) => ({ at: seenTime(value), tokens: validSeenBarrier(value) && Array.isArray(value.tokens) ? [...new Set(value.tokens)].sort() : [] });
export function mergeSeenBarriers(left, right) {
  const a = seenBarrier(left);
  const b = seenBarrier(right);
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return { at: a.at, tokens: [...new Set([...a.tokens, ...b.tokens])].sort() };
}
export const validSeenEntries = (value) => Boolean(record(value)) && Object.keys(value).length <= 20000
  && Object.entries(value).every(([id, at]) => id.length > 0 && id.length <= 256 && Number.isFinite(at) && at > 0);
export const validSeenOperation = (operation) => Boolean(record(operation))
  && Object.keys(operation).every((key) => ['add', 'clear', 'at', 'token', 'after'].includes(key))
  && Number.isSafeInteger(operation.at) && operation.at > 0
  && (operation.after === undefined || validTokens(operation.after))
  && (operation.token === undefined || typeof operation.token === 'string' && /^[a-f0-9-]{36}$/.test(operation.token))
  && (Object.hasOwn(operation, 'add') !== Object.hasOwn(operation, 'clear'))
  && (Object.hasOwn(operation, 'add') ? validSeenEntries(operation.add) && Object.keys(operation.add).length <= MAX_ENTRIES
    : Number.isSafeInteger(operation.clear) && operation.clear > 0);

export function mergeSeenRecords(records, clearedAt, now, maxEntries = MAX_ENTRIES, maxAge = MAX_AGE) {
  const entries = new Map();
  for (const raw of records) {
    if (!record(raw)) continue;
    for (const [id, at] of Object.entries(raw)) {
      if (!id || id.length > 256 || !Number.isFinite(at) || at <= 0 || at < clearedAt || at < now - maxAge) continue;
      if (!entries.has(id) || at < entries.get(id)) entries.set(id, at);
    }
  }
  return Object.fromEntries([...entries].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, maxEntries));
}

export function applySeenOperation(entries, clearedAt, operation) {
  if (!validSeenOperation(operation)) throw new TypeError('Invalid seen-history operation');
  const before = seenBarrier(clearedAt);
  const marker = operation.clear ? mergeSeenBarriers(before, { at: operation.clear, tokens: operation.token ? [operation.token] : [] }) : before;
  const newClear = operation.clear && (operation.clear > before.at || operation.clear === before.at && (!operation.token || !before.tokens.includes(operation.token)));
  const current = Object.fromEntries(Object.entries(record(entries) ? entries : {}).filter(([, at]) => at > marker.at || at === marker.at && !newClear && marker.tokens.length));
  const add = Object.fromEntries(Object.entries(operation.add ?? {}).filter(([, at]) => at > marker.at || at === marker.at && marker.tokens.length && marker.tokens.every((token) => operation.after?.includes(token))));
  return { entries: mergeSeenRecords([current, add], marker.at, operation.at), clearedAt: marker };
}
