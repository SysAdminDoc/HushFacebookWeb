// Settings built from the feature list. Only values that differ from their default are
// stored, so changing a default in a later version reaches everyone who never touched it.
//
// Each Facebook account keeps its own settings, the way Social Fixer and F.B. Purity do it,
// under a key made from the account's id (the c_user cookie). The id itself isn't stored.
// An account seen for the first time starts from the settings everyone shared before, so
// nothing is lost on upgrade. Signed out, the shared settings are used.

const STORAGE_KEY = 'settings';
export const EXPORT_SCHEMA = 1;
export const MAX_BACKUP_BYTES = 1024 * 1024;

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
  let values = ready ? migrate(load()) : {};
  let pageLoadValues = ready ? structuredClone(values) : {};
  const changedBeforeReady = new Set();
  if (!ready) {
    storage.whenReady(() => {
      ready = true;
      if (storage.getAtLoad) {
        const changedValues = values;
        const get = (name, fallback) => storage.getAtLoad(name, fallback);
        const inheritedShared = key !== STORAGE_KEY && get(key, undefined) === undefined;
        const storedMigrations = migrationRecord(get);
        const migration = migrationResult(read(get), storedMigrations);
        pageLoadValues = migration.after;
        load();
        values = { ...pageLoadValues };
        for (const key of changedBeforeReady) {
          if (Object.hasOwn(changedValues, key)) values[key] = changedValues[key];
          else delete values[key];
        }
        values = sanitize(values);
        saveMigration(migration, values, changedBeforeReady.size > 0);
        if (inheritedShared && !migration.pending.length && Array.isArray(storedMigrations)) {
          try {
            storage.set(doneKey, storedMigrations);
          } catch (error) {
            log?.error('Could not copy your settings to this account', error);
          }
        }
      } else {
        values = migrate(load());
        pageLoadValues = structuredClone(values);
        for (const key of changedBeforeReady) delete pageLoadValues[key];
      }
      notify([...schema.keys()], true);
    });
  }

  function read(get, copyShared = false) {
    const own = get(key, undefined);
    if (own !== undefined || key === STORAGE_KEY) return own ?? {};
    const shared = sanitize(get(STORAGE_KEY, {}));
    if (copyShared) {
      try {
        if (Object.keys(shared).length) storage.set(key, shared);
        // The copy has already had whatever the shared settings had.
        const sharedDone = storage.get(`${STORAGE_KEY}.migrated`, undefined);
        if (Array.isArray(sharedDone)) storage.set(doneKey, sharedDone);
      } catch (error) {
        log?.error('Could not copy your settings to this account', error);
      }
    }
    return shared;
  }

  function load() {
    return read(storage.get, true);
  }

  function migrationResult(raw, stored) {
    const done = Array.isArray(stored) ? stored : [];
    const before = sanitize(raw);
    const pending = migrations.filter((migration) => !done.includes(migration.id));
    if (!pending.length) return { before, after: before, done, pending };
    const next = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
    for (const migration of pending) migration.run(next);
    return { before, after: sanitize(next), done, pending };
  }

  function migrationRecord(get) {
    const own = get(doneKey, undefined);
    if (own !== undefined || key === STORAGE_KEY || get(key, undefined) !== undefined) return own;
    return get(`${STORAGE_KEY}.migrated`, undefined);
  }

  function migrate(raw) {
    const migration = migrationResult(raw, migrationRecord(storage.get));
    saveMigration(migration);
    return migration.after;
  }

  function saveMigration({ before, after, done, pending }, valuesToSave = after, forceValues = false) {
    if (!pending.length && !forceValues) return;
    try {
      if (forceValues || JSON.stringify(valuesToSave) !== JSON.stringify(before)) storage.set(key, valuesToSave);
      if (pending.length) storage.set(doneKey, [...done, ...pending.map((migration) => migration.id)]);
    } catch (error) {
      log?.error('Could not save a settings update', error);
    }
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

  function persist(next, keys) {
    try {
      storage.set(key, next);
    } catch (error) {
      log?.error('Could not save settings', error);
      throw error;
    }
    values = next;
    if (!ready) for (const key of keys) changedBeforeReady.add(key);
    notify(keys);
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
    if (!ready) {
      if (change?.source === 'load') return;
      values = sanitize(raw);
      changedBeforeReady.clear();
      notify([...schema.keys()], true);
      return;
    }
    values = sanitize(raw);
    notify([...schema.keys()], true);
  });

  function get(key) {
    return Object.hasOwn(values, key) ? values[key] : spec(key).default;
  }

  function pageLoadValue(key) {
    return Object.hasOwn(pageLoadValues, key) ? pageLoadValues[key] : spec(key).default;
  }

  return {
    schema,
    perAccount: key !== STORAGE_KEY,
    // Runs once the saved choices are in: at once from a userscript manager, a few
    // milliseconds in from the extension's storage. For decisions made only as the page starts.
    whenLoaded: (run) => (storage.whenReady ? storage.whenReady(run) : run()),
    get,
    pageLoadValue,
    set(key, value) {
      const found = spec(key);
      if (!isValid(found, value)) throw new TypeError(`Invalid value for ${key}: ${JSON.stringify(value)}`);
      const next = { ...values };
      if (value === found.default) delete next[key];
      else next[key] = value;
      persist(next, [key]);
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
      persist(sanitize(snapshot), [...schema.keys()]);
    },
    reset() {
      const previous = structuredClone(values);
      persist({}, [...schema.keys()]);
      return previous;
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
      persist(next, wrapped ? [...schema.keys()] : applied);
      return { applied, skipped };
    },
  };
}
