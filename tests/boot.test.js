// The start in one Facebook tab (boot.js), run on a happy-dom page the way main.js runs it: what
// a tab paused for itself sets up, and the ways into and out of that pause.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../src/boot.js';
import { OWN, hideCss } from '../src/core/dom/hide.js';
import { setLanguage } from '../src/core/i18n.js';
import { CONFIRM_MS, LOAD_WAIT_MS, TAB_PAUSE_KEY } from '../src/core/load-watchdog.js';
import { MONSTER } from '../src/core/storage-report.js';
import { pickerRules } from '../src/features/appearance/hide-parts.js';
import { features as allFeatures } from '../src/features/index.js';
import { testWindow } from './helpers/dom.js';

const GLOBALS = ['document', 'Node', 'CSS', 'requestAnimationFrame', 'navigator', 'setTimeout', 'clearTimeout'];
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// A Facebook tab with a userscript manager's storage, its globals lent the way the panel reads
// them. reloads holds the tab's pause mark as it stood at each reload, menu the entries put in the
// manager's menu, and kept is what the manager already holds.
function tab({ paused = false, kept = {} } = {}) {
  const win = testWindow('https://www.facebook.com/');
  cleanups.push(() => win.happyDOM.close());
  const values = new Map(Object.entries(kept));
  const menu = [];
  const lent = {
    GM_getValue: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    GM_setValue: (key, value) => values.set(key, value),
    GM_deleteValue: (key) => values.delete(key),
    GM_addValueChangeListener: () => 0,
    GM_registerMenuCommand: (label) => menu.push(label),
  };
  for (const name of GLOBALS) lent[name] = name === 'requestAnimationFrame' ? (fn) => win.setTimeout(fn, 0) : win[name];
  const saved = Object.keys(lent).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  for (const [name, value] of Object.entries(lent)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  cleanups.push(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  let shadow = null;
  const attach = win.HTMLElement.prototype.attachShadow;
  win.HTMLElement.prototype.attachShadow = function (init) {
    shadow = attach.call(this, init);
    return shadow;
  };
  // The tab's storage, which block() makes refuse writes. happy-dom's own takes an assigned
  // method as an item, so it can't be made to refuse.
  const session = new Map(paused ? [[TAB_PAUSE_KEY, '1']] : []);
  let blocked = false;
  const write = (fn) => (...args) => {
    if (blocked) throw new Error('blocked');
    fn(...args);
  };
  Object.defineProperty(win, 'sessionStorage', { configurable: true, value: {
    getItem: (key) => session.get(key) ?? null,
    setItem: write((key, value) => session.set(key, String(value))),
    removeItem: write((key) => session.delete(key)),
  } });
  const reloads = [];
  win.location.reload = () => reloads.push(session.get(TAB_PAUSE_KEY) ?? null);
  // The Facebook modules the start asks for, by name.
  const modules = [];
  win.requireLazy = (names) => modules.push(...names);
  // happy-dom keeps responseText off XMLHttpRequest.prototype, where browsers have it, so the
  // XHR hook can't install here. hooks.test.js covers it.
  delete win.XMLHttpRequest;
  // Every document listener the start adds, by type.
  const listened = [];
  const listen = win.document.addEventListener;
  win.document.addEventListener = function (type, ...rest) {
    listened.push(type);
    return listen.call(this, type, ...rest);
  };
  const before = { pushState: win.history.pushState, fetch: win.fetch, parse: win.JSON.parse };
  return { win, reloads, listened, modules, before, menu, shadow: () => shadow, block: (on) => (blocked = on) };
}

// A feature that counts its setups, on by default.
const counted = () => {
  const feature = { id: 'counted', section: 'feed', title: 'Counted', description: 'Counts its setups.', default: true, setups: 0 };
  feature.setup = () => feature.setups++;
  return feature;
};

const quiet = (t) => {
  for (const level of ['info', 'warn']) t.mock.method(console, level, () => {});
};
const notices = (shadow) => [...shadow.querySelectorAll('.toast')];
const button = (notice, label) => [...notice.querySelectorAll('button')].find((b) => b.textContent === label);

test('a tab paused for itself sets up only the settings panel, and Turn back on clears the pause before it reloads', (t) => {
  quiet(t);
  const { win, reloads, listened, modules, before, shadow, block } = tab({ paused: true });
  const feature = counted();
  const started = boot({ win, doc: win.document, access: 'page', own: win, features: [...allFeatures, feature] });
  assert.equal(started.settings.get('paused'), true);
  assert.equal(started.net, null, 'no network hooks');
  assert.equal(started.router, null, 'no page-change watch');
  assert.equal(started.hider, null, 'nothing for hidden posts');
  assert.equal(win.fetch, before.fetch);
  assert.equal(win.JSON.parse, before.parse);
  assert.equal(win.history.pushState, before.pushState, "the page's history is left alone");
  assert.ok(!win.document.querySelector('style[data-hushfacebook-web="features"]'), 'no feature styles');
  assert.ok(!listened.includes('keyup'), 'no key listeners for hidden-post notes');
  assert.equal(feature.setups, 0, 'no feature starts');
  assert.ok(shadow().querySelector('[role="dialog"], section, nav'), 'the settings panel is there');
  assert.ok(listened.includes('pointercancel'), 'a long press on the logo still opens the settings');
  assert.deepEqual(modules, [MONSTER], "only the guard that keeps the tab's marks out of Facebook's storage report");

  const [notice] = notices(shadow());
  assert.match(notice.textContent, /paused in this tab/);
  block(true);
  button(notice, 'Turn back on').click();
  assert.deepEqual(reloads, [], "storage that won't clear the mark leaves the tab as it is");
  assert.match(notices(shadow()).at(-1).textContent, /Couldn't turn it back on in this tab/);
  block(false);
  button(notice, 'Turn back on').click();
  assert.deepEqual(reloads, [null], 'the mark is gone before the reload');
});

test('a tab that is not paused hooks the page, and Pause for this tab marks the tab before it reloads', (t) => {
  quiet(t);
  const { win, reloads, listened, modules, before, shadow, block } = tab();
  const feature = counted();
  const started = boot({ win, doc: win.document, access: 'page', own: win, features: [feature] });
  assert.ok(started.net && started.router && started.hider);
  assert.equal(feature.setups, 1);
  assert.ok(modules.includes(MONSTER));
  const refresh = t.mock.method(started.hider, 'refresh', () => {});
  started.settings.set('ui.hiddenNote', true);
  assert.ok(refresh.mock.callCount() > 0, 'a settings change refreshes the hidden-post notes');
  assert.notEqual(win.fetch, before.fetch);
  assert.notEqual(win.history.pushState, before.pushState);
  assert.ok(win.document.querySelector('style[data-hushfacebook-web="features"]'));
  assert.ok(listened.includes('keyup'));

  block(true);
  started.pauseTab();
  assert.deepEqual(reloads, []);
  assert.match(notices(shadow()).at(-1).textContent, /Couldn't pause for this tab/);
  block(false);
  started.pauseTab();
  assert.deepEqual(reloads, ['1']);
});

test('the note setting reaches the page rules and the hider, and Only for your own filters notes a filtered post but not an ad', (t) => {
  quiet(t);
  const { win } = tab();
  const started = boot({ win, doc: win.document, access: 'page', own: win, features: [counted()] });
  const rules = () => win.document.querySelector('style[data-hushfacebook-web="features"]').textContent;
  assert.ok(rules().includes(hideCss({ notes: false })) && !rules().includes(hideCss({ notes: OWN })), 'Never to start');
  win.document.body.insertAdjacentHTML('beforeend', '<div aria-posinset="1"><div><a href="/someone/posts/pfbid0Mine">2h</a></div></div><div aria-posinset="2"><div><a href="/someone/posts/pfbid0Ad">2h</a></div></div>');
  const [filtered, ad] = win.document.querySelectorAll('[aria-posinset]');
  started.hider.hide(filtered, 'Filter', 'cats');
  started.hider.hide(ad, 'Sponsored');
  const asButton = (element) => element.firstElementChild.getAttribute('role') === 'button';
  started.settings.set('ui.hiddenNote', OWN);
  assert.ok(rules().includes(hideCss({ notes: OWN })), 'the rules for your own filters');
  assert.deepEqual([asButton(filtered), asButton(ad)], [true, false]);
  started.settings.set('ui.hiddenNote', true);
  assert.ok(rules().includes(hideCss({ notes: true })), 'the rules for every note');
  assert.deepEqual([asButton(filtered), asButton(ad)], [true, true]);
  started.settings.set('paused', true);
  assert.deepEqual([asButton(filtered), asButton(ad)], [false, false], 'paused, no note takes a click');
});

test("the manager's menu entry and a hidden post's note read in the saved language, and the note follows a change", (t) => {
  quiet(t);
  cleanups.push(() => setLanguage('en'));
  const { win, menu } = tab({ kept: { settings: { 'ui.language': 'ru', 'ui.hiddenNote': true } } });
  const started = boot({ win, doc: win.document, access: 'page', own: win, features: [counted()] });
  assert.deepEqual(menu, ['Настройки HushFacebook Web']);
  win.document.body.insertAdjacentHTML('beforeend', '<div aria-posinset="1"><div><a href="/someone/posts/pfbid0Ad">2h</a></div></div>');
  const ad = win.document.querySelector('[aria-posinset]');
  started.hider.hide(ad, 'Sponsored');
  const note = () => ad.firstElementChild.getAttribute('data-hfw-note');
  assert.equal(note(), 'Скрыто: Реклама. Показать');
  started.settings.set('ui.language', 'en');
  assert.equal(note(), 'Hidden: Sponsored. Show');
  assert.equal(ad.firstElementChild.getAttribute('aria-label'), 'Hidden: Sponsored. Show');
});

// A signed-in Home held behind Facebook's splash screen. The feed check's two waits run when
// runChecks() says, everything else on happy-dom's clock.
function stuckHome(t) {
  const warnings = [];
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const opened = tab();
  const { win } = opened;
  win.document.cookie = 'c_user=100';
  const splash = win.document.createElement('div');
  splash.id = 'splash-screen';
  win.document.body.append(splash);
  const due = [];
  const schedule = win.setTimeout;
  win.setTimeout = function (fn, ms, ...rest) {
    if (ms === LOAD_WAIT_MS || ms === CONFIRM_MS) return due.push(fn);
    return schedule.call(this, fn, ms, ...rest);
  };
  const started = boot({ win, doc: win.document, access: 'page', own: win, features: [counted()] });
  const runChecks = () => {
    while (due.length) due.shift()();
  };
  const tick = () => new Promise((resolve) => schedule.call(win, resolve, 0));
  const stuck = () => notices(opened.shadow()).filter((notice) => /still loading after 20 seconds/.test(notice.textContent));
  return { ...opened, started, runChecks, tick, stuck, warnings };
}

test('the stuck feed notice turns its own warning off from Stop these warnings', async (t) => {
  const { started, runChecks, tick, stuck, shadow } = stuckHome(t);
  runChecks();
  assert.equal(stuck().length, 1);
  assert.deepEqual([...stuck()[0].querySelectorAll('button')].map((entry) => entry.textContent), ['Pause for this tab', 'Stop these warnings', 'Copy report']);
  button(stuck()[0], 'Stop these warnings').click();
  for (let i = 0; i < 20 && !/Feed load warnings are off/.test(shadow().textContent); i++) await tick();
  assert.equal(started.settings.get('ui.loadWarning'), false);
  assert.match(notices(shadow()).at(-1).textContent, /Feed load warnings are off/);
});

test('with the feed warning off, a stuck feed is logged without a notice', async (t) => {
  const { started, runChecks, stuck, warnings } = stuckHome(t);
  await started.settings.set('ui.loadWarning', false);
  runChecks();
  assert.equal(stuck().length, 0);
  assert.ok(warnings.some((line) => /Home was still loading 20 seconds after it opened/.test(line)), 'the log still has it for Copy report');
});

test('a network installation failure leaves the panel and page cleanup usable and names the missing protection', (t) => {
  quiet(t);
  t.mock.method(console, 'error', () => {});
  const { win, before, shadow } = tab();
  win.XMLHttpRequest = class {};
  const cleanup = counted();
  const network = { ...counted(), id: 'network', needsPage: true };
  const started = boot({ win, doc: win.document, access: 'page', own: win, features: [cleanup, network] });
  assert.ok(!started.net, 'the failed network installation is unavailable');
  assert.ok(started.hider && started.router, 'DOM cleanup and SPA routing still start');
  assert.equal(cleanup.setups, 1);
  assert.equal(network.setups, 0);
  assert.equal(win.fetch, before.fetch, 'the partial fetch wrapper was restored');
  assert.equal(win.JSON.parse, before.parse);
  assert.ok(shadow().querySelector('dialog'), 'settings mounted');
  assert.match(notices(shadow())[0].textContent, /Network filtering and privacy protection couldn't start/);
  button(notices(shadow())[0], 'Open').click();
  assert.match(shadow().textContent, /Network protection/);
  assert.match(shadow().textContent, /Unavailable\. Network filtering and privacy protection are off/);
});

test("the part picker hears the page ahead of the features' own window listeners, and Escape on its bar ends it", (t) => {
  quiet(t);
  const { win, shadow } = tab();
  const heard = [];
  let pickPart = null;
  // A feature that listens for clicks on the window as it starts, like Following feed.
  const feature = {
    id: 'listens', section: 'feed', title: 'Listens', description: 'Hears clicks on the window.', default: true,
    setup: (ctx) => {
      pickPart = ctx.pickPart;
      ctx.win.addEventListener('click', (event) => heard.push(event.type), true);
    },
  };
  boot({ win, doc: win.document, access: 'page', own: win, features: [feature] });
  win.document.body.insertAdjacentHTML('beforeend', '<div role="complementary"><div><h3 id="title">Birthdays</h3></div></div>');
  const title = win.document.getElementById('title');
  const click = () => title.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));

  pickPart({ section: 'appearance', rules: pickerRules, onSave: () => {} });
  const bar = shadow().querySelector('.picker');
  assert.ok(bar, 'the picker is running');
  assert.equal(click(), false, 'the pick is kept from the page');
  assert.deepEqual(heard, [], "and from the feature's listener, which came before the picker started");
  bar.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true }));
  assert.equal(shadow().querySelector('.picker'), null, 'Escape on the bar ends it, past the stop that keeps panel keys from the page');
  assert.equal(click(), true);
  assert.deepEqual(heard, ['click'], 'clicks reach the feature again');
});
