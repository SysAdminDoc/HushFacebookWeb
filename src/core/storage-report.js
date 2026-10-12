// Facebook's page reports the name and size of every localStorage and sessionStorage key to
// Facebook's server, and removes the localStorage keys the answer lists. That's
// WebStorageMonster.cleanNow, read live 2026-10-11 (run 49): it counts both storages on the
// spot, then posts the counts to /ajax/webstorage/process_keys/. The script keeps a few marks
// for the tab you're in under hfw: in sessionStorage (Open on a chosen tab, the redirect guards,
// Hide seen posts' show-again), and their names alone would tell Facebook's server the script is
// running. In page mode cleanNow is wrapped so those marks step out while it counts and go
// straight back before anything else runs.

import { whenModule } from './modules.js';

export const MARK_PREFIX = 'hfw:';
export const MONSTER = 'WebStorageMonster';

// Takes the marks out of store and returns a function that puts them back.
export function stepAside(store, prefix = MARK_PREFIX) {
  const held = [];
  for (let i = store.length - 1; i >= 0; i--) {
    const key = store.key(i);
    if (typeof key === 'string' && key.startsWith(prefix)) held.push([key, store.getItem(key)]);
  }
  for (const [key] of held) store.removeItem(key);
  return () => {
    for (const [key, value] of held) {
      try {
        store.setItem(key, value);
      } catch {
        // A full storage can't take the mark back. The tab acts as if it was never set.
      }
    }
  };
}

// monster: what requireLazy handed back, the module itself or an object with it as default.
// Returns whether there was a cleanNow to wrap.
export function wrapReport(monster, { win, onReport } = {}) {
  const target = typeof monster?.cleanNow === 'function' ? monster : monster?.default;
  const original = target?.cleanNow;
  if (typeof original !== 'function') return false;
  target.cleanNow = function cleanNow(...args) {
    let restore;
    try {
      restore = stepAside(win.sessionStorage);
    } catch {
      restore = null;
    }
    try {
      return original.apply(this, args);
    } finally {
      restore?.();
      onReport?.();
    }
  };
  return true;
}

export function keepOutOfStorageReport({ win, log, diagnostics }) {
  let state = 'waiting';
  let reports = 0;
  whenModule(win, MONSTER, (monster) => {
    state = wrapReport(monster, { win, onReport: () => { reports++; diagnostics?.changed(); } }) ? 'wrapped' : 'changed';
    if (state === 'changed') log?.warn("Facebook's storage report has changed, so the names of this script's marks for the tab may be in it");
    diagnostics?.changed();
  }, { log });
  diagnostics?.add("Facebook's storage report", () => {
    if (state === 'wrapped') return `This script's marks kept out of ${reports} report${reports === 1 ? '' : 's'}`;
    return state === 'changed' ? 'Changed, so the marks may be in it' : 'Not loaded yet';
  });
}
