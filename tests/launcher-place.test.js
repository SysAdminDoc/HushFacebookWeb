// Where the settings gear sits, against a top bar shaped like Facebook's as measured live on
// 2026-11-04 at 1600 px: the tabs a navigation as wide as the bar, the round buttons a 296 px
// navigation of their own ending 16 px from the right edge, 56 px tall. happy-dom has no layout,
// so each element's box and what's drawn at a point are set by hand.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { accountRow, barSpot, trackLauncherSpot } from '../src/ui/launcher-place.js';
import { panelCss, uiTokens } from '../src/ui/styles.js';
import { contrast } from '../src/features/appearance/accent.js';

const nodeSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((resolve) => nodeSetTimeout(resolve, ms));
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function boxed(el, left, top, width, height) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
  return el;
}

// One ResizeObserver per page, so a test can say the row changed size.
class FakeResizeObserver {
  static last = null;
  constructor(callback) {
    this.callback = callback;
    this.watched = new Set();
    FakeResizeObserver.last = this;
  }
  observe(el) { this.watched.add(el); }
  disconnect() { this.watched.clear(); }
  fire() { this.callback([...this.watched].map((target) => ({ target }))); }
}

function page({ width = 1600 } = {}) {
  const win = testWindow('https://www.facebook.com/');
  cleanups.push(() => win.happyDOM.close());
  win.happyDOM.setViewport({ width, height: 1000 });
  win.ResizeObserver = FakeResizeObserver;
  const doc = win.document;
  let drawn = [];
  doc.elementsFromPoint = () => drawn;
  const host = doc.createElement('div');
  const button = doc.createElement('button');
  host.append(button);
  doc.body.append(host);
  return { win, doc, host, button, draw: (...stack) => { drawn = stack; } };
}

// The bar, with the round buttons' row at rowLeft and rowWidth wide.
function bar(doc, { rowLeft = 1288, rowWidth = 296, width = 1600 } = {}) {
  const banner = boxed(doc.createElement('div'), 0, 0, width, 0);
  banner.setAttribute('role', 'banner');
  const tabs = boxed(doc.createElement('div'), 0, 0, width, 56);
  tabs.setAttribute('role', 'navigation');
  tabs.innerHTML = '<a href="/">Home</a><div role="button" aria-haspopup="menu">More</div>';
  const row = boxed(doc.createElement('div'), rowLeft, 0, rowWidth, 56);
  row.setAttribute('role', 'navigation');
  row.innerHTML = '<div role="button" aria-haspopup="dialog">Menu</div><div role="button" aria-haspopup="dialog">Notifications</div>';
  banner.append(tabs, row);
  doc.body.prepend(banner);
  return { banner, tabs, row };
}

const placed = (button) => [button.dataset.place, button.style.left, button.style.top];

test('the round buttons are found by shape, not by the tab row that spans the bar', () => {
  const { doc } = page();
  assert.equal(accountRow(doc), null, 'no bar yet');
  const { row } = bar(doc);
  const plain = boxed(doc.createElement('div'), 1000, 0, 100, 56);
  plain.setAttribute('role', 'navigation');
  plain.innerHTML = '<a href="/x">Link</a>';
  doc.querySelector('[role=banner]').prepend(plain);
  assert.equal(accountRow(doc) === row, true, 'the navigation with pop-up buttons that is narrower than half the window');
});

test('the gear sits 8 px before the round buttons, centered in the bar, and follows them', () => {
  const { doc, host, button, draw } = page();
  const { row } = bar(doc);
  draw(host, doc.body);
  const spot = trackLauncherSpot({ button, host, doc });
  cleanups.push(() => spot.stop());
  assert.deepEqual(placed(button), ['bar', '1240px', '8px']);

  // A post opened: Find friends left the row, so its near edge moved right.
  boxed(row, 1400, 0, 184, 56);
  FakeResizeObserver.last.fire();
  assert.deepEqual(placed(button), ['bar', '1352px', '8px']);
  assert.equal(FakeResizeObserver.last.watched.has(doc.querySelector('[role=banner]')), true, 'the banner is watched too, for the scroll bar');
});

test('right to left, the row sits on the left and the gear goes after it', () => {
  const { doc, host, button } = page();
  bar(doc, { rowLeft: 16 });
  const spot = trackLauncherSpot({ button, host, doc });
  cleanups.push(() => spot.stop());
  assert.deepEqual(placed(button), ['bar', '320px', '8px']);
});

test('something clickable on the spot keeps the gear off it, but its own host and plain page do not', () => {
  const { doc, host, draw } = page();
  const { row, tabs } = bar(doc);
  draw(host, doc.createElement('div'));
  assert.deepEqual(barSpot(row, doc, host), { left: 1240, top: 8 });
  draw(host, tabs.querySelector('a'));
  assert.equal(barSpot(row, doc, host), null, 'a tab there');
  const inner = doc.createElement('span');
  tabs.querySelector('[role=button]').append(inner);
  draw(inner);
  assert.equal(barSpot(row, doc, host), null, 'inside a button there');
  draw(host);
  boxed(row, 1584, 0, 0, 56);
  assert.equal(barSpot(row, doc, host), null, 'a row with nothing in it');
  boxed(row, 30, 0, 1560, 56);
  assert.equal(barSpot(row, doc, host), null, 'no room before it at the window edge');
  boxed(row, 1288, 4, 296, 48);
  assert.deepEqual(barSpot(row, doc, host), { left: 1240, top: 8 }, 'centered on the row, wherever it is');
});

test('without the bar the gear waits unseen, then shows in the corner, and moves up when the bar comes', async () => {
  const { doc, host, button } = page();
  const spot = trackLauncherSpot({ button, host, doc, graceMs: 40, pollMs: 10 });
  cleanups.push(() => spot.stop());
  assert.deepEqual(placed(button), ['wait', '', '']);
  await sleep(120);
  assert.deepEqual(placed(button), ['corner', '', '']);
  bar(doc);
  await sleep(60);
  assert.deepEqual(placed(button), ['bar', '1240px', '8px'], 'the poll found it');
});

test('a spot taken by a tab sends the gear to the corner once the grace time is up', async () => {
  const { doc, host, button, draw } = page({ width: 500 });
  const { tabs } = bar(doc, { rowLeft: 300, rowWidth: 184, width: 500 });
  draw(tabs.querySelector('a'));
  const spot = trackLauncherSpot({ button, host, doc, graceMs: 40, pollMs: 10 });
  cleanups.push(() => spot.stop());
  assert.equal(button.dataset.place, 'wait');
  await sleep(120);
  assert.deepEqual(placed(button), ['corner', '', '']);
  draw(host);
  doc.defaultView.dispatchEvent(new doc.defaultView.Event('resize'));
  assert.deepEqual(placed(button), ['bar', '252px', '8px'], 'a resize that clears it brings the gear back');
});

test('a spot that clears later brings the gear back from the corner on its own', async () => {
  const { doc, host, button, draw } = page({ width: 500 });
  const { tabs } = bar(doc, { rowLeft: 300, rowWidth: 184, width: 500 });
  draw(tabs.querySelector('a'));
  const spot = trackLauncherSpot({ button, host, doc, graceMs: 40, pollMs: 10 });
  cleanups.push(() => spot.stop());
  await sleep(120);
  assert.deepEqual(placed(button), ['corner', '', '']);
  draw(host);
  await sleep(60);
  assert.deepEqual(placed(button), ['bar', '252px', '8px'], 'no resize needed');
});

test('a row left empty in the page gives way to the one Facebook draws instead', async () => {
  const { doc, host, button } = page();
  const { row, banner } = bar(doc);
  const spot = trackLauncherSpot({ button, host, doc, graceMs: 0, pollMs: 10 });
  cleanups.push(() => spot.stop());
  assert.equal(button.dataset.place, 'bar');
  boxed(row, 0, 0, 0, 0);
  const fresh = boxed(row.cloneNode(true), 1400, 0, 184, 56);
  banner.append(fresh);
  FakeResizeObserver.last.fire();
  await sleep(60);
  assert.deepEqual(placed(button), ['bar', '1352px', '8px']);
  assert.equal(FakeResizeObserver.last.watched.has(fresh), true, 'the drawn row is the one watched');

  // With no other row, the empty one is still watched, so its coming back is seen at once.
  boxed(fresh, 0, 0, 0, 0);
  FakeResizeObserver.last.fire();
  assert.equal(button.dataset.place, 'corner');
  assert.equal(FakeResizeObserver.last.watched.has(fresh), true);
});

test('a row Facebook swaps out is found again', async () => {
  const { doc, host, button } = page();
  const { row } = bar(doc);
  const spot = trackLauncherSpot({ button, host, doc, pollMs: 10 });
  cleanups.push(() => spot.stop());
  const fresh = boxed(row.cloneNode(true), 1400, 0, 184, 56);
  row.replaceWith(fresh);
  await sleep(60);
  assert.deepEqual(placed(button), ['bar', '1352px', '8px']);
  assert.equal(FakeResizeObserver.last.watched.has(fresh), true, 'the new row is the one watched');
  assert.equal(FakeResizeObserver.last.watched.has(row), false);
});

test("the gear's focus ring shows on Facebook's light top bar as well as its dark one", () => {
  const token = (name) => new RegExp(`--${name}: (#[0-9a-f]{6})`).exec(uiTokens)[1];
  const rule = /\.launcher:focus-visible \{([^}]*)\}/.exec(panelCss)?.[1] ?? '';
  const offset = Number(/outline-offset: (\d+)px/.exec(rule)?.[1]);
  const halo = /box-shadow: 0 0 0 (\d+)px var\(--(\w+)\)/.exec(rule);
  assert.ok(halo, `a dark halo under the ring: ${rule}`);
  assert.ok(Number(halo[1]) >= offset, 'the halo fills the gap between the gear and its ring');
  const [ring, under] = [token('accent'), token(halo[2])];
  assert.ok(contrast(ring, under) >= 3);
  // Facebook's top bar, light and dark.
  for (const bar of ['#ffffff', '#242526']) assert.ok(Math.max(contrast(ring, bar), contrast(under, bar)) >= 3, bar);
  const corner = /\.launcher\[data-place="corner"\]:focus-visible \{([^}]*)\}/.exec(panelCss)?.[1] ?? '';
  assert.match(corner, /box-shadow: 0 0 0 \d+px var\(--\w+\), 0 2px 12px #0006/, 'the gear in the corner keeps its shadow too');
});

test('a page change places the gear again, and a hidden gear is left alone', async () => {
  const { doc, host, button } = page();
  const { row } = bar(doc);
  const listeners = [];
  const router = { subscribe: (listener) => { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1); } };
  const spot = trackLauncherSpot({ button, host, doc, router });
  boxed(row, 1400, 0, 184, 56);
  for (const listener of listeners) listener({ type: 'marketplace' });
  await sleep(20);
  assert.deepEqual(placed(button), ['bar', '1352px', '8px']);

  button.hidden = true;
  boxed(row, 1288, 0, 296, 56);
  spot.update();
  assert.deepEqual(placed(button), ['bar', '1352px', '8px'], 'nothing measured while hidden');
  button.hidden = false;
  spot.update();
  assert.deepEqual(placed(button), ['bar', '1240px', '8px']);

  spot.stop();
  assert.equal(listeners.length, 0, 'stop lets go of the router');
});
