// The feed load check (src/core/load-watchdog.js) against small pages shaped like a stuck Home:
// Facebook's splash screen still up, or its gray loading cards where the posts go. It has to ask
// once when a feed is stuck, and stay quiet on every page that loaded or is empty on purpose.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { CONFIRM_MS, feedKind, LOAD_WAIT_MS, readTabPause, setTabPause, stillLoading, TAB_PAUSE_KEY, watchFeedLoads } from '../src/core/load-watchdog.js';
import { parseRoute } from '../src/core/route.js';
import { createSettings } from '../src/core/settings.js';
import { createMemoryStorage } from '../src/core/storage.js';

const pages = [];
afterEach(async () => {
  for (const page of pages.splice(0)) await page.happyDOM.close();
});

// A loading card as Facebook draws it in the feed (live 2026-10-22).
const CARD = '<div role="article"><div aria-label="Loading..." data-visualcompletion="loading-state" role="status" tabindex="0"></div></div>';
const LOADING = `<div role="main"><h3>Feed posts</h3><div>${CARD}${CARD}</div></div>`;
// The placeholder in the page's first HTML, before Facebook's scripts draw the feed.
const PROGRESSBAR = '<div aria-valuetext="Loading..." role="progressbar"></div>';
const SPLASH = '<div id="splash-screen"><svg></svg></div>';
// A row of reels is a feed unit of its own (div[aria-posinset]), drawn above cards that never filled in.
const REEL_ROW = '<div aria-posinset="1"><a href="/reel/1">Reel</a><a href="/reel/2">Reel</a></div>';

const below = (element, top = 2400) => {
  element.getBoundingClientRect = () => ({ top, bottom: top + 286, left: 0, right: 100, width: 100, height: 286 });
};

function harness({ href = 'https://www.facebook.com/', html = LOADING, signedIn = true, paused = false } = {}) {
  const page = testWindow(href);
  pages.push(page);
  const doc = page.document;
  doc.body.innerHTML = html;
  const timers = new Map();
  let nextTimer = 1;
  const win = Object.assign(new EventTarget(), {
    innerHeight: 800,
    scrollY: 0,
    navigator: { onLine: true },
    setTimeout: (run, ms) => {
      const id = nextTimer++;
      timers.set(id, { run, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  let route = parseRoute(href);
  const routeListeners = new Set();
  const router = {
    current: () => route,
    subscribe: (listener) => routeListeners.add(listener),
    go(next) {
      route = parseRoute(next);
      for (const listener of routeListeners) listener(route);
    },
  };
  const stuck = [];
  const warnings = [];
  const state = { signedIn, paused };
  const loads = watchFeedLoads({
    win, doc, router,
    log: { warn: (message) => warnings.push(message) },
    signedIn: () => state.signedIn,
    paused: () => state.paused,
    onStuck: (kind) => stuck.push(kind),
  });
  // step() runs the timers that are due now, elapse() runs them until none are left (the wait,
  // then the second look) and hands back how long each one was.
  const step = () => {
    const due = [...timers.values()];
    timers.clear();
    for (const timer of due) timer.run();
    return due.map((timer) => timer.ms);
  };
  const elapse = () => {
    const ran = [];
    while (timers.size) ran.push(...step());
    return ran;
  };
  return { page, doc, win, router, loads, stuck, warnings, state, step, elapse, timers };
}

test("Home still showing Facebook's loading cards after the wait asks once", () => {
  const { loads, stuck, warnings, elapse } = harness();
  assert.equal(loads.status(), 'Checks the feed 20 seconds after it opens');
  assert.deepEqual(elapse(), [LOAD_WAIT_MS, CONFIRM_MS], 'the wait, then a second look');
  assert.deepEqual(stuck, ['home']);
  assert.equal(loads.status(), 'Still loading 20 seconds after the feed opened');
  assert.deepEqual(warnings, ['Home was still loading 20 seconds after it opened']);
});

test("Home still on Facebook's splash screen asks", () => {
  const { stuck, elapse } = harness({ html: SPLASH });
  elapse();
  assert.deepEqual(stuck, ['home']);
});

test("The first HTML's progressbar placeholder counts as loading", () => {
  const { stuck, elapse } = harness({ html: `<div role="main">${PROGRESSBAR}</div>` });
  elapse();
  assert.deepEqual(stuck, ['home']);
});

test('A post under a splash screen that never went away still asks', () => {
  // Home's first post comes with the page's HTML, under the splash, before Facebook's scripts run.
  const { stuck, elapse } = harness({ html: `${SPLASH}<div aria-posinset="1"><a href="/posts/1">Post</a></div>` });
  elapse();
  assert.deepEqual(stuck, ['home']);
});

test('A row of reels above loading cards that never filled in still asks', () => {
  const { stuck, elapse } = harness({ html: `<div role="main"><h3>Feed posts</h3><div>${REEL_ROW}${CARD}${CARD}</div></div>` });
  elapse();
  assert.deepEqual(stuck, ['home']);
});

test('A feed that loaded keeps its loading card below the first screen and stays quiet', () => {
  const { doc, loads, stuck, elapse } = harness({ html: `<div role="main"><div aria-posinset="1"><a href="/posts/1">Post</a></div>${CARD}</div>` });
  below(doc.querySelector('[role="status"]'));
  assert.deepEqual(elapse(), [LOAD_WAIT_MS]);
  assert.deepEqual(stuck, []);
  assert.equal(loads.status(), 'Nothing was still loading');
});

test('Loading cards gone by the second look were just posts on their way', () => {
  // The next posts being fetched, or Home clicked again to refresh it, right as the wait ends.
  const { doc, loads, stuck, step, timers } = harness();
  assert.deepEqual(step(), [LOAD_WAIT_MS]);
  assert.deepEqual([...timers.values()].map((timer) => timer.ms), [CONFIRM_MS]);
  assert.deepEqual(stuck, []);
  doc.querySelector('[role="main"] div').innerHTML = '<div aria-posinset="1"><a href="/posts/1">Post</a></div>';
  step();
  assert.deepEqual(stuck, []);
  assert.equal(loads.status(), 'Nothing was still loading');
});

test("A progressbar inside a post is the post's own, not the feed loading", () => {
  // A fundraiser's goal, a poll, or a video buffering.
  const { stuck, elapse } = harness({ html: `<div role="main"><div aria-posinset="1"><a href="/posts/1">Post</a>${PROGRESSBAR}</div></div>` });
  elapse();
  assert.deepEqual(stuck, []);
});

test('A feed unit with a progressbar and no links yet is a skeleton', () => {
  const { stuck, elapse } = harness({ html: `<div role="main"><div aria-posinset="1">${PROGRESSBAR}</div></div>` });
  elapse();
  assert.deepEqual(stuck, ['home']);
});

test('The feed read is the main column on screen, not one left hidden from the last page', () => {
  const { stuck, elapse } = harness({ html: `<div role="main" style="display: none"><div aria-posinset="1"><a href="/posts/1">Post</a></div></div>${LOADING}` });
  elapse();
  assert.deepEqual(stuck, ['home']);
});

test('Scrolled past the first screen, a loading card is just the next posts coming', () => {
  const { win, stuck, elapse } = harness();
  win.scrollY = 900;
  elapse();
  assert.deepEqual(stuck, []);
});

test('Loading cards outside the feed column are not the feed', () => {
  const { stuck, elapse } = harness({ html: `<div role="main"><div aria-posinset="1"><a href="/posts/1">Post</a></div></div><div role="complementary">${CARD}</div>` });
  elapse();
  assert.deepEqual(stuck, []);
});

test('A hidden loading card is not on screen', () => {
  const { doc, stuck, elapse } = harness();
  for (const card of doc.querySelectorAll('[role="status"]')) card.style.display = 'none';
  elapse();
  assert.deepEqual(stuck, []);
});

test("An empty page with nothing loading is left alone (a private group you're not in, no Favorites)", () => {
  for (const [href, html] of [
    ['https://www.facebook.com/groups/somegroup', '<div role="main"><h2>This group is private</h2></div>'],
    ['https://www.facebook.com/?filter=favorites&sk=h_chr', '<div role="main"><span>No posts</span></div>'],
  ]) {
    const { loads, stuck, elapse } = harness({ href, html });
    elapse();
    assert.deepEqual(stuck, [], href);
    assert.equal(loads.status(), 'Nothing was still loading', href);
  }
});

test("Home's Following feed still loading asks", () => {
  const { stuck, elapse } = harness({ href: 'https://www.facebook.com/?filter=all&sk=h_chr' });
  elapse();
  assert.deepEqual(stuck, ['home']);
});

test("A group's feed still loading asks", () => {
  const { stuck, warnings, elapse } = harness({ href: 'https://www.facebook.com/groups/123456/' });
  elapse();
  assert.deepEqual(stuck, ['group']);
  assert.deepEqual(warnings, ["A group's feed was still loading 20 seconds after it opened"]);
});

test('Signed out or paused stays quiet', () => {
  for (const options of [{ signedIn: false }, { paused: true }]) {
    const { loads, stuck, elapse } = harness(options);
    elapse();
    assert.deepEqual(stuck, [], JSON.stringify(options));
    assert.equal(loads.status(), 'Not checked while signed out or paused');
  }
});

test('Pages that are not a feed never start the wait', () => {
  for (const href of [
    'https://www.facebook.com/checkpoint/828281030927956/',
    'https://www.facebook.com/groups/123456/about',
    'https://www.facebook.com/groups/discover/',
    'https://www.facebook.com/groups/123456/posts/789/',
    'https://www.facebook.com/marketplace/',
    'https://www.facebook.com/zuck',
  ]) {
    const { timers, loads } = harness({ href });
    assert.equal(timers.size, 0, href);
    assert.equal(loads.status(), 'Not on a feed', href);
  }
});

test('feedKind names Home, its recent order and group feeds', () => {
  const kind = (href) => feedKind(parseRoute(href));
  assert.equal(kind('https://www.facebook.com/'), 'home');
  assert.equal(kind('https://www.facebook.com/home.php'), 'home');
  assert.equal(kind('https://www.facebook.com/?sk=h_chr'), 'home');
  assert.equal(kind('https://www.facebook.com/?filter=all&sk=h_chr'), 'home');
  assert.equal(kind('https://www.facebook.com/?filter=favorites&sk=h_chr'), 'home');
  assert.equal(kind('https://www.facebook.com/groups/feed/'), 'group');
  assert.equal(kind('https://www.facebook.com/groups/somegroup/?sorting_setting=CHRONOLOGICAL'), 'group');
  assert.equal(kind('https://www.facebook.com/groups/somegroup/?multi_permalinks=1'), null);
});

test('Offline waits for the connection, then gives the feed the full wait again', () => {
  const { win, loads, stuck, elapse, timers } = harness();
  win.navigator.onLine = false;
  elapse();
  assert.deepEqual(stuck, []);
  assert.equal(loads.status(), 'Waiting for the tab to be visible and online');
  assert.equal(timers.size, 0);
  win.navigator.onLine = true;
  win.dispatchEvent(new Event('online'));
  assert.equal(timers.size, 1);
  elapse();
  assert.deepEqual(stuck, ['home']);
});

test('A hidden tab waits until it is shown', () => {
  const { page, doc, stuck, elapse, timers } = harness();
  Object.defineProperty(doc, 'hidden', { value: true, configurable: true });
  elapse();
  assert.deepEqual(stuck, []);
  doc.dispatchEvent(new page.Event('visibilitychange'));
  assert.equal(timers.size, 0, 'still hidden');
  Object.defineProperty(doc, 'hidden', { value: false, configurable: true });
  doc.dispatchEvent(new page.Event('visibilitychange'));
  elapse();
  assert.deepEqual(stuck, ['home']);
});

test('Hidden or offline partway through the wait starts it over once the tab is back', () => {
  const { page, doc, win, loads, stuck, elapse, timers } = harness();
  Object.defineProperty(doc, 'hidden', { value: true, configurable: true });
  doc.dispatchEvent(new page.Event('visibilitychange'));
  assert.equal(timers.size, 0);
  assert.equal(loads.status(), 'Waiting for the tab to be visible and online');
  Object.defineProperty(doc, 'hidden', { value: false, configurable: true });
  doc.dispatchEvent(new page.Event('visibilitychange'));
  assert.deepEqual([...timers.values()].map((timer) => timer.ms), [LOAD_WAIT_MS], 'the whole wait again');
  win.navigator.onLine = false;
  win.dispatchEvent(new Event('offline'));
  assert.equal(timers.size, 0);
  win.navigator.onLine = true;
  win.dispatchEvent(new Event('online'));
  assert.deepEqual([...timers.values()].map((timer) => timer.ms), [LOAD_WAIT_MS]);
  elapse();
  assert.deepEqual(stuck, ['home']);
});

test('A feed opened in a background tab starts its wait when the tab is shown', () => {
  const page = testWindow('https://www.facebook.com/');
  pages.push(page);
  const doc = page.document;
  Object.defineProperty(doc, 'hidden', { value: true, configurable: true });
  const timers = [];
  const win = Object.assign(new EventTarget(), { innerHeight: 800, scrollY: 0, navigator: { onLine: true }, setTimeout: (run, ms) => timers.push(ms), clearTimeout: () => {} });
  const route = parseRoute('https://www.facebook.com/');
  const loads = watchFeedLoads({ win, doc, router: { current: () => route, subscribe: () => {} }, signedIn: () => true, paused: () => false, onStuck: () => {} });
  assert.deepEqual(timers, []);
  assert.equal(loads.status(), 'Waiting for the tab to be visible and online');
  Object.defineProperty(doc, 'hidden', { value: false, configurable: true });
  doc.dispatchEvent(new page.Event('visibilitychange'));
  assert.deepEqual(timers, [LOAD_WAIT_MS]);
});

test('Leaving the feed before the wait ends cancels it, and coming back starts it over', () => {
  const { router, stuck, elapse, timers } = harness();
  router.go('https://www.facebook.com/marketplace/');
  assert.equal(timers.size, 0);
  router.go('https://www.facebook.com/');
  assert.equal(timers.size, 1);
  elapse();
  assert.deepEqual(stuck, ['home']);
});

test('It asks at most once per page load', () => {
  const { router, stuck, elapse, timers } = harness();
  elapse();
  router.go('https://www.facebook.com/groups/123456/');
  assert.equal(timers.size, 0);
  elapse();
  assert.deepEqual(stuck, ['home']);
});

test('stillLoading reads the splash and the loading cards in the first screen', () => {
  const page = testWindow('https://www.facebook.com/');
  pages.push(page);
  const doc = page.document;
  const win = { innerHeight: 800, scrollY: 0 };
  doc.body.innerHTML = '<div role="main"><div aria-posinset="1"><a href="/x">Post</a></div></div>';
  assert.equal(stillLoading(doc, win), false);
  doc.body.innerHTML = SPLASH;
  assert.equal(stillLoading(doc, win), true);
  doc.body.innerHTML = LOADING;
  assert.equal(stillLoading(doc, win), true);
  for (const card of doc.querySelectorAll('[role="status"]')) below(card, 800);
  assert.equal(stillLoading(doc, win), false, 'a card starting at the bottom edge is below the first screen');
  for (const card of doc.querySelectorAll('[role="status"]')) below(card, -400);
  assert.equal(stillLoading(doc, win), false, 'a card above the screen is out of sight');
  doc.body.innerHTML = LOADING;
  assert.equal(stillLoading(doc, { innerHeight: 800, scrollY: 799 }), true, 'still inside the first screen');
  assert.equal(stillLoading(doc, { innerHeight: 800, scrollY: 800 }), false, 'a screen down, cards are the next posts coming');
});

test("The tab's pause mark is set, read and cleared", () => {
  const page = testWindow('https://www.facebook.com/');
  pages.push(page);
  assert.equal(readTabPause(page), false);
  setTabPause(page, true);
  assert.equal(page.sessionStorage.getItem(TAB_PAUSE_KEY), '1');
  assert.ok(TAB_PAUSE_KEY.startsWith('hfw:'), 'storage-report.js keeps only hfw: marks out of Facebook\'s report');
  assert.equal(readTabPause(page), true);
  setTabPause(page, false);
  assert.equal(readTabPause(page), false);
  const blocked = { get sessionStorage() { throw new DOMException('blocked', 'SecurityError'); } };
  assert.equal(readTabPause(blocked), false);
  assert.throws(() => setTabPause(blocked, true), /blocked/);
});

test('A paused tab reads as paused, runs no feature and saves nothing', () => {
  const storage = createMemoryStorage();
  const features = [{ id: 'hideSponsoredPosts', title: 'Hide sponsored posts', section: 'feed', default: true }];
  const settings = createSettings({ storage, features, version: '0.0.1', tabPaused: true });
  assert.equal(settings.tabPaused, true);
  assert.equal(settings.get('paused'), true);
  assert.equal(settings.get('hideSponsoredPosts'), true);
  assert.equal(settings.enabled('hideSponsoredPosts'), false);
  assert.equal(Object.hasOwn(settings.snapshot(), 'paused'), false);
  assert.equal(JSON.stringify(storage.dump()).includes('paused'), false);
  const open = createSettings({ storage, features, version: '0.0.1' });
  assert.equal(open.tabPaused, false);
  assert.equal(open.get('paused'), false);
  assert.equal(open.enabled('hideSponsoredPosts'), true);
});
