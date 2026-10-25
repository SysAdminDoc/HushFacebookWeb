// GM getters and key enumeration are cached per tab. Append to independent physical keys,
// then fold the known operations without ever publishing a cached replacement snapshot.
import { mergeSeenRecords, mergeSeenBarriers, seenBarrier, seenClearKey, validSeenOperation } from './seen.js';

export function createSeenJournal({ get, list, set, remove, uuid = () => crypto.randomUUID(), now = Date.now, log }) {
  const unconfirmed = new Set();
  const records = (key) => list().filter((name) => name.startsWith(`${key}#seen:`))
    .map((name) => ({ name, operation: get(name) })).filter(({ name, operation }) => !unconfirmed.has(name) && validSeenOperation(operation));
  const read = (key) => {
    const found = records(key);
    const clearedAt = found.reduce((marker, { operation }) => operation.clear ? mergeSeenBarriers(marker, { at: operation.clear, tokens: operation.token ? [operation.token] : [] }) : marker, seenBarrier(get(seenClearKey(key), 0)));
    const seed = Object.fromEntries(Object.entries(get(key, {}) ?? {}).filter(([, at]) => at > clearedAt.at));
    const additions = found.map(({ operation }) => Object.fromEntries(Object.entries(operation.add ?? {}).filter(([, at]) => at > clearedAt.at || at === clearedAt.at && clearedAt.tokens.length && clearedAt.tokens.every((token) => operation.after?.includes(token)))));
    return { entries: mergeSeenRecords([seed, ...additions], clearedAt.at, now()), clearedAt };
  };
  const append = async (key, operation, allowed) => {
    if (!allowed()) throw new Error('The Facebook account changed');
    const name = `${key}#seen:${uuid()}`;
    unconfirmed.add(name);
    try { await set(name, structuredClone(operation)); } catch (error) {
      try { await remove(name); unconfirmed.delete(name); } catch { /* Exclude a rejected cache-only copy. */ }
      throw error;
    }
    unconfirmed.delete(name);
    if (!allowed()) throw new Error('The Facebook account changed');
    return name;
  };
  async function compact(key, allowed, force) {
    const found = records(key);
    if (!force && found.length <= 32) return;
    const state = read(key);
    const clears = new Set(found.filter(({ operation }) => operation.clear === state.clearedAt.at).map(({ name }) => name));
    // A checkpoint is another immutable addition, never a replacement. It covers every
    // retained entry before old records are removed, even when another tab compacts too.
    if (Object.keys(state.entries).length) await append(key, { add: state.entries, after: state.clearedAt.tokens, at: now() }, allowed);
    for (const { name } of found) {
      if (clears.has(name)) continue;
      if (!allowed()) throw new Error('The Facebook account changed');
      await set(name, { discarded: uuid() });
      if (!allowed()) throw new Error('The Facebook account changed');
      await remove(name);
    }
  }
  return {
    read,
    async mutate(key, operation, allowed = () => true) {
      if (!validSeenOperation(operation)) throw new TypeError('Invalid seen-history operation');
      await append(key, operation, allowed);
      if (operation.clear && get(key, undefined) !== undefined) {
        if (!allowed()) throw new Error('The Facebook account changed');
        await remove(key);
      }
      try { await set(`${key}#seen-changed`, uuid()); } catch (error) { log?.warn('Seen history changed, but another tab could not be notified', error); }
      try { await compact(key, allowed, operation.clear || !Object.keys(operation.add).length); } catch (error) { log?.warn('Old seen-history operations could not be pruned', error); }
      if (!allowed()) throw new Error('The Facebook account changed');
      return read(key).entries;
    },
  };
}
