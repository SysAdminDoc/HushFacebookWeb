// The card each Marketplace listing link sits in, found for a whole page at once. It's the
// largest box around the link that holds no other listing, the rule the cards have always had,
// now worked out in one pass over the page instead of a search of every box for every card.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { LISTING_MARK, itemId, listingCards, watchListingCards } from '../src/features/marketplace/listing-cards.js';
import { parseRoute } from '../src/core/route.js';

const SEARCH = 'https://www.facebook.com/marketplace/search/?query=case';
const LINKS = '[role="main"] a[href*="/marketplace/item/"]';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(html) {
  const win = testWindow(SEARCH);
  windows.push(win);
  win.document.body.innerHTML = html;
  return win;
}

// The rule as it was written before, one box at a time.
function cardByHand(link, id) {
  let card = link;
  for (let parent = card.parentElement; parent && parent.getAttribute('role') !== 'main'; parent = parent.parentElement) {
    for (const other of parent.querySelectorAll('a[href*="/marketplace/item/"]')) {
      if (itemId(other) !== id) return card;
    }
    card = parent;
  }
  return null;
}

const describe = (el) => (el ? `${el.localName}#${el.id}` : 'null');

function sameAsByHand(doc, label) {
  const links = [...doc.querySelectorAll(LINKS)];
  const cardOf = listingCards(links);
  let compared = 0;
  for (const link of links) {
    const id = itemId(link);
    if (!id) continue;
    const want = cardByHand(link, id);
    const got = cardOf(link);
    assert.ok(got === want, `${label}: listing ${id} at ${describe(link)} got ${describe(got)}, not ${describe(want)}`);
    compared++;
  }
  return compared;
}

test('a listing shown twice, once in a box with others, still gets its own card', () => {
  // The first copy's walk records its listing all the way up. The second copy shares a box with
  // listing 2, and that box turning to several listings has to reach the box above it too.
  const win = page(`<div role="main"><div id="grid">
    <div id="one"><a id="first" href="/marketplace/item/1/">t</a></div>
    <div id="pair"><a id="again" href="/marketplace/item/1/">t again</a><a id="other" href="/marketplace/item/2/">m</a></div>
  </div></div>`);
  const doc = win.document;
  const cardOf = listingCards([...doc.querySelectorAll(LINKS)]);
  assert.ok(cardOf(doc.getElementById('first')) === doc.getElementById('one'));
  assert.ok(cardOf(doc.getElementById('again')) === doc.getElementById('again'));
  assert.ok(cardOf(doc.getElementById('other')) === doc.getElementById('other'));
  assert.equal(sameAsByHand(doc, 'shown twice'), 3);
});

test('a listing under a main column drawn inside another still tells the boxes above it apart', () => {
  // Listing 2 sits under the inner main column, so its own card search stops there, but the box
  // above it holds listing 1's cell too and has to count as holding two listings.
  const win = page(`<div role="main"><div id="outer">
    <div role="main" id="inner-main"><div id="two-cell"><a id="two" href="/marketplace/item/2/">m</a></div></div>
    <div id="one-cell"><a id="one" href="/marketplace/item/1/">t</a></div>
  </div></div>`);
  const doc = win.document;
  const cardOf = listingCards([...doc.querySelectorAll(LINKS)]);
  assert.ok(cardOf(doc.getElementById('one')) === doc.getElementById('one-cell'));
  assert.equal(cardOf(doc.getElementById('two')), null);
  assert.equal(sameAsByHand(doc, 'nested main'), 2);
});

test('a link with no listing id stops a card like another listing, and a lone listing has no card', () => {
  const win = page(`<div role="main"><div id="grid">
    <div id="cell"><div id="inner"><a id="listing" href="/marketplace/item/7/?ref=search">x</a></div><a id="odd" href="/marketplace/item/abc/">?</a></div>
  </div></div>`);
  const doc = win.document;
  const cardOf = listingCards([...doc.querySelectorAll(LINKS)]);
  assert.ok(cardOf(doc.getElementById('listing')) === doc.getElementById('inner'));
  const alone = page('<div role="main"><div><div><a id="only" href="/marketplace/item/7/">x</a></div></div></div>').document;
  assert.equal(listingCards([...alone.querySelectorAll(LINKS)])(alone.getElementById('only')), null);
});

test('on any layout the cards are the ones the box by box rule gives', () => {
  // Random grids, nested boxes, the same listing more than once and links with no id, from a
  // fixed seed so a failure always comes back the same.
  let seed = 20261115;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let n = 0;
  const box = (depth) => {
    n++;
    if (depth === 0 || random() < 0.25) {
      const id = random() < 0.1 ? 'abc' : String(1 + Math.floor(random() * 6));
      return `<a id="n${n}" href="/marketplace/item/${id}/">x</a>`;
    }
    const children = Array.from({ length: 1 + Math.floor(random() * 4) }, () => box(depth - 1)).join('');
    return `<div id="n${n}">${children}</div>`;
  };
  let compared = 0;
  for (let round = 0; round < 60; round++) {
    const doc = page(`<div role="main">${box(5)}</div>`).document;
    compared += sameAsByHand(doc, `layout ${round}`);
  }
  assert.ok(compared > 300, `only ${compared} links compared`);
});

test('hiding every card on a long page searches no box once per card', () => {
  // Facebook's grid sits a couple of dozen boxes under the main column. A walk that went all the
  // way up for every link would take that many steps a card.
  const cells = Array.from({ length: 300 }, (_, i) => `<div class="cell" data-id="${i + 1}"><div><a href="/marketplace/item/${i + 1}/"><div><img alt=""></div></a>
    <a href="/marketplace/item/${i + 1}/?ref=search"><span>Listing ${i + 1}</span></a></div></div>`).join('');
  const wrappers = 20;
  const win = page(`<div role="main">${'<div>'.repeat(wrappers)}<h2>Results</h2><div class="grid">${cells}</div>${'</div>'.repeat(wrappers)}</div>`);
  const doc = win.document;
  const searched = [];
  let steps = 0;
  for (const name of ['querySelectorAll', 'querySelector']) {
    const own = win.Element.prototype[name];
    win.Element.prototype[name] = function (selector) {
      searched.push(name);
      return own.call(this, selector);
    };
  }
  const getAttribute = win.Element.prototype.getAttribute;
  win.Element.prototype.getAttribute = function (name) {
    if (name === 'role') steps++;
    return getAttribute.call(this, name);
  };
  // Setting up checks the page once, the page being drawn already.
  const heard = [];
  watchListingCards({ doc, route: () => parseRoute(SEARCH), active: () => true, reasonOf: () => 'shipped', onHidden: (id) => heard.push(id) }).stop();
  assert.equal(heard.length, 300);
  const marked = [...doc.querySelectorAll(`[${LISTING_MARK}]`)];
  assert.equal(marked.length, 300);
  assert.ok(marked.every((card) => card.classList.contains('cell')), 'each whole cell, and nothing else');
  assert.deepEqual(searched, [], 'no box was searched for its listings');
  assert.ok(steps < 600 * 8, `${steps} steps up the page for 600 links`);
});
