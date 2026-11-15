// Keep your place in the feed, Android's "Block background-return feed refresh". Live
// 2026-10-11 (run 30): Home left in a background tab for ten minutes fetched
// CometModernHomeFeedQuery again on return and jumped from 14 posts down to the top. Facebook's
// code for it (run 34, captures/2026-10-11-run34/return-source-source.json):
//   useCometHomeStaleFeedRefresh       reloads Home when the page is shown again after
//                                      FEED_VISIBILITY_TIMEOUT (120 s hidden), or when you're
//                                      back after FEED_STALE_TIMEOUT (600 s idle)
//   useCometFeedPushViewCloseRefresh   reloads it when a post or photo opened over the feed
//                                      closes after FEED_STALE_PUSH_VIEW_TIMEOUT (an experiment,
//                                      1800 s when it's unset). Live 2026-11-03 with it set to
//                                      5 s, Back from a post's comments scrolled Home to the top
//                                      and fetched CometModernHomeFeedQuery again, and with the
//                                      switch on stayed at the same post
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
//
// Memory Saver (Chrome, Brave, Edge) can discard a tab left in the background, and coming back
// to it loads the whole page again from the top, which nothing in the page can stop. So in the
// extension, while the switch is on, the tab is kept from it (holdTab).

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
const seconds = (ms) => (typeof ms === 'number' ? `${Math.round(ms / 1000)} s` : 'unset');

// Facebook's own values as the module set them, before the hold. The opened-post one is an
// experiment that can be seconds on some accounts, which is what a report needs to show.
export function facebookLimits(exports) {
  const read = (key) => seconds(exports && typeof exports === 'object' ? exports[key] : undefined);
  return `away ${read('FEED_STALE_TIMEOUT')}, hidden ${read('FEED_VISIBILITY_TIMEOUT')}, after a post closes ${read('FEED_STALE_PUSH_VIEW_TIMEOUT')}`;
}

// Asks the extension (keepTab) to keep this tab from Memory Saver while the switch is on, and to
// let it go when the switch goes off or the page is left, for the back/forward cache too. A page
// back from that cache asks again. A page Chrome is prerendering isn't in a tab of its own yet, so
// it waits until it's shown. A closed tab takes the setting with it. status() is what Diagnostics
// shows.
export function holdTab({ win, doc, enabled, keepTab, log, changed }) {
  // What the extension was last asked for, or null once an ask failed, when nobody knows.
  let kept = false;
  let asked = 0;
  let waiting = false;
  let left = false;
  let status = 'switch off';
  const keep = (want = enabled()) => {
    if (want === kept) {
      if (!want) status = 'switch off';
      return;
    }
    if (want && doc?.prerendering) {
      if (!waiting) {
        waiting = true;
        status = 'waiting for the page to be shown';
        doc.addEventListener('prerenderingchange', () => {
          waiting = false;
          keep();
        }, { once: true });
      }
      return;
    }
    kept = want;
    const ask = ++asked;
    keepTab(want).then((done) => {
      if (ask !== asked) return;
      status = !want ? 'switch off' : done === true ? 'kept' : 'not supported by this browser';
      changed?.();
    }, (error) => {
      if (ask !== asked) return;
      // Asked again on the next change, whichever way it goes. A let-go sent as the page went
      // into the back/forward cache loses its answer that way, which is no fault.
      kept = null;
      if (left) return;
      status = "couldn't reach the extension";
      log?.warn("Keep your place in the feed couldn't ask the browser to keep this tab from Memory Saver.", error);
      changed?.();
    });
  };
  win.addEventListener('pagehide', () => {
    left = true;
    keep(false);
  });
  win.addEventListener('pageshow', (event) => {
    left = false;
    if (event?.persisted) keep();
  });
  return { keep, status: () => status };
}

export default {
  id: 'keepFeedPlace',
  section: 'reading',
  android: 'Block background-return feed refresh',
  title: 'Keep your place in the feed',
  description: 'Keeps you where you were when Facebook would reload Home from the top or move you back to Home. It reloads Home when you come back after a couple of minutes in another tab or ten minutes away from the computer, and going back from a post or its comments can refresh it too. After half an hour away it also moves you from a group, Marketplace or search to Home.',
  default: false,
  needsPage: true,

  setup({ win, doc, settings, enabled, diagnostics, log, markUnavailable, keepTab }) {
    const state = { home: WAITING, pages: WAITING, limits: WAITING };
    let started = false;
    const start = () => {
      if (started || !enabled()) return;
      started = true;
      afterModuleRuns(win, CONSTANTS, (exports) => {
        state.limits = facebookLimits(exports);
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
    // Only the script's own words and Facebook's timer lengths, so a report carries them.
    const shareable = { shareable: true };
    diagnostics?.add('Return refresh on Home', () => (started ? state.home : 'switch off'), shareable);
    diagnostics?.add("Facebook's refresh limits on Home", () => (started ? state.limits : 'switch off'), shareable);
    diagnostics?.add('Return to Home from other pages', () => (started ? state.pages : 'switch off'), shareable);
    // The userscript has no tab to keep.
    if (keepTab) {
      const tab = holdTab({ win, doc, enabled, keepTab, log, changed: () => diagnostics?.changed() });
      tab.keep();
      settings?.subscribe(() => tab.keep());
      diagnostics?.add('Tab kept from Memory Saver', tab.status, shareable);
    }
  },
};
