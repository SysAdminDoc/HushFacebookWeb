import { test } from 'node:test';
import assert from 'node:assert/strict';
import keepFeedPlace, { CONSTANTS, LIMITS, NEVER, ROUTES, holdLimits, holdRouteCheck } from '../src/features/feed/keep-feed-place.js';
import { whenModule } from '../src/core/modules.js';

// Facebook's two modules, shaped the way the served code builds them (run 34): plain exports
// set one by one, the limits in milliseconds.
function constantsModule() {
  const exports = {};
  exports.FEED_STALE_TIMEOUT = 600 * 1e3;
  exports.FEED_VISIBILITY_TIMEOUT = 120 * 1e3;
  exports.FEED_STALE_PUSH_VIEW_TIMEOUT = 1800 * 1e3;
  exports.FEED_MAX_QUERY_AGE_IN_SEC = 180;
  exports.BADGE_STALE_TIMEOUT = 600 * 1e3;
  exports.STALE_REFRESH_MODE = 'WARM';
  return exports;
}
function routesModule() {
  const exports = {};
  exports.isRouteEligible = (route) => ['comet.group', 'comet.marketplace.home', 'comet.search_results.default_tab'].includes(route);
  return exports;
}

// The decisions Facebook's hooks make with them, read off each module's exports when they fire.
// useCometHomeStaleFeedRefresh, when the page is shown again or you're active again:
const reloadsHome = (limits, idleMs, hiddenMs) => idleMs > limits.FEED_STALE_TIMEOUT || hiddenMs > limits.FEED_VISIBILITY_TIMEOUT;
// useStaleSessionReturnToFeed, half an hour away on one of the routes it covers:
const sendsHome = (routes, route, awayMs) => routes.isRouteEligible(route) && awayMs > 1800 * 1e3;
const HOUR = 3600 * 1e3;

// requireLazy the way Facebook's loader answers it: right away for a module already defined,
// otherwise once it is.
function page({ loaderLater = false } = {}) {
  const defined = new Map();
  let waiting = [];
  const asked = [];
  const listeners = new Map();
  const listen = (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  const requireLazy = (names, callback) => {
    asked.push(...names);
    const run = () => (names.every((name) => defined.has(name)) ? (callback(...names.map((name) => defined.get(name))), true) : false);
    if (!run()) waiting.push(run);
  };
  const win = { document: { addEventListener: listen }, addEventListener: listen };
  if (!loaderLater) win.requireLazy = requireLazy;
  return {
    win,
    asked,
    define(name, exports) {
      defined.set(name, exports);
      waiting = waiting.filter((run) => !run());
    },
    loaderArrives() {
      win.requireLazy = requireLazy;
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
  const limits = constantsModule();
  assert.equal(reloadsHome(limits, HOUR, HOUR), true);
  run.fb.define(CONSTANTS, limits);
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

test('the limit for a post opened over the feed is a timer delay that waits, never one that fires at once', async () => {
  const run = start();
  const limits = constantsModule();
  run.fb.define(CONSTANTS, limits);
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
  const routes = routesModule();
  run.fb.define(ROUTES, routes);
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
  const limits = constantsModule();
  const routes = routesModule();
  const check = routes.isRouteEligible;
  run.fb.define(CONSTANTS, limits);
  run.fb.define(ROUTES, routes);
  assert.deepEqual(run.fb.asked, []);
  assert.equal(Object.getOwnPropertyDescriptor(limits, 'FEED_STALE_TIMEOUT').value, 600 * 1e3);
  assert.equal(routes.isRouteEligible, check);
  assert.equal(run.row('Return refresh on Home'), 'switch off');
  run.turn(true);
  assert.deepEqual(run.fb.asked, [CONSTANTS, ROUTES]);
  assert.equal(reloadsHome(limits, HOUR, HOUR), false);
  assert.equal(sendsHome(routes, 'comet.group', HOUR), false);
  run.turn(false);
  run.turn(true);
  assert.deepEqual(run.fb.asked, [CONSTANTS, ROUTES], 'asked once, however often the switch moves');
});

test("Facebook's loader is used once the page has parsed when it isn't there at start", () => {
  const run = start({ loaderLater: true });
  assert.deepEqual(run.fb.asked, []);
  assert.equal(run.row('Return refresh on Home'), "Facebook's code isn't loaded yet");
  run.fb.loaderArrives();
  run.fb.fire('DOMContentLoaded');
  run.fb.fire('load');
  assert.deepEqual(run.fb.asked, [CONSTANTS, ROUTES]);
  const limits = constantsModule();
  run.fb.define(CONSTANTS, limits);
  assert.equal(reloadsHome(limits, HOUR, HOUR), false);
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
  const frozen = Object.freeze(constantsModule());
  run.fb.define(CONSTANTS, frozen);
  assert.equal(frozen.FEED_STALE_TIMEOUT, 600 * 1e3);
  assert.equal(run.unavailable(), 1);
  assert.match(run.row('Return refresh on Home'), /0 of 3 limits held/);
  assert.match(run.warnings.join('\n'), /couldn't find Facebook's feed refresh limits/);
  run.fb.define(ROUTES, { isRouteEligible: 'comet.group' });
  assert.match(run.row('Return to Home from other pages'), /not held/);
  assert.equal(holdLimits({ FEED_STALE_TIMEOUT: '600000' }, () => true), 0, 'a limit that is no longer a number is left alone');
  assert.equal(holdRouteCheck(null, () => true), false);
});

test("an error in the hook goes to the script's log and never into Facebook's loader", () => {
  const fb = page();
  const errors = [];
  whenModule(fb.win, CONSTANTS, () => {
    throw new Error('boom');
  }, { log: { error: (message) => errors.push(message) } });
  assert.doesNotThrow(() => fb.define(CONSTANTS, constantsModule()));
  assert.deepEqual(errors, [`Couldn't use Facebook's ${CONSTANTS}`]);
});

test('the switch starts off, sits with the feed and needs the page', () => {
  assert.equal(keepFeedPlace.default, false);
  assert.equal(keepFeedPlace.section, 'feed');
  assert.equal(keepFeedPlace.needsPage, true);
  assert.equal(keepFeedPlace.android, 'Block background-return feed refresh');
});
