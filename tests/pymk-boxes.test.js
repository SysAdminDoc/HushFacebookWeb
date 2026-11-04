// People you may know on the Friends page and profiles, hidden on the page. pymk-pages.jsonl is
// the three blocks as drawn on 2026-11-03 (signed in, script off), scrubbed: /friends main, a
// profile from its header to its tabs, and the /friends/suggestions list under its heading.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { fixtureLines } from './helpers/fixtures.js';
import { parseRoute } from '../src/core/route.js';
import { renderFeatureCss } from '../src/core/style.js';
import hideSuggestedPosts from '../src/features/feed/hide-suggested-posts.js';
import { PYMK_CSS, PYMK_MARK, pymkBoxes, seeAllLink, watchPymk } from '../src/features/feed/pymk-boxes.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const captured = Object.fromEntries((await fixtureLines('pymk-pages.jsonl')).map((line) => {
  const { page, html } = JSON.parse(line);
  return [page, html];
}));

// The Friends page's own menu, with its own link to Suggestions.
const MENU = `<div role="navigation"><div><h1>Friends</h1><a role="link" href="/friends/">Home</a>
  <a role="link" href="/friends/requests/">Friend requests</a><a role="link" href="/friends/suggestions/">Suggestions</a></div></div>`;

const PAGES = {
  friends: ['https://www.facebook.com/friends', () => `${MENU}${captured.friends}`],
  profile: ['https://www.facebook.com/profile.php?id=1', () => `<div role="main">${captured.profile}</div>`],
  suggestions: ['https://www.facebook.com/friends/suggestions', () => `<div role="navigation"><div><div class="top"><h1>Suggestions</h1>
    <a role="link" href="/friends/">Back</a></div>${captured.suggestions}</div></div><div role="main"><span>Pick a name</span></div>`],
};

function page(name, html = PAGES[name][1]()) {
  const [url] = PAGES[name];
  const win = testWindow(url);
  windows.push(win);
  win.document.body.innerHTML = html;
  win.document.documentElement.dataset.hfwRoute = parseRoute(url).type;
  return win;
}

const one = (doc, name) => {
  const boxes = pymkBoxes(doc, parseRoute(PAGES[name][0]).path);
  assert.equal(boxes.length, 1, `${name}: one block`);
  return boxes[0];
};
const cards = (root) => [...root.querySelectorAll('a[href]')].filter((a) => !seeAllLink(a));

test('each captured page gives one block, holding its heading and every card', () => {
  for (const name of Object.keys(PAGES)) {
    const doc = page(name).document;
    const box = one(doc, name);
    const heading = [...doc.querySelectorAll('h2')].find((h) => /^people you may know$/i.test(h.textContent.trim()));
    assert.ok(heading && box.contains(heading), `${name}: the heading goes`);
    const pageCards = cards(doc).filter((a) => !a.closest('[role="navigation"]') || name === 'suggestions');
    const inside = pageCards.filter((a) => box.contains(a)).length;
    assert.ok(inside >= 2, `${name}: cards inside`);
    // A profile's header has links of its own.
    if (name === 'friends') assert.equal(inside, pageCards.length, `${name}: every card on the page goes`);
  }
});

test('on /friends the block takes the loading placeholders, so Facebook never pages more cards in behind it, and the menu stays', () => {
  const doc = page('friends').document;
  const box = one(doc, 'friends');
  const loading = [...doc.querySelectorAll('[data-visualcompletion="loading-state"]')];
  assert.ok(loading.length > 0 && loading.every((el) => box.contains(el)), 'every placeholder is inside');
  assert.ok(!box.closest('[role="navigation"]') && !doc.querySelector('[role="navigation"]').contains(box), 'the menu, with its own Suggestions link, stays');
  assert.ok(!box.matches('[role="main"]'), 'the page itself stays');
});

test("a profile's header, its search box and its tabs stay", () => {
  const doc = page('profile').document;
  const box = one(doc, 'profile');
  assert.ok(!box.querySelector('input'), 'the header stays');
  assert.ok(!box.querySelector('[role="tablist"]') && doc.querySelector('[role="tablist"]'), 'the tabs stay');
});

test("/friends/suggestions keeps its own heading and Back link", () => {
  const doc = page('suggestions').document;
  const box = one(doc, 'suggestions');
  assert.ok(!box.contains(doc.querySelector('h1')) && !box.contains(doc.querySelector('.top a')), 'Suggestions and Back stay');
  assert.ok(!pymkBoxes(doc, '/friends').length, 'only on /friends/suggestions');
});

test('the words on the page play no part, so another language finds the same blocks', () => {
  for (const name of Object.keys(PAGES)) {
    const html = PAGES[name][1]().replace(/People you may know|People You May Know/g, 'Personas que quizá conozcas').replace(/See all|Add friend|Remove/g, 'Ver');
    const doc = page(name, html).document;
    const box = one(doc, name);
    assert.ok(box.querySelector('h2') && cards(box).length >= 2, `${name}: same block`);
  }
});

test('a Friend requests section beside the grid stays, and the block shrinks away from it when it arrives later', async () => {
  const win = page('friends');
  const doc = win.document;
  const route = () => parseRoute(win.location.href);
  const watch = watchPymk({ doc, route, active: () => true });
  await tick();
  assert.ok(doc.querySelector(`[role="main"] > [${PYMK_MARK}]`), 'with no requests, everything under the page goes');

  // The grid's own section: the heading, the cards and the placeholders.
  const heading = doc.querySelector('[role="main"] h2');
  let section = heading;
  while (!section.querySelector('[data-visualcompletion="loading-state"]')) section = section.parentElement;
  section.insertAdjacentHTML('beforebegin', `<div class="requests"><div><h2>Friend requests</h2><a role="link" href="/friends/requests/">See all</a></div>
    <div role="list"><div role="listitem"><a role="link" href="/friends/requests/?profile_id=2">Someone</a>
    <div role="button" aria-label="Confirm">Confirm</div><div role="button" aria-label="Delete">Delete</div></div></div></div>`);
  await tick();
  const requests = doc.querySelector('.requests');
  assert.ok(!requests.closest(`[${PYMK_MARK}]`) && !requests.querySelector(`[${PYMK_MARK}]`), 'Friend requests and its Confirm and Delete stay');
  const marked = doc.querySelector(`[${PYMK_MARK}]`);
  assert.ok(marked?.contains(heading) && marked.contains(doc.querySelector('[data-visualcompletion="loading-state"]')), 'the grid still goes');
  assert.equal(doc.querySelectorAll(`[${PYMK_MARK}]`).length, 1);
  watch.stop();
});

test("a See all link in a post, Home's own row or anywhere off the Friends pages and profiles marks nothing", async () => {
  const post = `<div role="main"><div role="article"><div><h2>People you may know</h2><a href="/friends/suggestions/">See all</a></div>
    <div><a href="/profile.php?id=3">A</a><a href="/profile.php?id=4">B</a></div></div></div>`;
  const doc = page('profile', post).document;
  assert.ok(!pymkBoxes(doc, '/profile.php').length, 'inside a post');

  const home = testWindow('https://www.facebook.com/');
  windows.push(home);
  home.document.body.innerHTML = PAGES.profile[1]();
  const watch = watchPymk({ doc: home.document, route: () => parseRoute(home.location.href), active: () => true });
  await tick();
  assert.ok(!home.document.querySelector(`[${PYMK_MARK}]`), 'Home is left to the data rule');
  watch.stop();
});

test('the option is off to start, its CSS only counts on the Friends pages and profiles, and switching it on marks the block', async () => {
  const option = hideSuggestedPosts.options.find((o) => o.key === 'friendsPages');
  assert.equal(option?.default, false);
  const values = { hideSuggestedPosts: true, 'hideSuggestedPosts.friendsPages': false };
  const listeners = [];
  const settings = {
    get: (key) => values[key],
    enabled: (id) => values[id] === true,
    subscribe: (fn) => listeners.push(fn),
  };
  assert.ok(!renderFeatureCss([hideSuggestedPosts], settings).includes(PYMK_MARK), 'no rule while the option is off');

  const win = page('friends');
  const doc = win.document;
  const router = { current: () => parseRoute(win.location.href) };
  hideSuggestedPosts.setup({ doc, router, settings, enabled: () => settings.enabled('hideSuggestedPosts'), option: (key) => values[`hideSuggestedPosts.${key}`] });
  await tick();
  assert.ok(!doc.querySelector(`[${PYMK_MARK}]`), 'nothing marked while off');

  values['hideSuggestedPosts.friendsPages'] = true;
  for (const fn of listeners) fn();
  await tick();
  assert.ok(doc.querySelector(`[role="main"] > [${PYMK_MARK}]`), 'marked once on');
  const css = renderFeatureCss([hideSuggestedPosts], settings);
  const style = doc.createElement('style');
  style.textContent = css;
  doc.head.append(style);
  const marked = doc.querySelector(`[${PYMK_MARK}]`);
  assert.equal(win.getComputedStyle(marked).display, 'none', 'hidden on /friends');
  // happy-dom keeps the computed style and matches() it worked out for an element when only <html>
  // changes, so the rule's own selector goes through querySelector.
  const rule = PYMK_CSS.slice(0, PYMK_CSS.indexOf('{'));
  assert.ok(css.includes(PYMK_CSS) && doc.querySelector(rule), 'the rule is in the CSS and fits on /friends');
  doc.documentElement.dataset.hfwRoute = 'profile';
  assert.ok(doc.querySelector(rule), 'and on a profile');
  doc.documentElement.dataset.hfwRoute = 'home';
  assert.ok(!doc.querySelector(rule), 'a mark left behind elsewhere hides nothing');
});
