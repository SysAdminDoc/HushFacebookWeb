// Manager reads can be cached, without an atomic compare-and-swap. Independent immutable
// deltas converge across tabs/origins without ever replacing another tab's cached list.
import { applyWatchedOperation, entriesOf, validWatchedOperation } from './watched.js';

export const watchedStorageKey = (key) => /^rememberWatched\.list(?:@(?:[a-f0-9]{32}|signed-out))?$/.test(key);

export function createWatchedJournal({ get, list, set, remove, uuid = () => crypto.randomUUID(), log }) {
  const unconfirmed = new Set();
  const records = (key) => list().filter((name) => name.startsWith(`${key}#watch:`))
    .map((name) => ({ name, operation: get(name) })).filter(({ name, operation }) => !unconfirmed.has(name) && validWatchedOperation(operation));
  const read = (key, fallback) => {
    let state = get(key, fallback);
    for (const { operation } of records(key)) state = applyWatchedOperation(state, operation);
    return state;
  };

  async function compact(key) {
    const found = records(key).sort((a, b) => a.name.localeCompare(b.name));
    const state = read(key, []);
    const kept = new Set();
    const clear = found.filter(({ operation }) => operation.clear).sort((a, b) => b.operation.clear - a.operation.clear)[0];
    if (clear) kept.add(clear.name);
    for (const entry of entriesOf(state)) {
      const winner = found.find(({ operation }) => operation.add?.kind === entry.kind && operation.add.id === entry.id && operation.add.at === entry.at);
      if (winner) kept.add(winner.name);
    }
    // Only permanently dominated operations go. A stale view cannot delete an unseen delta,
    // and a retained maximum clear remains authoritative after manager/browser restart.
    for (const { name } of found) {
      if (kept.has(name)) continue;
      await set(name, { discarded: uuid() });
      await remove(name);
    }
  }

  return {
    read,
    async mutate(key, operation, allowed = () => true) {
      if (!validWatchedOperation(operation)) throw new TypeError('invalid watched-history operation');
      if (!allowed()) throw new Error('The Facebook account changed');
      const name = `${key}#watch:${uuid()}`;
      unconfirmed.add(name);
      try {
        await set(name, structuredClone(operation));
      } catch (error) {
        // VM changes its cache before the request settles. Never read that rejected write as
        // saved, and retry under a fresh physical key so identical cached bytes cannot skip it.
        try { await remove(name); unconfirmed.delete(name); } catch { /* Keep the ghost excluded. */ }
        throw error;
      }
      unconfirmed.delete(name);
      if (!allowed()) throw new Error('The Facebook account changed');
      if (operation.clear && get(key, undefined) !== undefined) {
        // Redact the legacy seed too. The nonce forces an actual manager write on a retry.
        const state = read(key, []);
        const entries = entriesOf(get(key, [])).filter((entry) => entry.at > state.clearedAt);
        await set(key, { entries, clearedAt: state.clearedAt, nonce: uuid() });
      }
      try { await set(`${key}#changed`, uuid()); } catch (error) { log?.warn('The watched list changed, but another tab could not be notified', error); }
      try { await compact(key); } catch (error) { log?.warn('Old watched-history operations could not be pruned', error); }
      return read(key, []);
    },
  };
}
