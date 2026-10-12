// Expand long posts, against cut-off text shaped like Facebook's (live 2026-10-12).

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import expandLongPosts, { createExpander, isSeeMore } from '../src/features/feed/expand-long-posts.js';
import { features } from '../src/features/index.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(body) {
  const win = new Window({ url: 'https://www.facebook.com/' });
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

test('the switch starts off in News feed', () => {
  assert.equal(expandLongPosts.default, false);
  assert.equal(expandLongPosts.section, 'feed');
  assert.ok(features.includes(expandLongPosts));
});
