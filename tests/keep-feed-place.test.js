import { test } from 'node:test';
import assert from 'node:assert/strict';
import keepFeedPlace, { CONSTANTS, LIMITS, NEVER, ROUTES, holdLimits, holdRouteCheck } from '../src/features/feed/keep-feed-place.js';
import { afterModuleRuns, whenModule } from '../src/core/modules.js';

// Facebook's two modules, shaped the way the served code builds them (run 34): plain exports
// set one by one, the limits in milliseconds. The opened-post limit comes from an experiment
// value, read as the module runs.
function fillConstants(exports, require) {
  const pushView = require ? require('qex')._('2712') ?? 1800 : 1800;
  exports.FEED_STALE_TIMEOUT = 600 * 1e3;
  exports.FEED_VISIBILITY_TIMEOUT = 120 * 1e3;
  exports.FEED_STALE_PUSH_VIEW_TIMEOUT = pushView * 1e3;
  exports.FEED_MAX_QUERY_AGE_IN_SEC = 180;
  exports.BADGE_STALE_TIMEOUT = 600 * 1e3;
  exports.STALE_REFRESH_MODE = 'WARM';
}
function constantsModule() {
  const exports = {};
  fillConstants(exports);
  return exports;
}
function fillRoutes(exports) {
  exports.isRouteEligible = (route) => ['comet.group', 'comet.marketplace.home', 'comet.search_results.default_tab'].includes(route);
}

// The decisions Facebook's hooks make with them, read off each module's exports when they fire.
// useCometHomeStaleFeedRefresh, when the page is shown again or you're active again:
const reloadsHome = (limits, idleMs, hiddenMs) => idleMs > limits.FEED_STALE_TIMEOUT || hiddenMs > limits.FEED_VISIBILITY_TIMEOUT;
// useStaleSessionReturnToFeed, half an hour away on one of the routes it covers:
const sendsHome = (routes, route, awayMs) => routes.isRouteEligible(route) && awayMs > 1800 * 1e3;
const HOUR = 3600 * 1e3;
const WAITING = "Facebook's code isn't loaded yet";

// Facebook's loader the way the served page has it (run 34, run 66). The page starts with a stub
// __d that queues definitions, set in the same inline script as requireLazy, and swaps its loader
// in with a plain assignment. A module's factory runs the first time something asks for the
// module, as factory(global, require, importDefault, importNamespace, requireLazy, module,
// exports), and a factory that throws is kept as a failure. requireLazy asks for the modules it
// names as soon as they're defined. Facebook's experiment values come with the page, and reading
// one that hasn't arrived throws invariant 11799.
function page({ loaderLater = false, stub = false, experimentsLater = false } = {}) {
  const factories = new Map();
  const results = new Map();
  const experiments = new Map();
  const queued = [];
  const ran = [];
  const asked = [];
  const caught = [];
  let waiting = [];
  const listeners = new Map();
  const observers = [];
  const listen = (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  const win = { document: { addEventListener: listen }, addEventListener: listen };
  win.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      observers.push(this);
    }
    disconnect() {
      const at = observers.indexOf(this);
      if (at >= 0) observers.splice(at, 1);
    }
  };
  const qex = {
    _: (id) => {
      if (!experiments.has(id)) throw new Error(`Minified invariant #11799; Params: ${id}`);
      return experiments.get(id);
    },
  };
  const require = (name) => {
    if (name === 'qex') return qex;
    if (!results.has(name)) {
      const module = { exports: {} };
      ran.push(name);
      try {
        factories.get(name)(win, require, require, require, requireLazy, module, module.exports);
        results.set(name, { exports: module.exports });
      } catch (error) {
        results.set(name, { error });
      }
    }
    const result = results.get(name);
    if (result.error) throw result.error;
    return result.exports;
  };
  function requireLazy(names, callback) {
    asked.push(...names);
    const run = () => {
      if (!names.every((name) => factories.has(name))) return false;
      try {
        callback(...names.map(require));
      } catch (error) {
        caught.push(error);
      }
      return true;
    };
    if (!run()) waiting.push(run);
  }
  const loader = function (name, deps, factory) {
    factories.set(name, factory);
    waiting = waiting.filter((run) => !run());
  };
  const stubDefiner = function (name, deps, factory, flags) {
    queued.push([name, deps, factory, flags]);
  };
  const setUp = () => {
    win.__d = stub ? stubDefiner : loader;
    win.requireLazy = requireLazy;
  };
  if (!experimentsLater) experiments.set('2712', null);
  if (!loaderLater) setUp();
  return {
    win,
    asked,
    ran,
    caught,
    factories,
    require,
    // A bundle defining a module calls the global __d.
    define(name, fill) {
      win.__d(name, [], function (t, n, r, o, a, i, l) {
        fill(l, n, i);
      }, 98);
    },
    loaderArrives: setUp,
    // The loader replaces the stub and takes over what it queued.
    loaderSwaps() {
      win.__d = loader;
      for (const [name, deps, factory] of queued.splice(0)) loader(name, deps, factory);
    },
    experimentsArrive() {
      experiments.set('2712', null);
    },
    parse() {
      for (const observer of [...observers]) observer.callback([]);
    },
    fire(type) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
}

function start({ on = true, ...options } = {}) {
  const fb = page(options);
  const switchState = { on };
  const listeners = [];
  const rows = new Map();
  const warnings = [];
  let unavailable = 0;
  keepFeedPlace.setup({
    win: fb.win,
    settings: { subscribe: (fn) => listeners.push(fn) },
    enabled: () => switchState.on,
    diagnostics: { add: (name, read) => rows.set(name, read), changed() {} },
    log: { warn: (message) => warnings.push(message), error: (message) => warnings.push(message) },
    markUnavailable: () => unavailable++,
  });
  return {
    fb,
    warnings,
    unavailable: () => unavailable,
    row: (name) => rows.get(name)(),
    turn(value) {
      switchState.on = value;
      for (const fn of listeners) fn();
    },
  };
}

test('Home left for an hour stays where it was with the switch on, and reloads with it off', () => {
  const run = start();
  assert.equal(reloadsHome(constantsModule(), HOUR, HOUR), true);
  run.fb.define(CONSTANTS, fillConstants);
  const limits = run.fb.require(CONSTANTS);
  assert.equal(reloadsHome(limits, HOUR, HOUR), false);
  assert.equal(reloadsHome(limits, 30 * 24 * HOUR, 0), true, 'a month idle is still more than the longest a timer takes');
  run.turn(false);
  assert.equal(reloadsHome(limits, HOUR, 0), true);
  assert.equal(reloadsHome(limits, 0, 3 * 60 * 1e3), true);
  assert.equal(reloadsHome(limits, 0, 60 * 1e3), false, "Facebook's own limits are back with the switch off");
  run.turn(true);
  assert.equal(reloadsHome(limits, HOUR, HOUR), false);
  assert.deepEqual([limits.FEED_MAX_QUERY_AGE_IN_SEC, limits.BADGE_STALE_TIMEOUT, limits.STALE_REFRESH_MODE], [180, 600 * 1e3, 'WARM'], 'nothing else in the module changes');
  assert.equal(run.row('Return refresh on Home'), 'held');
});

test("the limits are never asked for, so a page whose experiment values come late still draws", () => {
  const run = start({ experimentsLater: true });
  run.fb.define(CONSTANTS, fillConstants);
  assert.deepEqual(run.fb.ran, [], "the limits wait for Facebook's own code to run them");
  assert.equal(run.row('Return refresh on Home'), WAITING);
  run.fb.experimentsArrive();
  const limits = run.fb.require(CONSTANTS);
  assert.equal(reloadsHome(limits, HOUR, HOUR), false);
  assert.equal(limits.FEED_STALE_PUSH_VIEW_TIMEOUT, NEVER);
  assert.equal(run.row('Return refresh on Home'), 'held');
});

test("asking for the limits before their experiment values arrive breaks them for Facebook too", () => {
  // Why the limits aren't asked for: this is what left Feeds on the splash screen.
  const fb = page({ experimentsLater: true });
  whenModule(fb.win, CONSTANTS, () => {});
  fb.define(CONSTANTS, fillConstants);
  assert.match(String(fb.caught[0]), /invariant #11799/);
  fb.experimentsArrive();
  assert.throws(() => fb.require(CONSTANTS), /invariant #11799/, 'the loader keeps the failure');
});

test('the limit for a post opened over the feed is a timer delay that waits, never one that fires at once', async () => {
  const run = start();
  run.fb.define(CONSTANTS, fillConstants);
  const limits = run.fb.require(CONSTANTS);
  // useCometFeedPushViewCloseRefresh hands this limit to setTimeout. Infinity, or anything over
  // 2^31 - 1, would make that timer fire straight away.
  assert.equal(limits.FEED_STALE_PUSH_VIEW_TIMEOUT, NEVER);
  assert.ok(NEVER <= 2 ** 31 - 1 && NEVER > 24 * HOUR);
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
  }, limits.FEED_STALE_PUSH_VIEW_TIMEOUT);
  await new Promise((resolve) => setTimeout(resolve, 30));
  clearTimeout(timer);
  assert.equal(fired, false);
});

test('a group, Marketplace or search stays put after half an hour away with the switch on', () => {
  const run = start();
  run.fb.define(ROUTES, fillRoutes);
  const routes = run.fb.require(ROUTES);
  for (const route of ['comet.group', 'comet.marketplace.home', 'comet.search_results.default_tab']) {
    assert.equal(sendsHome(routes, route, HOUR), false, route);
  }
  run.turn(false);
  assert.equal(sendsHome(routes, 'comet.group', HOUR), true);
  assert.equal(sendsHome(routes, 'comet.profile', HOUR), false, 'a route Facebook never moves stays that way');
  assert.equal(routes.isRouteEligible.call(routes, 'comet.marketplace.home'), true);
  assert.equal(run.row('Return to Home from other pages'), 'held');
});

test("Facebook's modules are left alone until the switch is first turned on", () => {
  const run = start({ on: false });
  const definer = run.fb.win.__d;
  run.fb.define(CONSTANTS, fillConstants);
  run.fb.define(ROUTES, fillRoutes);
  const limits = run.fb.require(CONSTANTS);
  const routes = run.fb.require(ROUTES);
  const check = routes.isRouteEligible;
  assert.deepEqual(run.fb.asked, []);
  assert.equal(Object.getOwnPropertyDescriptor(run.fb.win, '__d').value, definer, "Facebook's module definer isn't wrapped");
  assert.equal(Object.getOwnPropertyDescriptor(limits, 'FEED_STALE_TIMEOUT').value, 600 * 1e3);
  assert.equal(routes.isRouteEligible, check);
  assert.equal(run.row('Return refresh on Home'), 'switch off');
  run.turn(true);
  assert.deepEqual(run.fb.asked, [ROUTES], 'the limits are never asked for');
  assert.equal(sendsHome(routes, 'comet.group', HOUR), false);
  assert.equal(reloadsHome(limits, HOUR, HOUR), true, 'limits Facebook already ran are held from the next page load');
  assert.equal(run.row('Return refresh on Home'), WAITING);
  run.turn(false);
  run.turn(true);
  assert.deepEqual(run.fb.asked, [ROUTES], 'asked once, however often the switch moves');
});

test("Facebook's loader is used as soon as the page sets it up when it isn't there at start", () => {
  const run = start({ loaderLater: true });
  assert.deepEqual(run.fb.asked, []);
  assert.equal(run.row('Return refresh on Home'), WAITING);
  run.fb.loaderArrives();
  run.fb.parse();
  run.fb.define(CONSTANTS, fillConstants);
  const limits = run.fb.require(CONSTANTS);
  assert.equal(reloadsHome(limits, HOUR, HOUR), false, 'held before the page finishes parsing');
  run.fb.fire('DOMContentLoaded');
  run.fb.fire('load');
  assert.deepEqual(run.fb.asked, [ROUTES]);
});

test('the loader Facebook swaps in for its stub goes through the same wrapper', () => {
  const queuedFirst = start({ stub: true });
  queuedFirst.fb.define(CONSTANTS, fillConstants);
  queuedFirst.fb.loaderSwaps();
  assert.equal(reloadsHome(queuedFirst.fb.require(CONSTANTS), HOUR, HOUR), false, 'a module the stub queued');
  const swappedFirst = start({ stub: true });
  swappedFirst.fb.loaderSwaps();
  swappedFirst.fb.define(CONSTANTS, fillConstants);
  assert.equal(reloadsHome(swappedFirst.fb.require(CONSTANTS), HOUR, HOUR), false, 'a module defined after the swap');
});

test('a replacement that wraps the current module definer delegates without recursion', () => {
  const fb = page();
  const callbacks = [];
  afterModuleRuns(fb.win, CONSTANTS, (exports) => callbacks.push(exports));
  const previous = fb.win.__d;
  const definitions = [];
  fb.win.__d = function () {
    definitions.push(arguments[0]);
    return previous.apply(this, arguments);
  };
  assert.doesNotThrow(() => fb.define(CONSTANTS, fillConstants));
  const limits = fb.require(CONSTANTS);
  assert.deepEqual(definitions, [CONSTANTS]);
  assert.deepEqual(callbacks, [limits], 'a delegated factory is observed once');
  fb.define('Unrelated', (exports) => { exports.value = 7; });
  assert.deepEqual(fb.require('Unrelated'), { value: 7 });
});

test('several delegating wrappers and an independent loader replacement keep one factory callback', () => {
  const fb = page({ stub: true });
  let callbacks = 0;
  afterModuleRuns(fb.win, CONSTANTS, () => { callbacks++; });
  fb.loaderSwaps();
  const definitions = [];
  for (let index = 0; index < 3; index++) {
    const previous = fb.win.__d;
    fb.win.__d = function () {
      definitions.push(index);
      return previous.apply(this, arguments);
    };
  }
  // Assigning the current loader back must not wrap it again.
  const same = fb.win.__d;
  fb.win.__d = same;
  assert.doesNotThrow(() => fb.define(CONSTANTS, fillConstants));
  assert.equal(fb.factories.get(CONSTANTS).length, 7);
  assert.equal(fb.require(CONSTANTS).FEED_STALE_TIMEOUT, 600 * 1e3);
  assert.deepEqual(definitions, [2, 1, 0]);
  assert.equal(callbacks, 1);
});

test('a delegating loader can define another watched module while defining the first', () => {
  const fb = page();
  const callbacks = [];
  afterModuleRuns(fb.win, CONSTANTS, () => callbacks.push(CONSTANTS));
  afterModuleRuns(fb.win, 'Nested', () => callbacks.push('Nested'));
  const previous = fb.win.__d;
  fb.win.__d = function (name) {
    if (name === CONSTANTS) fb.define('Nested', (exports) => { exports.value = 9; });
    return previous.apply(this, arguments);
  };
  assert.doesNotThrow(() => fb.define(CONSTANTS, fillConstants));
  assert.deepEqual(fb.require('Nested'), { value: 9 });
  assert.equal(fb.require(CONSTANTS).FEED_STALE_TIMEOUT, 600 * 1e3);
  assert.deepEqual(callbacks, ['Nested', CONSTANTS]);
});

test('every other module passes through untouched, and the wrapped one keeps its shape', () => {
  const fb = page();
  afterModuleRuns(fb.win, CONSTANTS, () => {});
  const other = function (t, n, r, o, a, i, l) {
    l.value = 1;
  };
  fb.win.__d('SomethingElse', [], other, 66);
  assert.equal(fb.factories.get('SomethingElse'), other);
  assert.deepEqual(fb.require('SomethingElse'), { value: 1 });
  fb.define(CONSTANTS, fillConstants);
  assert.notEqual(fb.factories.get(CONSTANTS), undefined);
  assert.equal(fb.factories.get(CONSTANTS).length, 7, 'the loader may read how many arguments a factory takes');
  assert.equal(fb.require(CONSTANTS).FEED_STALE_TIMEOUT, 600 * 1e3);
});

test('a new limit Facebook sets later is kept and still used with the switch off', () => {
  const limits = constantsModule();
  let on = true;
  assert.equal(holdLimits(limits, () => on), LIMITS.length);
  limits.FEED_VISIBILITY_TIMEOUT = 5000;
  assert.equal(limits.FEED_VISIBILITY_TIMEOUT, NEVER);
  on = false;
  assert.equal(limits.FEED_VISIBILITY_TIMEOUT, 5000);
  assert.deepEqual(Object.keys(limits), Object.keys(constantsModule()), 'the limits stay enumerable, in their places');
});

test("limits Facebook made into something else are reported, and Facebook's values are left as they were", () => {
  const run = start();
  run.fb.define(CONSTANTS, (exports, require, module) => {
    module.exports = Object.freeze(constantsModule());
  });
  const frozen = run.fb.require(CONSTANTS);
  assert.equal(frozen.FEED_STALE_TIMEOUT, 600 * 1e3);
  assert.equal(run.unavailable(), 1);
  assert.match(run.row('Return refresh on Home'), /0 of 3 limits held/);
  assert.match(run.warnings.join('\n'), /couldn't find Facebook's feed refresh limits/);
  run.fb.define(ROUTES, (exports) => {
    exports.isRouteEligible = 'comet.group';
  });
  assert.match(run.row('Return to Home from other pages'), /not held/);
  assert.equal(holdLimits({ FEED_STALE_TIMEOUT: '600000' }, () => true), 0, 'a limit that is no longer a number is left alone');
  assert.equal(holdRouteCheck(null, () => true), false);
});

test("an error in the hook goes to the script's log and never into Facebook's loader", () => {
  const fb = page();
  const errors = [];
  const log = { error: (message) => errors.push(message) };
  afterModuleRuns(fb.win, CONSTANTS, () => {
    throw new Error('boom');
  }, { log });
  whenModule(fb.win, ROUTES, () => {
    throw new Error('boom');
  }, { log });
  fb.define(CONSTANTS, fillConstants);
  let limits;
  assert.doesNotThrow(() => {
    limits = fb.require(CONSTANTS);
  });
  assert.equal(limits.FEED_STALE_TIMEOUT, 600 * 1e3);
  fb.define(ROUTES, fillRoutes);
  assert.deepEqual(fb.caught, []);
  assert.deepEqual(errors, [`Couldn't use Facebook's ${CONSTANTS}`, `Couldn't use Facebook's ${ROUTES}`]);
});

test('the switch starts off, sits with the feed and needs the page', () => {
  assert.equal(keepFeedPlace.default, false);
  assert.equal(keepFeedPlace.section, 'feed');
  assert.equal(keepFeedPlace.needsPage, true);
  assert.equal(keepFeedPlace.android, 'Block background-return feed refresh');
});
