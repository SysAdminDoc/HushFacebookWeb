import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { INSTANT_AD_METHODS, installInstantGamesHooks } from '../src/features/games/sdk.js';

function frame(extra = {}) {
  const timers = new Map();
  const listeners = new Map();
  let sequence = 0;
  const win = {
    Promise, Object,
    setInterval(callback) { timers.set(++sequence, callback); return sequence; },
    clearInterval(id) { timers.delete(id); },
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type, callback) { if (listeners.get(type) === callback) listeners.delete(type); },
    ...extra,
  };
  return {
    win, timers, listeners,
    tick() { for (const callback of timers.values()) callback(); },
    scriptLoaded() { listeners.get('load')?.({ target: { tagName: 'SCRIPT' } }); },
  };
}

function sdk() {
  const calls = [];
  const api = { startGameAsync: () => Promise.resolve('game') };
  for (const method of INSTANT_AD_METHODS) {
    api[method] = function (...args) {
      const answer = Promise.resolve({ method, args });
      calls.push({ method, args, receiver: this, answer });
      return answer;
    };
  }
  return { api, calls };
}

function install(t, win, options = {}) {
  const hook = installInstantGamesHooks({ win, ...options });
  t.after(() => hook.stop());
  return hook;
}

async function noFill(promise) {
  let failure;
  await assert.rejects(promise, (error) => {
    failure = error;
    return error.code === 'ADS_NO_FILL' && typeof error.message === 'string';
  });
  return failure;
}

test('all present ad APIs reject asynchronously with fresh no-fill errors and no SDK call', async (t) => {
  const { api, calls } = sdk();
  const { win } = frame({ FBInstant: api });
  const blocked = [];
  install(t, win, { enabled: () => true, onBlocked: (method) => blocked.push(method) });
  const failures = [];
  for (const method of INSTANT_AD_METHODS) {
    const first = api[method]('placement', { extra: true });
    const second = api[method]('placement');
    assert.ok(first instanceof win.Promise);
    assert.notEqual(first, second);
    failures.push(await noFill(first), await noFill(second));
  }
  assert.equal(new Set(failures).size, INSTANT_AD_METHODS.length * 2);
  assert.equal(calls.length, 0);
  assert.deepEqual(blocked, INSTANT_AD_METHODS.flatMap((method) => [method, method]));
  assert.equal(await api.startGameAsync(), 'game');
});

test('opt-in is off by default and forwards the original receiver, arguments, and exact return value', (t) => {
  const { api, calls } = sdk();
  const { win } = frame({ FBInstant: api });
  install(t, win);
  const receiver = {};
  const placement = {};
  const extra = Symbol('extra');
  const answer = api.loadBannerAdAsync.call(receiver, placement, 'top', extra);
  assert.equal(answer, calls[0].answer);
  assert.equal(calls[0].receiver, receiver);
  assert.deepEqual(calls[0].args, [placement, 'top', extra]);
});

test('a captured method follows later opt-in changes and keeps original synchronous throws', async (t) => {
  let on = false;
  const failure = new Error('SDK validation');
  const api = { getInterstitialAdAsync() { throw failure; } };
  const { win } = frame({ FBInstant: api });
  install(t, win, { enabled: () => on });
  const saved = api.getInterstitialAdAsync;
  assert.throws(() => saved(), (error) => error === failure);
  on = true;
  await noFill(saved());
  on = false;
  assert.throws(() => saved(), (error) => error === failure);
});

test('SDK assignments and global replacements are intercepted before their next ad call', async (t) => {
  const { win } = frame();
  install(t, win, { enabled: () => true });
  const first = sdk();
  win.FBInstant = first.api;
  assert.equal(win.FBInstant, first.api);
  await noFill(first.api.getRewardedVideoAsync('first'));
  const second = sdk();
  win.FBInstant = second.api;
  await noFill(second.api.loadBannerAdAsync('second'));
  assert.equal(first.calls.length + second.calls.length, 0);
});

test('a top-level var initializer uses the global trap and returns page-realm promises and errors', async (t) => {
  const context = vm.createContext({});
  const win = vm.runInContext('globalThis', context);
  const original = sdk();
  win.assignedSdk = original.api;
  install(t, win, { enabled: () => true });
  vm.runInContext('var FBInstant = assignedSdk;', context);
  const promise = vm.runInContext('FBInstant.getInterstitialAdAsync("placement")', context);
  assert.ok(promise instanceof win.Promise);
  assert.equal(promise instanceof Promise, false);
  const error = await noFill(promise);
  assert.equal(Object.getPrototypeOf(error), win.Object.prototype);
  assert.equal(original.calls.length, 0);
});

test('a protected global is reconciled after its SDK value is assigned or replaced', async (t) => {
  const f = frame();
  Object.defineProperty(f.win, 'FBInstant', { value: undefined, writable: true, configurable: false });
  install(t, f.win, { enabled: () => true });
  const first = sdk();
  f.win.FBInstant = first.api;
  f.tick();
  await noFill(first.api.getInterstitialAdAsync());
  const next = sdk();
  f.win.FBInstant = next.api;
  f.tick();
  await noFill(next.api.getRewardedVideoAsync());
});

test('methods filled in after SDK assignment are found on script load without adding unsupported APIs', async (t) => {
  const f = frame({ FBInstant: {} });
  install(t, f.win, { enabled: () => true });
  assert.equal('getRewardedInterstitialAsync' in f.win.FBInstant, false);
  let calls = 0;
  f.win.FBInstant.getInterstitialAdAsync = () => { calls++; return Promise.resolve(); };
  f.scriptLoaded();
  await noFill(f.win.FBInstant.getInterstitialAdAsync());
  assert.equal(calls, 0);
});

test('ad method replacements stay blocked immediately and cleanup keeps the latest function', async (t) => {
  const { api } = sdk();
  const { win } = frame({ FBInstant: api });
  const hook = install(t, win, { enabled: () => true });
  const replacement = () => 'new method';
  api.getInterstitialAdAsync = replacement;
  await noFill(api.getInterstitialAdAsync());
  hook.stop();
  assert.equal(api.getInterstitialAdAsync, replacement);
});

test('writable protected SDK methods are reported unsupported without a misleading polling wrapper', (t) => {
  const first = () => 'first';
  const api = {};
  Object.defineProperty(api, 'getInterstitialAdAsync', { value: first, writable: true, configurable: false });
  const f = frame({ FBInstant: api });
  const warnings = [];
  const hook = install(t, f.win, { enabled: () => true, log: { warn: (...args) => warnings.push(args) } });
  assert.equal(api.getInterstitialAdAsync, first);
  assert.equal(api.getInterstitialAdAsync(), 'first');
  const second = () => 'second';
  api.getInterstitialAdAsync = second;
  const saved = api.getInterstitialAdAsync;
  assert.equal(api.getInterstitialAdAsync(), 'second', 'an immediate replacement call is explicitly unsupported');
  f.tick();
  assert.equal(api.getInterstitialAdAsync, second, 'refresh does not pretend the protected method is safe');
  assert.equal(saved(), 'second');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /unsupported; its ads are not blocked/);
  hook.stop();
  assert.equal(api.getInterstitialAdAsync, second);
  assert.equal(Object.getOwnPropertyDescriptor(api, 'getInterstitialAdAsync').configurable, false);
});

test('protected SDK methods are left intact and reported once rather than breaking the game', (t) => {
  const original = () => 'protected';
  const api = Object.freeze({ getInterstitialAdAsync: original });
  const f = frame({ FBInstant: api });
  const warnings = [];
  install(t, f.win, { enabled: () => true, log: { warn: (...args) => warnings.push(args) } });
  f.tick();
  f.tick();
  assert.equal(api.getInterstitialAdAsync, original);
  assert.equal(api.getInterstitialAdAsync(), 'protected');
  assert.equal(warnings.length, 1);
});

test('global and method accessor setters keep their receivers and cleanup restores descriptors', async (t) => {
  const f = frame();
  const receivers = [];
  let current;
  const descriptor = {
    get() { return current; },
    set(value) { receivers.push(this); current = value; },
    configurable: true, enumerable: false,
  };
  Object.defineProperty(f.win, 'FBInstant', descriptor);
  const hook = install(t, f.win, { enabled: () => true });
  const api = {};
  let method = () => 'original';
  const methodDescriptor = {
    get() { return method; },
    set(value) { receivers.push(this); method = value; },
    configurable: true, enumerable: true,
  };
  Object.defineProperty(api, 'getInterstitialAdAsync', methodDescriptor);
  f.win.FBInstant = api;
  const latest = () => 'latest';
  api.getInterstitialAdAsync = latest;
  await noFill(api.getInterstitialAdAsync());
  assert.deepEqual(receivers, [f.win, api]);
  hook.stop();
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.win, 'FBInstant'), descriptor);
  assert.deepEqual(Object.getOwnPropertyDescriptor(api, 'getInterstitialAdAsync'), methodDescriptor);
  assert.equal(api.getInterstitialAdAsync, latest);
});

test('a read-only SDK method remains read-only while wrapped', async (t) => {
  const api = {};
  const original = () => 'original';
  Object.defineProperty(api, 'getInterstitialAdAsync', { value: original, writable: false, configurable: true });
  const { win } = frame({ FBInstant: api });
  const hook = install(t, win, { enabled: () => true });
  await noFill(api.getInterstitialAdAsync());
  assert.throws(() => { api.getInterstitialAdAsync = () => {}; }, TypeError);
  hook.stop();
  assert.equal(api.getInterstitialAdAsync, original);
  assert.equal(Object.getOwnPropertyDescriptor(api, 'getInterstitialAdAsync').writable, false);
});

test('cleanup removes an unused global trap, timers, and listeners and makes retained wrappers pass through', async (t) => {
  const f = frame();
  const hook = install(t, f.win, { enabled: () => true });
  assert.equal(f.timers.size, 1);
  hook.stop();
  hook.stop();
  assert.equal(Object.hasOwn(f.win, 'FBInstant'), false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);

  const { api, calls } = sdk();
  const next = install(t, f.win, { enabled: () => true });
  f.win.FBInstant = api;
  const saved = api.getInterstitialAdAsync;
  await noFill(saved());
  next.stop();
  const receiver = {};
  const answer = saved.call(receiver, 'after stop');
  assert.equal(answer, calls[0].answer);
  assert.equal(calls[0].receiver, receiver);
  assert.equal(f.win.FBInstant, api);
  assert.equal(Object.getOwnPropertyDescriptor(f.win, 'FBInstant').writable, true);
});

test('cleanup does not overwrite another library replacing SDK or global descriptors', (t) => {
  const { api } = sdk();
  const { win } = frame({ FBInstant: api });
  const hook = install(t, win, { enabled: () => true });
  const external = () => 'external';
  Object.defineProperty(api, 'getInterstitialAdAsync', { value: external, writable: true, configurable: true });
  const nextSdk = {};
  Object.defineProperty(win, 'FBInstant', { value: nextSdk, writable: true, configurable: true });
  hook.stop();
  assert.equal(api.getInterstitialAdAsync, external);
  assert.equal(win.FBInstant, nextSdk);
});

test('defineProperty global replacements are reconciled and get their own assignment trap', async (t) => {
  const f = frame();
  install(t, f.win, { enabled: () => true });
  const first = sdk();
  Object.defineProperty(f.win, 'FBInstant', { value: first.api, writable: true, configurable: true });
  f.tick();
  await noFill(first.api.getInterstitialAdAsync());
  const next = sdk();
  f.win.FBInstant = next.api;
  await noFill(next.api.getRewardedVideoAsync());
});

test('a failing setting callback fails open and a failing counter cannot change the no-fill result', async (t) => {
  const { api, calls } = sdk();
  const { win } = frame({ FBInstant: api });
  const warnings = [];
  let readable = false;
  install(t, win, {
    enabled() { if (!readable) throw new Error('setting unavailable'); return true; },
    onBlocked() { throw new Error('counter unavailable'); },
    log: { warn: (...args) => warnings.push(args) },
  });
  api.getInterstitialAdAsync();
  api.getInterstitialAdAsync();
  assert.equal(calls.length, 2);
  assert.equal(warnings.length, 1);
  readable = true;
  await noFill(api.getInterstitialAdAsync());
  await noFill(api.getInterstitialAdAsync());
  assert.equal(calls.length, 2);
  assert.equal(warnings.length, 2);
});

test('installation is idempotent and SDK values that are not objects are harmless', async (t) => {
  const f = frame({ FBInstant: null });
  const hook = install(t, f.win, { enabled: () => true });
  assert.equal(installInstantGamesHooks({ win: f.win }), hook);
  assert.equal(f.timers.size, 1);
  for (const value of [undefined, null, 0, 'not loaded']) { f.win.FBInstant = value; f.tick(); }
  const { api } = sdk();
  f.win.FBInstant = api;
  await noFill(api.getInterstitialAdAsync());
});

test('a logger failure cannot turn an ad rejection into an unrelated synchronous throw', async (t) => {
  const { api } = sdk();
  const { win } = frame({ FBInstant: api });
  install(t, win, {
    enabled: () => true,
    onBlocked() { throw new Error('counter failed'); },
    log: { warn() { throw new Error('logger failed'); } },
  });
  await noFill(api.getInterstitialAdAsync());
});

test('an SDK frozen after installation still passes through after cleanup', async (t) => {
  const { api, calls } = sdk();
  const { win } = frame({ FBInstant: api });
  const warnings = [];
  const hook = install(t, win, { enabled: () => true, log: { warn: (...args) => warnings.push(args) } });
  const saved = api.getInterstitialAdAsync;
  Object.freeze(api);
  await noFill(saved());
  assert.doesNotThrow(() => hook.stop());
  const answer = api.getInterstitialAdAsync('after freeze');
  assert.equal(answer, calls[0].answer);
  saved('retained reference');
  assert.equal(calls.length, 2);
  assert.equal(warnings.length, INSTANT_AD_METHODS.length);
});
