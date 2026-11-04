// Wider feed on Home, against Home as it was laid out live on 2026-11-04 (structure only: the
// blocks between role=main and the posts, and the right column, with made-up names and text).
// How the widths and the folded column actually lay out is checked in a real browser:
// tests/browser, wider-feed.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import widerFeed, { BIRTHDAYS_MARK, birthdaysBlocks, feedWrappers, FOLDED_MARK, showsSomething, sideColumns, WIDE_MARK, widerFeedCss, widthOf } from '../src/features/appearance/wider-feed.js';
import { COLUMN_AD_CSS, COLUMN_AD_MARK } from '../src/features/feed/sponsored-column.js';
import { features } from '../src/features/index.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const POST = (n) => `<div><div><div aria-posinset="${n}"><h4><a href="/someone">Someone</a></h4><div>A post</div></div></div></div>`;
// Seven blocks from role=main down to the posts' list, as live: the outer flex item, two blocks,
// the centering row, the column with the post box and the Stories row, then two more.
const FEED = (posts) => `<div class="outer"><div><div><div class="row"><div class="column">
  <div></div><div role="region" aria-label="Create a post"><div role="button">What's on your mind?</div></div><div><div data-focus-target="stories_tray" role="region"></div></div>
  <div class="feed-wrap"><div><div class="list">${posts}</div></div></div>
</div></div></div></div></div>`;
const AD = `<div class="ad" ${COLUMN_AD_MARK}=""><h3>Sponsored</h3><a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fshop.example%2F"><img src="ad.jpg" alt=""><span>Shop now</span></a><div aria-label="Open menu for Shop sponsored content" role="button"><svg viewBox="0 0 20 20"><path d="M0 0h20v20H0z"></path></svg></div></div>`;
const CONTACTS = '<div class="contacts"><h2>Contacts</h2><div role="button"><svg><image href="p.jpg"></image></svg><span>Pat Example</span></div></div>';
const BIRTHDAYS = '<div class="birthdays"><div><h3>Birthdays</h3></div><div><a href="/events/birthdays/"><img src="gift.png" alt=""><span>Pat Example has a birthday today.</span></a></div></div>';
const HOME = (column, posts = POST(1) + POST(2) + POST(3)) => `<div role="banner"><a href="/">Facebook</a></div>
  <div class="page">
    <div role="navigation"><ul><li><a href="https://www.facebook.com/friends/">Friends</a></li></ul></div>
    <div role="main">${FEED(posts)}</div>
    <div role="complementary" id="right_rail_container"><div class="inner">${column}</div></div>
  </div>`;

function page(html, { route = 'home', css = '' } = {}) {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  const doc = win.document;
  if (route) doc.documentElement.dataset.hfwRoute = route;
  const style = doc.createElement('style');
  style.textContent = `${COLUMN_AD_CSS}\n${css}`;
  doc.head.append(style);
  doc.body.innerHTML = html;
  return win;
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const is = (element, selector) => Boolean(element?.matches(selector));

test("the blocks from role=main down to the posts' list take the width, the list and the posts don't", () => {
  const doc = page(HOME(AD)).document;
  const wrappers = feedWrappers(doc);
  const main = doc.querySelector('[role="main"]');
  assert.equal(wrappers.length, 7);
  assert.ok(wrappers[0] === doc.querySelector('.list').parentElement, 'starts right above the list');
  assert.ok(wrappers[6] === doc.querySelector('.outer') && wrappers[6].parentElement === main, 'ends at the block in role=main');
  assert.ok(wrappers.includes(doc.querySelector('.column')), 'the column holding the post box and Stories');
  assert.ok(!wrappers.some((block) => block.matches('.list, [aria-posinset]') || block.closest('.list')), 'nothing from the list down');
});

test('one post next to the placeholders finds the same blocks, a post alone in its list stays out of them', () => {
  // As live on load: the first post, then Facebook's empty placeholders.
  const loading = page(HOME(AD, `${POST(1)}<div></div><div></div><div><div></div></div>`)).document;
  const wrappers = feedWrappers(loading);
  assert.equal(wrappers.length, 7);
  assert.ok(wrappers[0] === loading.querySelector('.list').parentElement, 'starts right above the list');
  const two = page(HOME(AD, POST(1) + POST(2))).document;
  assert.ok(feedWrappers(two)[0] === two.querySelector('.list').parentElement, 'two posts and nothing else');
  const alone = page(HOME(AD, POST(1))).document;
  const outer = feedWrappers(alone);
  assert.ok(outer.length > 0 && outer.at(-1) === alone.querySelector('.outer'), 'still ends at the block in role=main');
  assert.ok(!outer.some((block) => block.closest('.feed-wrap')), "none of the blocks holding nothing but the post");
});

test('with no post, no role=main or only posts elsewhere, nothing takes the width', () => {
  assert.equal(feedWrappers(page(HOME(AD, '')).document).length, 0, 'no post');
  assert.equal(feedWrappers(page(HOME(AD).replace('role="main"', 'class="not-main"')).document).length, 0, 'no role=main');
  const outside = page(`<div role="main"><div><div></div></div></div><div role="dialog">${POST(1)}${POST(2)}</div>`).document;
  assert.equal(feedWrappers(outside).length, 0, 'posts in a dialog');
  // Posts straight in role=main have no list of their own below it.
  assert.equal(feedWrappers(page(`<div role="main">${POST(1)}${POST(2)}</div>`).document).length, 0, 'no list');
});

test('a column with nothing drawn in it shows nothing, words or a picture show', () => {
  const column = (html) => page(HOME(html)).document.querySelector('[role="complementary"]');
  assert.equal(showsSomething(column(AD)), false, 'the hidden Sponsored box');
  assert.equal(showsSomething(column('')), false, 'nothing in it');
  assert.equal(showsSomething(column(AD + CONTACTS)), true, 'contacts');
  assert.equal(showsSomething(column(AD + '<div><span>Pat Example has a birthday today.</span></div>')), true, 'words alone');
  assert.equal(showsSomething(column(AD + '<div><img src="banner.png" alt=""></div>')), true, 'a picture alone');
  assert.equal(showsSomething(column('<div style="display: none"><img src="b.png" alt=""><span>Hidden</span></div>')), false, 'hidden by display');
  assert.equal(showsSomething(column('<div><img style="visibility: hidden" src="b.png" alt=""></div>')), false, 'a picture hidden by visibility');
});

test("the side column is the page's own, not one in the feed or a dialog", () => {
  const doc = page(HOME(AD) + `<div role="dialog"><div role="complementary">${CONTACTS}</div></div>`).document;
  const main = doc.querySelector('[role="main"]');
  main.insertAdjacentHTML('beforeend', '<div role="complementary"></div>');
  const columns = sideColumns(doc);
  assert.ok(columns.length === 1 && columns[0] === doc.querySelector('#right_rail_container'));
});

test('the Birthdays box is the block around its link, up to its own heading and no further', () => {
  const blocks = (html) => {
    const doc = page(HOME(html)).document;
    return { doc, found: birthdaysBlocks(doc.querySelector('[role="complementary"]')) };
  };
  let { doc, found } = blocks(AD + BIRTHDAYS + CONTACTS);
  assert.ok(found.length === 1 && found[0] === doc.querySelector('.birthdays'), 'with its heading, beside the others');

  // No heading of its own: the Contacts heading after it is someone else's box.
  ({ doc, found } = blocks(`<div class="pair"><div class="bare"><a href="/events/birthdays/">Pat Example has a birthday today.</a></div>${CONTACTS}</div>`));
  assert.ok(found.length === 1 && found[0] === doc.querySelector('.bare'), 'a heading after the link');

  // A link to someone's profile in the same block stops the climb below it, even before it.
  ({ doc, found } = blocks('<div class="mixed"><a href="/pat.example">Pat Example</a><div class="row"><a href="/events/birthdays/">Birthdays</a></div></div>'));
  assert.ok(found.length === 1 && found[0] === doc.querySelector('.mixed .row'), 'another link');

  // Two headings before the link: the box above it is more than Birthdays.
  ({ doc, found } = blocks(`<div class="two"><h3>Friend requests</h3>${BIRTHDAYS}</div>`));
  assert.ok(found.length === 1 && found[0] === doc.querySelector('.birthdays'), 'another heading before it');

  // A box below it, past an empty spacer, with a plain title and plain rows: no heading, link or
  // button to stop at.
  ({ doc, found } = blocks(`<div class="plain-pair">${BIRTHDAYS}<div></div><div><span>Contacts</span><div><span>Pat Example</span></div></div></div>`));
  assert.ok(found.length === 1 && found[0] === doc.querySelector('.birthdays'), 'words after it');
  ({ doc, found } = blocks(`<div class="icon-pair">${BIRTHDAYS}<div><div role="button"><svg></svg></div></div></div>`));
  assert.ok(found.length === 1 && found[0] === doc.querySelector('.birthdays'), 'a button after it');

  // Its heading inside the link.
  ({ doc, found } = blocks(`<div class="in-link"><div><a href="/events/birthdays/"><h3>Birthdays</h3><span>Pat Example has a birthday today.</span></a></div></div>${CONTACTS}`));
  assert.ok(found.length === 1 && found[0] === doc.querySelector('.in-link'), 'a heading in the link');

  // The whole column can be Birthdays, but never the column itself.
  ({ doc, found } = blocks(BIRTHDAYS));
  assert.ok(found.length === 1 && found[0] === doc.querySelector('.inner'), 'the block in the column');
  assert.equal(blocks(AD + CONTACTS).found.length, 0, 'no Birthdays');
});

test('the rules count on Home only, at the width picked, and Birthdays only with its option', () => {
  assert.equal(widthOf((key) => (key === 'widerFeed.width' ? '1000' : undefined)), '1000');
  assert.equal(widthOf(() => '1200'), '900', 'a width not offered');
  assert.equal(widthOf(() => undefined), '900');
  assert.match(widerFeedCss('800', false), /width: 800px !important/);
  assert.doesNotMatch(widerFeedCss('800', false), new RegExp(BIRTHDAYS_MARK));
  assert.match(widerFeedCss('800', true), new RegExp(`\\[${BIRTHDAYS_MARK}\\] \\{ display: none !important; \\}`));
  assert.equal(widerFeed.css((key) => ({ 'widerFeed.width': '1000', 'widerFeed.birthdays': true })[key]), widerFeedCss('1000', true));
  assert.equal(widerFeed.css(() => undefined), widerFeedCss('900', false));

  const selectors = widerFeedCss('900', true).split('\n').map((rule) => rule.split(' {')[0]);
  for (const [route, count] of [['home', 4], ['feeds', 0], ['groups', 0]]) {
    const doc = page(HOME(BIRTHDAYS), { route }).document;
    doc.querySelector('.outer').setAttribute(WIDE_MARK, 'outer');
    doc.querySelector('[role="complementary"]').setAttribute(FOLDED_MARK, '');
    doc.querySelector('.birthdays').setAttribute(BIRTHDAYS_MARK, '');
    assert.equal(selectors.filter((selector) => doc.querySelector(selector)).length, count, route);
  }
});

test('setup marks the feed and folds the empty column, opens it for contacts, and follows the address, the switch and the option', async () => {
  let type = 'home';
  let on = true;
  const routeListeners = [];
  const settingsListeners = [];
  const router = { current: () => ({ type }), subscribe: (listener) => routeListeners.push(listener) };
  const settings = { subscribe: (listener) => settingsListeners.push(listener) };
  const win = page(HOME(AD), { css: widerFeedCss('900', false) });
  const doc = win.document;
  widerFeed.setup({ doc, router, settings, enabled: () => on });
  await tick(30);
  const wide = () => [...doc.querySelectorAll(`[${WIDE_MARK}]`)];
  const column = doc.querySelector('[role="complementary"]');
  const folded = () => column.hasAttribute(FOLDED_MARK);
  assert.equal(wide().length, 7);
  assert.ok(wide().filter((block) => block.getAttribute(WIDE_MARK) === 'outer').every((block) => block === doc.querySelector('.outer')));
  assert.equal(doc.querySelectorAll(`[${WIDE_MARK}="outer"]`).length, 1);
  assert.equal(folded(), true, 'only the hidden Sponsored box');

  // Contacts come in: the column opens again.
  doc.querySelector('.inner').insertAdjacentHTML('beforeend', CONTACTS);
  await tick(30);
  assert.equal(folded(), false, 'contacts');
  doc.querySelector('.contacts').remove();
  await tick(30);
  assert.equal(folded(), true, 'contacts gone');

  // Birthdays shows until its option hides it.
  doc.querySelector('.inner').insertAdjacentHTML('beforeend', BIRTHDAYS);
  await tick(30);
  assert.equal(is(doc.querySelector('.birthdays'), `[${BIRTHDAYS_MARK}]`), true, 'marked either way');
  assert.equal(folded(), false, 'Birthdays shown');
  doc.head.querySelector('style').textContent = `${COLUMN_AD_CSS}\n${widerFeedCss('900', true)}`;
  for (const listener of settingsListeners) listener();
  await tick(30);
  assert.equal(folded(), true, 'Birthdays hidden');
  // Drawn again with the option on: marked before the column is judged.
  doc.querySelector('.birthdays').remove();
  doc.querySelector('.inner').insertAdjacentHTML('beforeend', BIRTHDAYS);
  await tick(30);
  assert.equal(folded(), true, 'Birthdays coming in with its option on');

  // Facebook draws the feed again.
  doc.querySelector('[role="main"]').innerHTML = FEED(POST(4) + POST(5));
  await tick(30);
  assert.ok(wide().length === 7 && wide().every((block) => block.isConnected), 'the new blocks, none of the old');

  type = 'groups';
  for (const listener of routeListeners) listener();
  await tick(30);
  assert.equal(wide().length + doc.querySelectorAll(`[${FOLDED_MARK}], [${BIRTHDAYS_MARK}]`).length, 0, 'left Home');

  type = 'home';
  for (const listener of routeListeners) listener();
  await tick(30);
  assert.equal(wide().length, 7, 'back on Home');
  on = false;
  for (const listener of settingsListeners) listener();
  await tick(30);
  assert.equal(wide().length + doc.querySelectorAll(`[${FOLDED_MARK}], [${BIRTHDAYS_MARK}]`).length, 0, 'switched off');
  doc.body.insertAdjacentHTML('beforeend', '<div></div>');
  await tick(30);
  assert.equal(wide().length, 0, 'stays off');
});

test('the switch starts off, sits in Appearance with a width and a Birthdays option', () => {
  assert.ok(features.includes(widerFeed));
  assert.equal(widerFeed.default, false);
  assert.equal(widerFeed.section, 'appearance');
  assert.deepEqual(widerFeed.options.map(({ key, default: start }) => [key, start]), [['width', '900'], ['birthdays', false]]);
  assert.deepEqual(widerFeed.options[0].choices.map(({ value }) => value), ['800', '900', '1000']);
});
