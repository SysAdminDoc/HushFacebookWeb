// Keep your place in the feed, Android's "Block background-return feed refresh". Live
// 2026-10-11 (run 30): Home left in a background tab for ten minutes fetched
// CometModernHomeFeedQuery again on return and jumped from 14 posts down to the top. Facebook's
// code for it (run 34, captures/2026-10-11-run34/return-source-source.json):
//   useCometHomeStaleFeedRefresh       reloads Home when the page is shown again after
//                                      FEED_VISIBILITY_TIMEOUT (120 s hidden), or when you're
//                                      back after FEED_STALE_TIMEOUT (600 s idle)
//   useCometFeedPushViewCloseRefresh   reloads it when a post or photo opened over the feed
//                                      closes after FEED_STALE_PUSH_VIEW_TIMEOUT (an experiment,
//                                      1800 s when it's unset)
//   useStaleSessionReturnToFeed        sends a group, Marketplace, search, saved items and some
//                                      other pages to Home after 1800 s away, with a "Pick up
//                                      where you left off" toast, for the routes
//                                      CometReturnToFeedRouteUtils.isRouteEligible names
// Each of them reads the limits and the route check off the module's exports when it fires.
// So while the switch is on the three limits read as the longest delay a timer takes, and the
// route check answers no. Not Infinity: the opened-post limit is a setTimeout delay too, and a
// timer given Infinity fires at once. A manual refresh (the Home button) isn't touched.
//
// The limits module reads Facebook's experiment values as it runs, so the script takes its
// exports once Facebook's own code has run it and never asks for it (afterModuleRuns). Asked for
// early it threw and left Feeds on the splash screen (live 2026-10-11). The route check reads
// nothing, so asking for it is safe, and Facebook only runs it once you've been away long enough.

import { afterModuleRuns, whenModule } from '../../core/modules.js';

export const CONSTANTS = 'CometFeedStalenessConstantsEntryPointVariables';
export const ROUTES = 'CometReturnToFeedRouteUtils';
export const LIMITS = ['FEED_STALE_TIMEOUT', 'FEED_VISIBILITY_TIMEOUT', 'FEED_STALE_PUSH_VIEW_TIMEOUT'];
export const NEVER = 2 ** 31 - 1;

// Each limit turned into a getter over the value Facebook set, which still takes a new one.
// How many it could hold.
export function holdLimits(exports, enabled) {
  if (!exports || typeof exports !== 'object') return 0;
  let held = 0;
  for (const key of LIMITS) {
    const own = Object.getOwnPropertyDescriptor(exports, key);
    if (!own || !('value' in own) || !own.configurable || typeof own.value !== 'number') continue;
    let value = own.value;
    Object.defineProperty(exports, key, {
      configurable: true,
      enumerable: own.enumerable,
      get: () => (enabled() && typeof value === 'number' ? NEVER : value),
      set: (next) => {
        value = next;
      },
    });
    held++;
  }
  return held;
}

// The route check, answering no while the switch is on. Whether it could be held.
export function holdRouteCheck(exports, enabled) {
  const own = exports && typeof exports === 'object' ? Object.getOwnPropertyDescriptor(exports, 'isRouteEligible') : null;
  if (!own || typeof own.value !== 'function' || !(own.writable || own.configurable)) return false;
  const original = own.value;
  const held = function isRouteEligible(...args) {
    return enabled() ? false : original.apply(this, args);
  };
  Object.defineProperty(exports, 'isRouteEligible', { ...own, value: held });
  return true;
}

const WAITING = "Facebook's code isn't loaded yet";

export default {
  id: 'keepFeedPlace',
  section: 'feed',
  android: 'Block background-return feed refresh',
  title: 'Keep your place in the feed',
  description: "Facebook reloads Home from the top when you come back after a couple of minutes in another tab, or ten minutes away from the computer. After half an hour away it also moves you from a group, Marketplace or search to Home. With this on, you stay where you were.",
  default: false,
  needsPage: true,

  setup({ win, settings, enabled, diagnostics, log, markUnavailable }) {
    const state = { home: WAITING, pages: WAITING };
    let started = false;
    const start = () => {
      if (started || !enabled()) return;
      started = true;
      afterModuleRuns(win, CONSTANTS, (exports) => {
        const held = holdLimits(exports, enabled);
        state.home = held === LIMITS.length ? 'held' : `${held} of ${LIMITS.length} limits held, Facebook's code has changed`;
        if (!held) {
          log?.warn("Keep your place in the feed couldn't find Facebook's feed refresh limits. Facebook's code has changed.");
          markUnavailable?.();
        }
        diagnostics?.changed();
      }, { log });
      whenModule(win, ROUTES, (exports) => {
        const held = holdRouteCheck(exports, enabled);
        state.pages = held ? 'held' : "not held, Facebook's code has changed";
        if (!held) log?.warn("Keep your place in the feed couldn't find Facebook's return to Home check. Facebook's code has changed.");
        diagnostics?.changed();
      }, { log });
    };
    // Facebook's modules are left alone until the switch is first turned on.
    start();
    settings?.subscribe(start);
    diagnostics?.add('Return refresh on Home', () => (started ? state.home : 'switch off'));
    diagnostics?.add('Return to Home from other pages', () => (started ? state.pages : 'switch off'));
  },
};
