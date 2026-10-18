// Expand long posts, against cut-off text shaped like Facebook's (live 2026-10-12).

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { createSettings } from '../src/core/settings.js';
import { startFeatures } from '../src/core/start-features.js';
import { createMemoryStorage } from '../src/core/storage.js';
import expandLongPosts, { createExpander, isSeeMore } from '../src/features/feed/expand-long-posts.js';
import { features } from '../src/features/index.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(body) {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  win.document.body.innerHTML = body;
  return win;
}

const cut = (words = 'See more', id = 'more') => `<div dir="auto"><span>Come join us! L</span>…  <div role="button" tabindex="0" id="${id}">${words}</div></div>`;

test('the button after cut-off text is a See more, in any language', () => {
  const win = page(`<div aria-posinset="1"><div data-ad-preview="message">${cut()}</div></div>
    <div role="article" aria-label="Comment by Pat">${cut('Ver más', 'mas')}</div>
    <div aria-posinset="2"><div dir="auto">Done... ${'<div role="button" id="dots">See more</div>'}</div></div>`);
  const doc = win.document;
  assert.equal(isSeeMore(doc.getElementById('more')), true);
  assert.equal(isSeeMore(doc.getElementById('mas')), true);
  assert.equal(isSeeMore(doc.getElementById('dots')), true, 'three dots count too');
});

// A reel card's See more sits in an <object> inside the card's link, and opens nothing in place.
test('other buttons stay: no "…" before it, not last, a link or icon, a reel card, or outside posts', () => {
  const win = page(`<div aria-posinset="1">
      <div dir="auto">Whole text. <div role="button" id="whole">See more</div></div>
      <div dir="auto">Cut… <div role="button" id="early">See more</div><span>tail</span></div>
      <div dir="auto">Cut… <div role="button" id="link"><a href="/x">See more</a></div></div>
      <div dir="auto">Cut… <div role="button" id="icon"><svg></svg></div></div>
      <div dir="auto">Cut… <div role="button" id="long">See more of what people are saying here</div></div>
      <a href="/reel/1/?s=single_unit"><div>the fun to the sand!… <object><div role="button" id="reel">See more</div></object></div></a>
    </div>
    <div dir="auto">Cut… <div role="button" id="outside">See more</div></div>`);
  const doc = win.document;
  for (const id of ['whole', 'early', 'link', 'icon', 'long', 'reel', 'outside']) assert.equal(isSeeMore(doc.getElementById(id)), false, id);
});

test('buttons open as they come near the screen, once each, and not while switched off', () => {
  const win = page(`<div aria-posinset="1">${cut()}</div><div aria-posinset="2">${cut('See more', 'second')}</div>`);
  const watched = [];
  let callback = null;
  win.IntersectionObserver = class {
    constructor(run, options) { callback = run; this.options = options; }
    observe(target) { watched.push(target); }
    unobserve(target) { watched.splice(watched.indexOf(target), 1); }
  };
  let on = true;
  const clicks = [];
  for (const id of ['more', 'second']) win.document.getElementById(id).addEventListener('click', () => clicks.push(id));
  const expander = createExpander({ doc: win.document, enabled: () => on, setTimer: (fn) => fn() });
  expander.sync();
  assert.equal(watched.length, 2);
  expander.sync();
  assert.equal(watched.length, 2, 'each watched once');
  callback([{ isIntersecting: true, target: win.document.getElementById('more') }]);
  assert.deepEqual(clicks, ['more']);
  on = false;
  callback([{ isIntersecting: true, target: win.document.getElementById('second') }]);
  assert.deepEqual(clicks, ['more'], 'off: left alone');
  assert.equal(expander.opened(), 1);
});

// An IntersectionObserver that shows what it's watching and is told when a button comes near.
function fakeObserver(win) {
  const watching = new Set();
  let callback = null;
  win.IntersectionObserver = class {
    constructor(run) { callback = run; }
    observe(target) { watching.add(target); }
    unobserve(target) { watching.delete(target); }
  };
  return { watching, near: (...targets) => callback(targets.map((target) => ({ isIntersecting: true, target }))) };
}

function clicksOn(win, ids) {
  const clicks = [];
  for (const id of ids) win.document.getElementById(id).addEventListener('click', () => clicks.push(id));
  return clicks;
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 200); });

test('a button that came near while paused opens once the script is back on, and only once', async () => {
  const win = page(`<div aria-posinset="1">${cut()}</div><div aria-posinset="2">${cut('See more', 'second')}</div>`);
  const io = fakeObserver(win);
  const clicks = clicksOn(win, ['more', 'second']);
  const settings = createSettings({ storage: createMemoryStorage(), features: [expandLongPosts], migrations: [] });
  await settings.set('expandLongPosts', true);
  const rows = [];
  startFeatures({
    features: [expandLongPosts], settings, log: { error() {} }, unavailable: new Map(),
    context: () => ({ win, doc: win.document, diagnostics: { add: (label, read) => rows.push(read) } }),
  });
  const more = win.document.getElementById('more');
  assert.equal(io.watching.size, 2);

  // A post that shows up just as Pause goes on.
  win.document.body.insertAdjacentHTML('beforeend', `<div aria-posinset="3">${cut('See more', 'third')}</div>`);
  const third = win.document.getElementById('third');
  await settings.set('paused', true);
  await settle();
  assert.equal(io.watching.has(third), false, 'nothing new is watched while paused');
  io.near(more);
  assert.deepEqual(clicks, [], 'nothing clicked while paused');
  assert.equal(io.watching.has(more), false);

  await settings.set('paused', false);
  await settle();
  assert.equal(io.watching.has(more), true, 'watched again once back on');
  assert.equal(io.watching.has(third), true);
  io.near(more);
  assert.deepEqual(clicks, ['more']);
  // Still cut off after the click, as when Facebook opens it somewhere else, it isn't clicked again.
  win.document.body.append(win.document.createElement('div'));
  await settle();
  io.near(more);
  assert.equal(io.watching.has(more), false);
  assert.deepEqual(clicks, ['more']);
  assert.equal(rows[0](), '1');
});

test('a button taken off the page is let go, and watched again if Facebook puts it back', () => {
  const win = page(`<div aria-posinset="1">${cut()}</div><div aria-posinset="2">${cut('See more', 'second')}</div><div aria-posinset="3" id="third"></div>`);
  const io = fakeObserver(win);
  const clicks = clicksOn(win, ['more', 'second']);
  const expander = createExpander({ doc: win.document, enabled: () => true, setTimer: (fn) => fn() });
  expander.sync();
  const [more, second] = ['more', 'second'].map((id) => win.document.getElementById(id));
  const block = more.parentElement;

  block.remove();
  expander.sync();
  assert.deepEqual([...io.watching], [second], 'the taken-off button is no longer watched');
  io.near(more);
  assert.deepEqual(clicks, [], 'a late report about it clicks nothing');
  assert.equal(expander.opened(), 0);

  win.document.getElementById('third').append(block);
  expander.sync();
  assert.equal(io.watching.has(more), true);
  io.near(more, second);
  assert.deepEqual(clicks, ['more', 'second']);

  // One already opened and put back somewhere else stays opened once.
  block.remove();
  expander.sync();
  win.document.getElementById('third').append(block);
  expander.sync();
  assert.equal(io.watching.has(more), false);
  io.near(more);
  assert.deepEqual(clicks, ['more', 'second']);
  assert.equal(expander.opened(), 2);
});

test('without IntersectionObserver every button opens at once, but not while off, and once each', () => {
  const win = page(`<div aria-posinset="1">${cut()}</div><div aria-posinset="2">${cut('See more', 'second')}</div>`);
  win.IntersectionObserver = undefined;
  const clicks = clicksOn(win, ['more', 'second']);
  let on = false;
  const expander = createExpander({ doc: win.document, enabled: () => on, setTimer: (fn) => fn() });
  expander.sync();
  assert.deepEqual(clicks, []);
  on = true;
  expander.sync();
  expander.sync();
  assert.deepEqual(clicks, ['more', 'second']);
  assert.equal(expander.opened(), 2);
});

test('the switch starts off in News feed', () => {
  assert.equal(expandLongPosts.default, false);
  assert.equal(expandLongPosts.section, 'feed');
  assert.ok(features.includes(expandLongPosts));
});
