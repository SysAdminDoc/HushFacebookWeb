// Meta's SDK returns rejected promises with code/message on ad failures.
// https://developers.facebook.com/documentation/games/sdk-reference/v8.0
// The legacy rewarded-interstitial method is wrapped only when present.

export const INSTANT_AD_METHODS = Object.freeze([
  'getInterstitialAdAsync',
  'getRewardedVideoAsync',
  'getRewardedInterstitialAsync',
  'loadBannerAdAsync',
]);

const installations = new WeakMap();
const POLL_MS = 250;
const isObject = (value) => value !== null && (typeof value === 'object' || typeof value === 'function');

// Accessors catch ordinary assignments, including an initializer on a global var.
// Keep the underlying value separate so cleanup preserves assignments made later.
function watchProperty(target, key, transform) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  // A writable, non-configurable value can be changed without calling us. A
  // polling wrapper would leave a window for an ad to start, so report it unsupported.
  if (original && !original.configurable) return null;

  const accessor = original && !('value' in original);
  let value = accessor ? undefined : Reflect.get(target, key);
  let assigned = false;
  const get = function () {
    const current = accessor ? original.get?.call(this) : value;
    return transform(current);
  };
  const writable = accessor ? typeof original.set === 'function' : original?.writable !== false;
  const set = writable ? function (next) {
    if (accessor) original.set.call(this, next);
    else value = next;
    assigned = true;
    transform(next);
  } : undefined;
  Object.defineProperty(target, key, {
    get, set, configurable: true, enumerable: original?.enumerable ?? true,
  });
  const owns = () => {
    const current = Object.getOwnPropertyDescriptor(target, key);
    return current?.get === get && current?.set === set;
  };
  return {
    owns,
    restore() {
      if (!owns()) return;
      if (accessor) Object.defineProperty(target, key, original);
      else if (original) Object.defineProperty(target, key, { ...original, value });
      else if (assigned) Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
      else Reflect.deleteProperty(target, key);
    },
  };
}

export function installInstantGamesHooks({ win, enabled = () => false, onBlocked, log } = {}) {
  if (installations.has(win)) return installations.get(win);
  const reject = win.Promise.reject.bind(win.Promise);
  const RealmObject = win.Object ?? Object;
  const sdks = new Map();
  const warned = new Set();
  let running = true;
  let globalWatch = null;
  let timer = null;

  const warn = (key, message, error) => {
    if (warned.has(key)) return;
    warned.add(key);
    // Diagnostics must not turn an SDK call into an unrelated synchronous throw.
    try { log?.warn?.(message, error); } catch { /* The supplied logger failed too. */ }
  };
  const active = () => {
    if (!running) return false;
    try { return enabled() === true; }
    catch (error) {
      warn('enabled', 'Could not read the Instant Games ad setting; the SDK call was left alone', error);
      return false;
    }
  };
  const wrap = (original, method) => function (...args) {
    if (!active()) return Reflect.apply(original, this, args);
    const error = new RealmObject();
    error.code = 'ADS_NO_FILL';
    error.message = 'No ad is available.';
    try { onBlocked?.(method); }
    catch (failure) { warn('onBlocked', 'Could not count a held-back Instant Games ad', failure); }
    return reject(error);
  };

  const patchSdk = (sdk) => {
    if (!running || !isObject(sdk)) return sdk;
    let methods = sdks.get(sdk);
    if (!methods) sdks.set(sdk, methods = new Map());
    for (const method of INSTANT_AD_METHODS) {
      try {
        if (methods.get(method)?.owns()) continue;
        // Do not make an unsupported ad API appear to exist.
        if (typeof Reflect.get(sdk, method) !== 'function') continue;
        const wrappers = new WeakMap();
        const transform = (value) => {
          if (!running || typeof value !== 'function') return value;
          if (!wrappers.has(value)) wrappers.set(value, wrap(value, method));
          return wrappers.get(value);
        };
        const watcher = watchProperty(sdk, method, transform);
        if (watcher) methods.set(method, watcher);
        else warn(method, `Instant Games ${method} is protected and unsupported; its ads are not blocked`);
      } catch (error) {
        warn(method, `Could not wrap Instant Games ${method}; the SDK property was left alone`, error);
      }
    }
    return sdk;
  };

  const refresh = () => {
    if (!running) return;
    try {
      if (!globalWatch?.owns()) {
        globalWatch = watchProperty(win, 'FBInstant', patchSdk);
        if (!globalWatch && Object.getOwnPropertyDescriptor(win, 'FBInstant')?.writable) {
          warn('protected-global', 'The Instant Games SDK global is protected; replacement SDKs may request ads before the next check');
        }
      }
      patchSdk(Reflect.get(win, 'FBInstant'));
    } catch (error) {
      warn('global', 'Could not watch the Instant Games SDK global', error);
    }
  };
  const onLoad = (event) => { if (event.target?.tagName === 'SCRIPT') refresh(); };
  const api = {
    refresh,
    stop() {
      if (!running) return;
      running = false;
      if (timer !== null) win.clearInterval(timer);
      win.removeEventListener?.('load', onLoad, true);
      for (const methods of sdks.values()) {
        for (const [method, watcher] of methods) {
          try { watcher.restore(); }
          catch (error) { warn(`restore:${method}`, `Could not restore Instant Games ${method}; retained wrappers now pass through`, error); }
        }
      }
      try { globalWatch?.restore(); }
      catch (error) { warn('restore:global', 'Could not restore the Instant Games global; the SDK remains available', error); }
      sdks.clear();
      installations.delete(win);
    },
  };
  installations.set(win, api);
  refresh();
  // Late methods, protected globals and defineProperty replacements bypass the
  // setter. Recovery here is best effort; their calls before refresh are unfiltered.
  if (typeof win.setInterval === 'function') timer = win.setInterval(refresh, POLL_MS);
  win.addEventListener?.('load', onLoad, true);
  return api;
}
