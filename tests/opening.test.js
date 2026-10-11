// Opening Facebook: what counts as the start of a visit, Open on a chosen tab, Marketplace only,
// and which of them (with Following feed on Home) gets to redirect a Home load. The top bar is
// shaped like the live one on 2026-10-11 (captures/2026-10-11-declutter): the logo and the Home
// tab both link "/", the tab inside the tab list.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import followingFeed from '../src/features/opening/following-feed.js';
import marketplaceOnly, { LOOP_MARK, MARKETPLACE_ONLY_CSS, mayRedirect } from '../src/features/opening/marketplace-only.js';
import openOnTab, { TABS, startPath } from '../src/features/opening/open-on-tab.js';
import { claimHomeRedirect, homeRedirectClaim, isPlainHome, isVisitStart } from '../src/features/opening/start.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const FB = 'https://www.facebook.com';

// A window as the opening features see it: an address that records where it was sent, session
// storage that a tab shares between its pages, and the navigation's kind.
function fakeWin(path, { store = new Map(), navigation = 'navigate', storage = true } = {}) {
  const sent = [];
  return {
    sent,
    store,
    location: { href: `${FB}${path}`, replace: (to) => sent.push(['replace', to]), assign: (to) => sent.push(['assign', to]) },
    sessionStorage: storage
      ? { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) }
      : { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } },
    performance: { getEntriesByType: () => [{ type: navigation }] },
    addEventListener() {},
  };
}

function settingsFrom(values) {
  return {
    get: (key) => values[key],
    enabled: (id) => values.paused !== true && values[id] === true,
  };
}

// Sets up the opening features in their real order on one window.
function boot(win, values) {
  const settings = settingsFrom(values);
  const router = { listeners: [], subscribe(fn) { this.listeners.push(fn); } };
  for (const feature of [marketplaceOnly, openOnTab, followingFeed]) {
    feature.setup({
      win, router, settings, log: { info() {}, warn() {} },
      enabled: () => settings.enabled(feature.id),
      option: (key) => values[`${feature.id}.${key}`] ?? feature.options?.find((option) => option.key === key)?.default,
    });
  }
  return router;
}

test('the first Home page in a tab is a visit start, a reload, Back or a later page is not', () => {
  const store = new Map();
  const first = fakeWin('/', { store });
  assert.equal(isVisitStart(first), true);
  assert.equal(isVisitStart(first), true, 'the same answer for every feature on that page');
  assert.equal(isVisitStart(fakeWin('/', { store })), false, 'the next page in the tab');
  assert.equal(isVisitStart(fakeWin('/', { navigation: 'reload' })), false);
  assert.equal(isVisitStart(fakeWin('/', { navigation: 'back_forward' })), false);
  assert.equal(isVisitStart(fakeWin('/', { storage: false })), false, 'no storage, no start');
});

test('only a plain Home address counts as Home for a start redirect', () => {
  assert.equal(isPlainHome(`${FB}/`), true);
  assert.equal(isPlainHome(`${FB}/home.php`), true);
  assert.equal(isPlainHome('https://web.facebook.com/'), true);
  assert.equal(isPlainHome(`${FB}/?filter=all&sk=h_chr`), false);
  assert.equal(isPlainHome(`${FB}/marketplace/`), false);
  assert.equal(isPlainHome(`${FB}/SlowSimpleSeasonal/posts/pfbid02J`), false);
});

test('Open on a chosen tab sends the start of a visit to the tab picked, and nothing else', () => {
  const start = fakeWin('/');
  boot(start, { openOnTab: true });
  assert.deepEqual(start.sent, [['replace', '/marketplace/']], 'Marketplace unless you pick another');
  const video = fakeWin('/');
  boot(video, { openOnTab: true, 'openOnTab.tab': 'video' });
  assert.deepEqual(video.sent, [['replace', '/watch/']]);
  // The same tab later: Home is Home.
  const later = fakeWin('/', { store: start.store });
  boot(later, { openOnTab: true });
  assert.deepEqual(later.sent, []);
  // A link into Facebook opens where it leads, and so does Feeds.
  for (const path of ['/SlowSimpleSeasonal/posts/pfbid02J', '/?filter=all&sk=h_chr', '/groups/feed/']) {
    const win = fakeWin(path);
    boot(win, { openOnTab: true });
    assert.deepEqual(win.sent, [], path);
  }
  const paused = fakeWin('/');
  boot(paused, { openOnTab: true, paused: true });
  assert.deepEqual(paused.sent, []);
});

test('a visit started with the switch off is still marked, so turning it on later waits for a new tab', () => {
  const off = fakeWin('/');
  boot(off, { openOnTab: false });
  assert.deepEqual(off.sent, []);
  const next = fakeWin('/', { store: off.store });
  boot(next, { openOnTab: true });
  assert.deepEqual(next.sent, []);
});

test('Feeds opens on the posts Following feed on Home shows while that is on', () => {
  assert.equal(startPath('feeds', settingsFrom({})), '/?filter=all&sk=h_chr');
  assert.equal(startPath('feeds', settingsFrom({ followingFeed: true, 'followingFeed.filter': 'friends' })), '/?filter=friends&sk=h_chr');
  assert.equal(startPath('nonsense', settingsFrom({})), '/marketplace/', 'an unknown choice falls back to the first');
  assert.deepEqual(TABS.map(({ value }) => value), ['marketplace', 'feeds', 'video', 'friends', 'groups', 'notifications', 'menu']);
  assert.ok(!TABS.some(({ path }) => path.startsWith('/messages')), 'never a page that can open a chat');
});

test('one Home load is redirected once: Marketplace only, then Open on a chosen tab, then Following feed', () => {
  const all = { marketplaceOnly: true, openOnTab: true, 'openOnTab.tab': 'friends', followingFeed: true };
  const start = fakeWin('/');
  boot(start, all);
  assert.deepEqual(start.sent, [['replace', '/marketplace/']]);
  assert.equal(homeRedirectClaim(start), 'marketplaceOnly');
  const tabStart = fakeWin('/');
  boot(tabStart, { ...all, marketplaceOnly: false });
  assert.deepEqual(tabStart.sent, [['replace', '/friends/']]);
  const later = fakeWin('/', { store: tabStart.store });
  boot(later, { ...all, marketplaceOnly: false });
  assert.deepEqual(later.sent, [['replace', '/?filter=all&sk=h_chr']], 'after the start, Following feed has Home');
  const win = fakeWin('/');
  assert.equal(claimHomeRedirect(win, 'a'), true);
  assert.equal(claimHomeRedirect(win, 'a'), true);
  assert.equal(claimHomeRedirect(win, 'b'), false);
});

test('Marketplace only sends every Home load to Marketplace, Feeds included, and leaves other pages', () => {
  for (const path of ['/', '/home.php', '/?filter=all&sk=h_chr']) {
    const store = new Map([['hfw:started', '1']]);
    const win = fakeWin(path, { store });
    boot(win, { marketplaceOnly: true });
    assert.deepEqual(win.sent, [['replace', '/marketplace/']], path);
  }
  for (const path of ['/groups/feed/', '/marketplace/item/123/', '/messages/t/']) {
    const win = fakeWin(path);
    boot(win, { marketplaceOnly: true });
    assert.deepEqual(win.sent, [], path);
  }
});

test('Marketplace only follows Facebook moving to Home by itself, with replace so Back does not bounce', () => {
  const win = fakeWin('/marketplace/');
  const router = boot(win, { marketplaceOnly: true });
  for (const listener of router.listeners) listener({ type: 'marketplace' });
  assert.deepEqual(win.sent, []);
  for (const listener of router.listeners) listener({ type: 'home' });
  assert.deepEqual(win.sent, [['replace', '/marketplace/']]);
});

const TOP_BAR = `
<div role="banner">
  <a aria-label="Facebook" href="/" data-row="logo">f</a>
  <div role="navigation"><ul>
    <li data-row="tab:Home"><span><div><a aria-label="Home" href="/"></a></div></span></li>
    <li data-row="tab:Friends"><span><div><a aria-label="Friends" href="/friends/"></a></div></span></li>
    <li data-row="tab:Groups"><span><div><a aria-label="Groups" href="/groups/"></a></div></span></li>
    <li data-row="tab:Video"><span><div><a aria-label="Video" href="/watch/?ref=tab"></a></div></span></li>
    <li data-row="tab:Marketplace"><span><div><a aria-label="Marketplace" href="/marketplace/"></a></div></span></li>
    <li data-row="tab:Gaming"><span><div><a aria-label="Gaming" href="/gaming/"></a></div></span></li>
  </ul></div>
  <div role="navigation"><div data-row="find-friends"><a href="/friends/">Find friends</a></div></div>
</div>`;

test('the top bar keeps the logo and Marketplace, and the other tabs and Find friends go', () => {
  const win = new Window({ url: `${FB}/marketplace/` });
  windows.push(win);
  win.document.body.innerHTML = TOP_BAR;
  const rule = MARKETPLACE_ONLY_CSS.split('\n').filter((line) => !line.startsWith('html[')).join('\n');
  const selectors = rule.slice(0, rule.lastIndexOf(' { display: none !important; }'));
  const hidden = [...win.document.querySelectorAll(selectors)].map((el) => el.dataset.row).sort();
  assert.deepEqual(hidden, ['find-friends', 'tab:Friends', 'tab:Gaming', 'tab:Groups', 'tab:Home', 'tab:Video']);
  assert.match(MARKETPLACE_ONLY_CSS, /html\[data-hfw-route="home"\]:not\(\[data-hfw-marketplace-loop\]\) \[role="main"\] \{ visibility: hidden !important; \}/);
});

test('Marketplace only stops sending Home away when Marketplace keeps sending the tab back', () => {
  const store = new Map([['hfw:started', '1']]);
  const warnings = [];
  const loads = [];
  for (let i = 0; i < 6; i++) {
    const happy = new Window({ url: `${FB}/` });
    windows.push(happy);
    const win = { ...fakeWin('/', { store }), document: happy.document };
    marketplaceOnly.setup({ win, router: null, enabled: () => true, log: { warn: (message) => warnings.push(message) } });
    loads.push([win.sent.length, happy.document.documentElement.hasAttribute(LOOP_MARK)]);
  }
  assert.deepEqual(loads, [[1, false], [1, false], [1, false], [1, false], [0, true], [0, true]]);
  assert.equal(warnings.length, 2, 'once per page');
  // The count starts over after a quiet spell.
  assert.equal(mayRedirect({ sessionStorage: fakeWin('/', { store }).sessionStorage }, Date.now() + 20000), true);
});

test('Marketplace only stops following Facebook back to Home in a loop, and warns once', () => {
  const happy = new Window({ url: `${FB}/marketplace/` });
  windows.push(happy);
  const win = { ...fakeWin('/marketplace/'), document: happy.document };
  const router = { listeners: [], subscribe(fn) { this.listeners.push(fn); } };
  const warnings = [];
  marketplaceOnly.setup({ win, router, enabled: () => true, log: { warn: (message) => warnings.push(message) } });
  for (let i = 0; i < 7; i++) router.listeners[0]({ type: 'home' });
  assert.equal(win.sent.length, 4);
  assert.equal(warnings.length, 1);
  assert.ok(happy.document.documentElement.hasAttribute(LOOP_MARK), 'the feed shows instead of a blank page');
});

test('without session storage, Marketplace only always goes', () => {
  const win = fakeWin('/', { storage: false });
  for (let i = 0; i < 6; i++) assert.equal(mayRedirect(win), true);
});

test('a click on the logo or Home goes to Marketplace in the page, or by address without a Marketplace link', () => {
  const page = (html) => {
    const happy = new Window({ url: `${FB}/marketplace/item/1/` });
    windows.push(happy);
    happy.document.body.innerHTML = html;
    // Every click that reaches the document is cancelled, so happy-dom never follows a link,
    // and whether the script had already handled it is noted.
    const reached = [];
    happy.document.addEventListener('click', (event) => {
      reached.push({ label: event.target.getAttribute('aria-label') ?? event.target.dataset.row, prevented: event.defaultPrevented });
      event.preventDefault();
    });
    const sent = [];
    const win = {
      document: happy.document,
      location: { href: happy.location.href, replace: (to) => sent.push(['replace', to]), assign: (to) => sent.push(['assign', to]) },
      addEventListener: (...args) => happy.addEventListener(...args),
    };
    let on = true;
    marketplaceOnly.setup({ win, router: null, enabled: () => on });
    const click = (el, init = {}) => {
      const event = new happy.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
      el.dispatchEvent(event);
      return event;
    };
    return { doc: happy.document, sent, reached, click, off: () => { on = false; } };
  };
  const { doc, sent, reached, click } = page(`${TOP_BAR}<div role="navigation"><a data-row="left" href="${FB}/marketplace/?ref=bookmark">Marketplace</a></div>`);
  const logo = click(doc.querySelector('[data-row="logo"]'));
  assert.equal(logo.defaultPrevented, true);
  // The logo's click stopped at the script, and the top bar's own Marketplace link, which comes
  // before the left column's, got a click of its own.
  assert.deepEqual(reached, [{ label: 'Marketplace', prevented: false }]);
  assert.deepEqual(sent, []);
  // Ctrl+click opens a new tab as the person asked.
  reached.length = 0;
  click(doc.querySelector('[aria-label="Home"]'), { ctrlKey: true });
  assert.deepEqual(reached, [{ label: 'Home', prevented: false }]);
  // So does a link made to open in a new tab.
  reached.length = 0;
  const newTab = doc.createElement('a');
  newTab.setAttribute('href', '/');
  newTab.setAttribute('target', '_blank');
  newTab.dataset.row = 'new-tab';
  doc.body.append(newTab);
  click(newTab);
  assert.deepEqual(reached, [{ label: 'new-tab', prevented: false }]);
  assert.deepEqual(sent, []);
  // Without a Marketplace link to click, the address does it.
  const bare = page('<div role="banner"><a aria-label="Facebook" href="/">f</a></div>');
  bare.click(bare.doc.querySelector('a'));
  assert.deepEqual(bare.sent, [['assign', '/marketplace/']]);
  assert.deepEqual(bare.reached, []);
  // Switched off, Home is Home.
  bare.off();
  bare.click(bare.doc.querySelector('a'));
  assert.deepEqual(bare.reached, [{ label: 'Facebook', prevented: false }]);
  assert.equal(bare.sent.length, 1);
});
