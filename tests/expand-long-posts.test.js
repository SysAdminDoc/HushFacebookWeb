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

// A text block the way Facebook's page builds one (live 2026-11-24): each piece its own text
// node, then the button. innerHTML would run the pieces together into one node.
function textBlock(doc, pieces, words, id) {
  const block = doc.createElement('div');
  block.setAttribute('dir', 'auto');
  const button = doc.createElement('div');
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '0');
  if (id) button.id = id;
  button.textContent = words;
  block.append(...pieces.map((piece) => doc.createTextNode(piece)), button);
  return block;
}

const FULL = 'Come join us! Later on there is more to say, and then it trails off...';

// Facebook's own toggle: See more swaps the cut-off text for all of it and a new See less
// button in the same block, and See less swaps it back with a new See more.
function toggling(doc, block, clicks, full = FULL) {
  const draw = (open) => {
    const next = textBlock(doc, open ? [full, ' '] : ['Come join us! L', '…', ' '], open ? 'See less' : 'See more');
    block.replaceChildren(...next.childNodes);
    block.lastElementChild.addEventListener('click', () => {
      clicks.push(open ? 'less' : 'more');
      draw(!open);
    });
  };
  draw(false);
  return block;
}

test('the button after cut-off text is a See more, in any language', () => {
  const win = page(`<div aria-posinset="1"><div data-ad-preview="message">${cut()}</div></div>
    <div role="article" aria-label="Comment by Pat">${cut('Ver más', 'mas')}</div>
    <div aria-posinset="2"><div dir="auto">Done<!-- -->...<!-- --> ${'<div role="button" id="dots">See more</div>'}</div></div>
    <div aria-posinset="3" id="third"></div>`);
  const doc = win.document;
  assert.equal(isSeeMore(doc.getElementById('more')), true);
  assert.equal(isSeeMore(doc.getElementById('mas')), true);
  assert.equal(isSeeMore(doc.getElementById('dots')), true, 'three dots of their own count too, past the server\'s comment marks');
  doc.getElementById('third').append(textBlock(doc, ['Come join us! L', '…', ' '], 'See more', 'pieces'));
  assert.equal(isSeeMore(doc.getElementById('pieces')), true, 'the text, the "…" and a space as three nodes');
});

// #19: an open post shows See less in the same place and shape, after the post's own words.
test('an open post\'s See less is left alone, even when the post itself ends in an ellipsis', () => {
  const win = page('<div aria-posinset="1" id="one"></div>');
  const doc = win.document;
  const one = doc.getElementById('one');
  one.append(
    textBlock(doc, [FULL, ' '], 'See less', 'dots'),
    textBlock(doc, ['It ends with the one character…', ' '], 'See less', 'one-char'),
    textBlock(doc, ['It ends plainly.', ' '], 'See less', 'plain'),
  );
  for (const id of ['dots', 'one-char', 'plain']) assert.equal(isSeeMore(doc.getElementById(id)), false, id);
});

test('a post that ends in an ellipsis opens once and stays open', () => {
  const win = page('<div aria-posinset="1" id="one"></div>');
  const doc = win.document;
  const io = fakeObserver(win);
  const clicks = [];
  const block = toggling(doc, doc.createElement('div'), clicks);
  doc.getElementById('one').append(block);
  const expander = createExpander({ doc, enabled: () => true, setTimer: (fn) => fn() });
  // Each look at the page, with whatever button is there coming near the screen.
  for (let round = 0; round < 4; round++) {
    expander.sync();
    io.near(block.lastElementChild);
  }
  assert.deepEqual(clicks, ['more']);
  assert.equal(block.lastElementChild.textContent, 'See less');
  assert.equal(expander.opened(), 1);
});

test('a post you close again with See less stays closed', () => {
  const win = page('<div aria-posinset="1" id="one"></div>');
  const doc = win.document;
  const io = fakeObserver(win);
  const clicks = [];
  const block = toggling(doc, doc.createElement('div'), clicks, 'All of it, said plainly.');
  doc.getElementById('one').append(block);
  const expander = createExpander({ doc, enabled: () => true, setTimer: (fn) => fn() });
  expander.sync();
  io.near(block.lastElementChild);
  assert.deepEqual(clicks, ['more']);
  block.lastElementChild.click();
  for (let round = 0; round < 3; round++) {
    expander.sync();
    io.near(block.lastElementChild);
  }
  assert.deepEqual(clicks, ['more', 'less']);
  assert.equal(block.lastElementChild.textContent, 'See more');
});

test('a text block that comes back holding another post\'s cut-off text opens again', () => {
  const win = page('<div aria-posinset="1" id="one"></div>');
  const doc = win.document;
  const io = fakeObserver(win);
  const clicks = [];
  const block = toggling(doc, doc.createElement('div'), clicks);
  doc.getElementById('one').append(block);
  const expander = createExpander({ doc, enabled: () => true, setTimer: (fn) => fn() });
  expander.sync();
  io.near(block.lastElementChild);
  assert.deepEqual(clicks, ['more']);
  const other = textBlock(doc, ['A different post that goes on for a wh', '…', ' '], 'See more');
  block.replaceChildren(...other.childNodes);
  block.lastElementChild.addEventListener('click', () => clicks.push('other'));
  expander.sync();
  io.near(block.lastElementChild);
  assert.deepEqual(clicks, ['more', 'other']);
  assert.equal(expander.opened(), 2);
});

test("an open post's text isn't read again on each look at the page", () => {
  const win = page('<div aria-posinset="1" id="one"></div>');
  const doc = win.document;
  const io = fakeObserver(win);
  const clicks = [];
  const block = toggling(doc, doc.createElement('div'), clicks);
  doc.getElementById('one').append(block);
  const expander = createExpander({ doc, enabled: () => true, setTimer: (fn) => fn() });
  expander.sync();
  io.near(block.lastElementChild);
  assert.deepEqual(clicks, ['more']);
  const own = Object.getOwnPropertyDescriptor(win.Node.prototype, 'textContent');
  let reads = 0;
  Object.defineProperty(block, 'textContent', { configurable: true, get() { reads++; return own.get.call(this); } });
  for (let round = 0; round < 3; round++) expander.sync();
  assert.equal(reads, 0, 'a See less is told apart by its shape before the block is read');
  assert.deepEqual(clicks, ['more']);
});

// A reel card's See more sits in an <object> inside the card's link, and opens nothing in place.
test('other buttons stay: no "…" before it, not last, a link or icon, a reel card, or outside posts', () => {
  const win = page(`<div aria-posinset="1">
      <div dir="auto">Whole text. <div role="button" id="whole">See more</div></div>
      <div dir="auto"><span>Cut</span>… <div role="button" id="early">See more</div><span>tail</span></div>
      <div dir="auto"><span>Cut</span>… <div role="button" id="link"><a href="/x">See more</a></div></div>
      <div dir="auto"><span>Cut</span>… <div role="button" id="icon"><svg></svg></div></div>
      <div dir="auto"><span>Cut</span>… <div role="button" id="long">See more of what people are saying here</div></div>
      <a href="/reel/1/?s=single_unit"><div>the fun to the sand!… <object><div role="button" id="reel">See more</div></object></div></a>
    </div>
    <div dir="auto"><span>Cut</span>… <div role="button" id="outside">See more</div></div>`);
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

test('the switch starts off under While you read', () => {
  assert.equal(expandLongPosts.default, false);
  assert.equal(expandLongPosts.section, 'reading');
  assert.ok(features.includes(expandLongPosts));
});
