// Load more posts ahead on Home. Facebook sends Home's posts five at a time
// (CometNewsFeedPaginationQuery) and asks for the next five only while the end of the feed is
// near the screen. Live 2026-11-04 on the test account (1600x1000):
// - Asking for more per answer does nothing. With the request's "count" raised from 5 to 10 or
//   20, every answer still carried five posts at most.
// - Each answer takes 6 to 9 seconds. Facebook streams some posts within 2 s, holds others back
//   5 to 7 s, and sends the next page's cursor last, so the feed can't ask again any sooner.
// - When it asks is decided by an IntersectionObserver on an empty div with no attributes below
//   the last post, with a margin on its bottom only: 2570 px, and 5140 or 7710 px once you've
//   scrolled further. Every page gets a new observer. Facebook makes the first one on the first
//   scroll that moves the page, so 40 s at the top of Home fetched nothing, and a scroll event
//   sent from a script didn't count.
// - After one 1 px scroll and nothing else, stock Home fetched once and stopped with 5 posts
//   drawn. With that margin at 30000 px it kept going on its own: 6 answers and 16 posts in
//   40 s, ten screens ready below.
// So while the switch is on, an observer like that on Home, watching an empty div with no
// attributes inside role=main, watches it with the bottom margin you pick in screens instead
// (never less than Facebook's own). And arriving at the top of Home scrolls 1 px and back once
// the feed is drawn, so the first fetch doesn't wait for you. Every other observer, and every
// page but Home, is left as it is. Switching it off takes effect from the next page Facebook
// fetches, since each page gets a new observer.

const SCREENS = ['10', '25', '50'];
const DEFAULT_SCREENS = '25';
const BOTTOM_ONLY = /^0(?:px)?\s+0(?:px)?\s+(\d+(?:\.\d+)?)px\s+0(?:px)?$/;
// Facebook's own margin was 2570 px or more. A smaller one on the bottom alone is someone else's.
const LEAST = 1000;
const FEED_LOADING = '[role="main"] [data-visualcompletion="loading-state"]';
// Long enough for the scroll to reach Facebook's listener before the page goes back to the top.
const BACK_AFTER_MS = 150;

// The bottom margin in px when that's the only margin set and it's a large one, else null.
export function bottomMargin(rootMargin) {
  const found = typeof rootMargin === 'string' ? rootMargin.trim().match(BOTTOM_ONLY) : null;
  const px = found ? Number(found[1]) : Number.NaN;
  return px >= LEAST ? px : null;
}

// The empty div Facebook watches below the last post.
export function isFeedEnd(target) {
  return target?.nodeType === 1 && target.localName === 'div' && target.attributes.length === 0
    && target.childNodes.length === 0 && Boolean(target.closest('[role="main"]'));
}

// Replaces win.IntersectionObserver with a stand-in that builds the same observers. reach() is
// the bottom margin in px for the feed's end, or 0 to leave it to Facebook. onWiden runs once for
// each observer that got the wider margin. Whether it could be put in place.
export function widenFeedEnd(win, reach, onWiden = () => {}) {
  const Native = win?.IntersectionObserver;
  if (typeof Native !== 'function') return false;
  win.IntersectionObserver = new Proxy(Native, {
    construct(Target, args, newTarget) {
      const observer = Reflect.construct(Target, args, newTarget);
      const [callback, options] = args;
      const own = bottomMargin(options?.rootMargin);
      if (own !== null && typeof callback === 'function') watchFeedEnd({ Target, observer, callback, options, own, reach, onWiden });
      return observer;
    },
  });
  return true;
}

// The feed's end goes to a second observer with the wider margin, whose entries reach
// Facebook's callback as if its own observer saw them. The rest stay on Facebook's.
function watchFeedEnd({ Target, observer, callback, options, own, reach, onWiden }) {
  const native = Target.prototype;
  const moved = new Set();
  // Feed ends on Facebook's own observer.
  const held = new Set();
  let wide = null;
  const define = (name, value) => Object.defineProperty(observer, name, { configurable: true, writable: true, value });
  define('observe', function observe(target) {
    // Each time Facebook watches a feed end, it goes to the observer the switch calls for now
    // and the other one lets it go, so it's never watched twice. Watching a target again on
    // the observer that has it changes nothing.
    const end = isFeedEnd(target);
    const px = end ? reach() : 0;
    if (!(px > own)) {
      if (moved.delete(target)) {
        wide.unobserve(target);
        held.add(target);
      } else if (end) held.add(target);
      return native.observe.call(observer, target);
    }
    if (!wide) {
      wide = new Target((entries) => callback.call(observer, entries, observer), { ...options, rootMargin: `0px 0px ${Math.round(px)}px 0px` });
      onWiden();
    }
    if (held.delete(target)) native.unobserve.call(observer, target);
    moved.add(target);
    return wide.observe(target);
  });
  define('unobserve', function unobserve(target) {
    if (moved.delete(target)) return wide.unobserve(target);
    held.delete(target);
    return native.unobserve.call(observer, target);
  });
  define('disconnect', function disconnect() {
    moved.clear();
    held.clear();
    wide?.disconnect();
    return native.disconnect.call(observer);
  });
  define('takeRecords', function takeRecords() {
    return [...native.takeRecords.call(observer), ...(wide ? wide.takeRecords() : [])];
  });
}

// Once a visit to Home, at the top with the feed's loading cards drawn and the tab in view: down
// 1 px and back. A page that's already scrolled has started Facebook's fetching itself.
export function createStarter({ win, doc, live }) {
  let done = false;
  let starts = 0;
  const move = (top) => win.scrollTo({ top, left: win.scrollX, behavior: 'instant' });
  return {
    check() {
      if (done || !live() || doc.hidden) return;
      if (win.scrollY !== 0) {
        done = true;
        return;
      }
      if (!doc.querySelector(FEED_LOADING)) return;
      move(1);
      // A page too short to scroll yet is tried again when more of it is drawn.
      if (win.scrollY !== 1) return;
      done = true;
      starts++;
      win.setTimeout(() => {
        if (win.scrollY === 1) move(0);
      }, BACK_AFTER_MS);
    },
    reset() {
      done = false;
    },
    starts: () => starts,
  };
}

export default {
  id: 'loadAhead',
  section: 'feed',
  title: 'Load more posts ahead',
  description: "Home keeps fetching posts while you read, as many screens ahead as you pick, and starts as soon as it opens instead of at your first scroll. Facebook still sends five posts at a time, a few seconds apart, so this gets them coming sooner and keeps more of them waiting below you.",
  default: false,
  webOnly: true,
  needsPage: true,
  options: [
    { key: 'screens', type: 'select', label: 'How far ahead', default: DEFAULT_SCREENS, choices: SCREENS.map((value) => ({ value, label: `${value} screens` })) },
  ],

  setup({ win, doc, router, settings, diagnostics, enabled, option }) {
    if (!win || !doc) return;
    const onHome = () => router?.current()?.type === 'home';
    const live = () => enabled() && onHome();
    const screens = () => Number(SCREENS.includes(option('screens')) ? option('screens') : DEFAULT_SCREENS);
    let widened = 0;
    widenFeedEnd(win, () => (live() ? screens() * (win.innerHeight || 0) : 0), () => {
      widened++;
    });
    const starter = createStarter({ win, doc, live });
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      win.setTimeout(() => {
        queued = false;
        starter.check();
      }, 100);
    };
    const Observer = win.MutationObserver ?? globalThis.MutationObserver;
    new Observer(() => {
      if (live()) schedule();
    }).observe(doc, { childList: true, subtree: true });
    router?.subscribe?.(() => {
      starter.reset();
      schedule();
    });
    settings?.subscribe?.(schedule);
    doc.addEventListener('visibilitychange', schedule);
    diagnostics?.add('Home loading ahead', () => (enabled() ? `${widened} pages watched further ahead, started early ${starter.starts()} times` : 'off'));
  },
};
