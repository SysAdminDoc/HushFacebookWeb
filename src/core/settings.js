// Settings built from the feature list. Only values that differ from their default are
// stored, so changing a default in a later version reaches everyone who never touched it.

const STORAGE_KEY = 'settings';

const GLOBAL_SETTINGS = [
  { key: 'paused', type: 'toggle', default: false, label: 'Pause HushFacebook Web' },
  { key: 'ui.launcher', type: 'toggle', default: true, label: 'Show the settings button on Facebook' },
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

export function createSettings({ storage, features, log, version = 'dev' }) {
  const schema = buildSchema(features);
  const listeners = new Set();
  let values = sanitize(storage.get(STORAGE_KEY, {}));

  function sanitize(raw) {
    const clean = {};
    if (!raw || typeof raw !== 'object') return clean;
    for (const [key, value] of Object.entries(raw)) {
      const spec = schema.get(key);
      if (spec && isValid(spec, value) && value !== spec.default) clean[key] = value;
    }
    return clean;
  }

  function persist() {
    try {
      storage.set(STORAGE_KEY, values);
    } catch (error) {
      log?.error('Could not save settings', error);
      throw error;
    }
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

  storage.onChange?.(STORAGE_KEY, (raw) => {
    values = sanitize(raw);
    notify([...schema.keys()], true);
  });

  function get(key) {
    return Object.hasOwn(values, key) ? values[key] : spec(key).default;
  }

  return {
    schema,
    get,
    set(key, value) {
      const found = spec(key);
      if (!isValid(found, value)) throw new TypeError(`Invalid value for ${key}: ${JSON.stringify(value)}`);
      if (value === found.default) delete values[key];
      else values[key] = value;
      persist();
      notify([key]);
    },
    // A feature runs only when it's switched on and the whole script isn't paused.
    enabled(featureId) {
      return get('paused') !== true && get(featureId) === true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => structuredClone(values),
    restore(snapshot) {
      values = sanitize(snapshot);
      persist();
      notify([...schema.keys()]);
    },
    reset() {
      const previous = structuredClone(values);
      values = {};
      persist();
      notify([...schema.keys()]);
      return previous;
    },
    exportJson(now = new Date()) {
      return JSON.stringify({ app: 'HushFacebook Web', version, exported: now.toISOString(), settings: values }, null, 2);
    },
    importJson(text) {
      const parsed = JSON.parse(text);
      const incoming = parsed && typeof parsed.settings === 'object' ? parsed.settings : parsed;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        throw new TypeError('That file has no HushFacebook Web settings in it');
      }
      const applied = [];
      const skipped = [];
      for (const [key, value] of Object.entries(incoming)) {
        const found = schema.get(key);
        if (!found || !isValid(found, value)) {
          skipped.push(key);
          continue;
        }
        if (value === found.default) delete values[key];
        else values[key] = value;
        applied.push(key);
      }
      persist();
      notify(applied);
      return { applied, skipped };
    },
  };
}
