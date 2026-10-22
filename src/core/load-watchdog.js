// Notices a feed that never finishes loading. Three of the first eight issue reports (#2, #3,
// #8) were Facebook stuck on its splash screen or on gray placeholders with the script on, and
// each was found only because someone wrote in. When Home or a group's feed LOAD_WAIT_MS after
// it opened is still behind Facebook's splash screen, or still shows Facebook's loading cards in
// the first screen of the feed, and still does CONFIRM_MS later, onStuck runs, and main.js offers
// to pause the script for this tab or copy a report. Nothing here reloads the page. It says
// nothing on signed-out pages, and a tab that's hidden or offline during the wait gets the whole
// wait again once it's back. It speaks at most once per load.
//
// It reads Facebook's own loading signs instead of counting posts. Home's first post arrives
// with the page's HTML, under the splash, before Facebook's scripts run, and a feed that never
// filled in can still show a row of reels above its loading cards, so a post on the page proves
// nothing (live 2026-10-22). On a healthy load the splash goes within a second and the loading
// cards sit below the first screen, where Facebook fetches more posts as they come into view.
//
// A page with nothing loading is left alone: a private group you're not in, an empty Favorites
// feed, or the end of a short feed is empty on purpose.
//
// A pause for this tab is a mark under hfw: in sessionStorage, so it lasts through reloads and
// ends with the tab. storage-report.js keeps the mark's name out of what Facebook's page reports.

export const TAB_PAUSE_KEY = 'hfw:pausedTab';
// The first post drew 0.6 to 2.3 seconds into healthy loads on the test account and the splash
// went within 50 ms of it (live 2026-10-21 and 2026-10-22). Twenty seconds leaves room for a slow
// connection or a busy computer.
export const LOAD_WAIT_MS = 20000;
// The second look, so a feed caught fetching its next posts, or refreshed by a click on Home, has
// finished before anyone is asked.
export const CONFIRM_MS = 3000;

export function readTabPause(win) {
  try {
    return win.sessionStorage?.getItem(TAB_PAUSE_KEY) === '1';
  } catch {
    return false;
  }
}

// Throws when the tab's storage can't be written, so the caller can say so instead of reloading.
export function setTabPause(win, on) {
  if (on) win.sessionStorage.setItem(TAB_PAUSE_KEY, '1');
  else win.sessionStorage.removeItem(TAB_PAUSE_KEY);
}

// /groups/<name> pages that aren't a group's own feed.
const GROUP_PAGES = new Set(['discover', 'joins', 'create', 'notifications', 'search', 'category', 'browse', 'you']);

// 'home', 'group' or null. Home's filtered feeds (Following, Favorites) count as Home: the
// Following feed loads like Home, and an empty Favorites feed shows no loading cards at all
// (live 2026-10-22).
export function feedKind(route) {
  if (route.permalink) return null;
  if (route.type === 'home') return 'home';
  const parts = new URL(route.href).pathname.split('/').filter(Boolean);
  return parts[0] === 'groups' && parts.length === 2 && !GROUP_PAGES.has(parts[1]) ? 'group' : null;
}

const shown = (element) => element.isConnected && (element.checkVisibility?.() ?? true);

// Facebook's loading cards: the gray post-shaped boxes drawn while posts load
// (role=status, data-visualcompletion=loading-state, live 2026-10-22), and progressbar
// placeholders. A progressbar inside a post that has links is that post's own, such as a
// fundraiser's goal or a video buffering, so only one outside a feed unit, or in a unit with no
// links yet (a skeleton, as posts.js reads it), counts.
const LOADING = '[data-visualcompletion="loading-state"], [role="progressbar"]';
const UNIT = '[aria-posinset], [role="article"]';
const loadingSign = (element) => {
  if (element.matches('[data-visualcompletion="loading-state"]')) return true;
  const unit = element.closest(UNIT);
  return !unit?.querySelector('a[href]');
};

// Facebook's splash screen still up, or one of its loading cards in the feed's first screen. A
// feed that loaded keeps a card at its far end, below the posts, and once the reader is a screen
// down the cards there are the next posts on their way.
export function stillLoading(doc, win) {
  const splash = doc.getElementById('splash-screen');
  if (splash && shown(splash)) return true;
  if ((win.scrollY || 0) >= win.innerHeight) return false;
  const scope = [...doc.querySelectorAll('[role="main"]')].find(shown) ?? doc;
  return [...scope.querySelectorAll(LOADING)].some((card) => {
    if (!shown(card) || !loadingSign(card)) return false;
    const { top, bottom } = card.getBoundingClientRect();
    return top < win.innerHeight && bottom >= 0;
  });
}

// status() is for Diagnostics: fixed wording only, so Copy report can carry it.
export function watchFeedLoads({ win, doc, router, signedIn, paused, onStuck, log, wait = LOAD_WAIT_MS }) {
  let timer = null;
  let fired = false;
  let state = 'idle';
  const seconds = Math.round(wait / 1000);
  // Background tabs draw late, and an offline page can't load.
  const away = () => doc.hidden || win.navigator?.onLine === false;

  function arm() {
    win.clearTimeout(timer);
    timer = null;
    if (fired) return;
    if (!feedKind(router.current())) {
      state = 'idle';
      return;
    }
    if (away()) {
      state = 'held';
      return;
    }
    state = 'waiting';
    timer = win.setTimeout(() => check(false), wait);
  }

  function check(second) {
    timer = null;
    const kind = feedKind(router.current());
    if (fired || !kind) return;
    if (away()) {
      state = 'held';
      return;
    }
    if (!signedIn() || paused()) {
      state = 'skipped';
      return;
    }
    if (!stillLoading(doc, win)) {
      state = 'loaded';
      return;
    }
    if (!second) {
      timer = win.setTimeout(() => check(true), CONFIRM_MS);
      return;
    }
    fired = true;
    state = 'stuck';
    const where = kind === 'home' ? 'Home' : "A group's feed";
    log?.warn(`${where} was still loading ${seconds} seconds after it opened`);
    onStuck(kind);
  }

  // Hidden or offline partway through stops the wait, and coming back starts it over.
  const follow = () => {
    if (fired) return;
    if (!away()) {
      if (state === 'held') arm();
      return;
    }
    if (state !== 'waiting') return;
    win.clearTimeout(timer);
    timer = null;
    state = 'held';
  };
  doc.addEventListener('visibilitychange', follow);
  win.addEventListener('online', follow);
  win.addEventListener('offline', follow);
  router.subscribe(arm);
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', arm, { once: true });
  else arm();

  return {
    status: () => ({
      idle: 'Not on a feed',
      waiting: `Checks the feed ${seconds} seconds after it opens`,
      held: 'Waiting for the tab to be visible and online',
      skipped: 'Not checked while signed out or paused',
      loaded: 'Nothing was still loading',
      stuck: `Still loading ${seconds} seconds after the feed opened`,
    })[state],
  };
}
