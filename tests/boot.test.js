// The start in one Facebook tab (boot.js), run on a happy-dom page the way main.js runs it: what
// a tab paused for itself sets up, and the ways into and out of that pause.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../src/boot.js';
import { TAB_PAUSE_KEY } from '../src/core/load-watchdog.js';
import { MONSTER } from '../src/core/storage-report.js';
import { features as allFeatures } from '../src/features/index.js';
import { testWindow } from './helpers/dom.js';

const GLOBALS = ['document', 'Node', 'CSS', 'requestAnimationFrame', 'navigator', 'setTimeout', 'clearTimeout'];
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// A Facebook tab with a userscript manager's storage, its globals lent the way the panel reads
// them. reloads holds the tab's pause mark as it stood at each reload.
function tab({ paused = false } = {}) {
  const win = testWindow('https://www.facebook.com/');
  cleanups.push(() => win.happyDOM.close());
  const values = new Map();
  const lent = {
    GM_getValue: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    GM_setValue: (key, value) => values.set(key, value),
    GM_deleteValue: (key) => values.delete(key),
    GM_addValueChangeListener: () => 0,
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
  return { win, reloads, listened, modules, before, shadow: () => shadow, block: (on) => (blocked = on) };
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
