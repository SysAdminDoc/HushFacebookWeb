// Dots on settings an update added. The keys of every switch and option the panel has shown are
// saved under SEEN_SETTINGS_KEY, and a key missing from that list is new. Nothing records which
// version a setting came in, so the list is the comparison: the first time the panel opens
// nothing is saved, every key counts as seen and no dot shows.
//
// A new key keeps its dot, and its section's, until the panel closes after that section was on
// screen. A search result isn't a visit. Storage that isn't loaded yet, or fails, shows no dots
// and saves nothing. The list stays out of backups, which carry settings only.

export const SEEN_SETTINGS_KEY = 'panel.seenSettings';
// A key the list no longer needs (a setting since removed) stays, so a tab still on the older
// version can't make the newer one's settings new again. The cap only guards the record's size.
export const SEEN_SETTINGS_MAX = 4000;

export const featureKeys = (feature) => [feature.id, ...(feature.options ?? []).map((option) => `${feature.id}.${option.key}`)];

export function createNewDots({ storage, features, log }) {
  let fresh = new Set();
  const visited = new Set();
  const ready = () => Boolean(storage) && (typeof storage.status !== 'function' || storage.status().state === 'ready');
  const saved = () => {
    const list = storage.get(SEEN_SETTINGS_KEY, null);
    return Array.isArray(list) ? list.filter((key) => typeof key === 'string') : null;
  };
  const save = (keys) => {
    const list = [...new Set([...(saved() ?? []), ...keys])].slice(-SEEN_SETTINGS_MAX);
    Promise.resolve(storage.set(SEEN_SETTINGS_KEY, list)).catch((error) => log?.warn("Couldn't save which settings are new", error));
  };

  return {
    // When the panel opens from closed.
    start() {
      fresh = new Set();
      visited.clear();
      try {
        if (!ready()) return;
        const all = features.flatMap(featureKeys);
        const seen = saved();
        if (seen === null) {
          save(all);
          return;
        }
        const known = new Set(seen);
        fresh = new Set(all.filter((key) => !known.has(key)));
      } catch (error) {
        fresh = new Set();
        log?.warn("Couldn't read which settings are new", error);
      }
    },
    visit(sectionId) {
      visited.add(sectionId);
    },
    // When the panel closes: what was on screen stops being new.
    finish() {
      const done = features.filter((feature) => visited.has(feature.section)).flatMap(featureKeys).filter((key) => fresh.has(key));
      visited.clear();
      if (!done.length) return;
      try {
        save(done);
      } catch (error) {
        log?.warn("Couldn't save which settings are new", error);
      }
    },
    isNew: (key) => fresh.has(key),
    // A feature that's off hides its options, so its card carries their dots too.
    featureIsNew: (feature) => featureKeys(feature).some((key) => fresh.has(key)),
    sectionIsNew: (sectionId) => features.some((feature) => feature.section === sectionId && featureKeys(feature).some((key) => fresh.has(key))),
  };
}
