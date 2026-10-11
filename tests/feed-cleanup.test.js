// The page checks of Hide suggested posts and Hide reel rows, against posts shaped like the
// live 2026-10-11 Home feed (structure from the harness's anatomy probe).

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { createDiagnostics } from '../src/core/diagnostics.js';
import { createHider, MARK } from '../src/core/dom/hide.js';
import { watchPostChecks } from '../src/core/dom/post-checks.js';
import { createPostTracker } from '../src/core/dom/posts.js';
import { parseRoute } from '../src/core/route.js';
import hideReelsInFeed, { reelRowOf } from '../src/features/feed/hide-reels-in-feed.js';
import hideSuggestedPosts, { suggestionButton } from '../src/features/feed/hide-suggested-posts.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(html, href = 'https://www.facebook.com/') {
  const win = new Window({ url: href });
  windows.push(win);
  win.document.body.innerHTML = `<div role="main"><div class="feed">${html}</div></div>`;
  return win;
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

// "Name · Follow": the button is a div[role=button] holding a span, inside the h4.
const post = (n, { name = 'Friend', button = '', shared = '' } = {}) => `
  <div class="row"><div aria-posinset="${n}">
    <h4><span><a href="/p${n}">${name}</a></span>${button ? ` · <span><div role="button" tabindex="0"><span>${button}</span></div></span>` : ''}</h4>
    <a href="/p${n}/posts/pfbid0P${n}">2h</a>
    <div data-ad-rendering-role="story_message">Text ${n}</div>${shared}
  </div></div>`;

test('the Follow or Join button after the author is a suggestion, a shared post\'s is not', () => {
  const win = page(post(1, { button: 'Follow' }) + post(2, { button: 'Join' }) + post(3) + post(4, { button: 'Following' })
    + post(5, { shared: `<div role="article"><h4><a href="/page">Page</a> · <div role="button">Follow</div></h4></div>` })
    + post(6, { shared: '<h3>A heading later on <div role="button">Follow</div></h3>' }));
  const results = [...win.document.querySelectorAll('[aria-posinset]')].map(suggestionButton);
  assert.deepEqual(results, ['Follow', 'Join', null, null, null, null]);
});

test('Hide suggested posts hides them on the page on Home, counts them and lets them back', async () => {
  const win = page(post(1, { button: 'Follow' }) + post(2) + post(3, { button: 'Join' }));
  const doc = win.document;
  const log = { info() {}, warn() {}, error() {} };
  const posts = createPostTracker({ doc, log });
  const hider = createHider({ doc, posts, log });
  const diagnostics = createDiagnostics();
  const subscribers = [];
  let on = true;
  hideSuggestedPosts.setup({
    net: null, router: { current: () => parseRoute(win.location.href) }, posts, hider, diagnostics,
    settings: { subscribe: (fn) => subscribers.push(fn) }, enabled: () => on,
  });
  const marked = () => [...doc.querySelectorAll('[aria-posinset]')].map((p) => hider.isHidden(p));
  assert.deepEqual(marked(), [true, false, true]);
  const rows = Object.fromEntries(diagnostics.rows().map(({ label, value }) => [label, value]));
  assert.equal(rows['Suggested posts hidden on the page'], 'Follow 1, Join 1');
  assert.match(rows['Suggested posts taken out of the data'], /^Off/);
  on = false;
  for (const fn of subscribers) fn({});
  assert.deepEqual(marked(), [false, false, false]);
  on = true;
  for (const fn of subscribers) fn({});
  assert.deepEqual(marked(), [true, false, true]);
  posts.stop();
  await tick();
});

test('Hide suggested posts leaves a Page, a group or search alone', () => {
  for (const href of ['https://www.facebook.com/somepage', 'https://www.facebook.com/groups/123/', 'https://www.facebook.com/search/top/?q=x']) {
    const win = page(post(1, { button: 'Follow' }), href);
    const posts = createPostTracker({ doc: win.document });
    const hider = createHider({ doc: win.document, posts });
    hideSuggestedPosts.setup({
      net: null, router: { current: () => parseRoute(href) }, posts, hider, diagnostics: null,
      settings: { subscribe() {} }, enabled: () => true,
    });
    assert.equal(win.document.querySelector(`[${MARK}]`), null, href);
    posts.stop();
  }
});

test('in page mode the data rule is added, scoped to the feeds', () => {
  const rules = [];
  hideSuggestedPosts.setup({
    net: { transformResponses: (rule) => rules.push(rule) }, router: { current: () => parseRoute('https://www.facebook.com/') },
    posts: null, hider: null, diagnostics: createDiagnostics(), settings: { subscribe() {} }, enabled: () => true,
  });
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].markers.sort(), ['"CometFeedStoryFollowButtonStrategy"', '"GroupJoinForumAction"']);
});

test('watchPostChecks stops retrying once a check is done, and retries until then', () => {
  const win = page(post(1) + post(2));
  const [a, b] = win.document.querySelectorAll('[aria-posinset]');
  const listeners = {};
  const posts = { on: (type, fn) => { (listeners[type] ??= []).push(fn); return () => {}; }, current: () => [{ element: a }, { element: b }] };
  const queue = [];
  const cancelled = [];
  const calls = [];
  watchPostChecks({
    posts, enabled: () => true, schedule: (fn) => queue.push(fn), cancel: (id) => cancelled.push(id),
    check: (element) => { calls.push(element === a ? 'a' : 'b'); return element === a; },
  });
  listeners['post/add'][0]({ element: a });
  listeners['post/add'][0]({ element: b });
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(cancelled, [1, 2, 3], "a's retries are cancelled once it's done");
  for (const fn of queue.slice(3)) fn();
  assert.deepEqual(calls, ['a', 'b', 'b', 'b', 'b']);
});

const shelf = (ids, extra = '') => `<div class="row shelf"><div><h3>Reels and short videos</h3>${ids.map((id) => `<a href="/reel/${id}/?s=feed">reel</a>`).join('')}${extra}</div></div>`;

test('a row of reels between posts is a reel row, a reel inside a post is not', () => {
  const win = page(post(1) + shelf([11, 12, 13]) + post(2, { shared: '<a href="/reel/21/">a friend\'s reel</a><a href="/reel/22/">another</a>' }) + shelf([31, 31]) + post(3));
  const doc = win.document;
  const rows = [...doc.querySelectorAll('a[href*="/reel/"]')].map(reelRowOf);
  const shelves = doc.querySelectorAll('.shelf');
  assert.deepEqual(rows, [shelves[0], shelves[0], shelves[0], null, null, null, null]);
});

test('reels linked from a post with a comment under it are part of the post', () => {
  const text = '<div data-ad-rendering-role="story_message"><a href="/reel/41/">one</a> and <a href="/reel/42/">two</a></div>';
  const comment = '<div class="comments"><div role="article" aria-label="Comment by Sam"><a href="/sam">Sam</a> nice</div></div>';
  const html = `<div class="row"><div aria-posinset="1"><h4><a href="/p1">Friend</a></h4><div>${text}${comment}</div></div></div>${post(2)}`;
  const win = page(html);
  assert.deepEqual([...win.document.querySelectorAll('a[href*="/reel/"]')].map(reelRowOf), [null, null]);
});

test('the Stories tray, the right column and the sidebar are never reel rows', () => {
  const html = `<div class="column">
    <div class="tray"><div role="region" data-focus-target="stories_tray"><a href="/reel/1/">r</a><a href="/reel/2/">r</a></div></div>
    <div class="feed">${post(1)}${post(2)}</div></div>
    <div role="navigation"><a href="/reel/?s=tab">Reels</a></div>
    <div role="complementary"><a href="/reel/3/">r</a><a href="/reel/4/">r</a></div>`;
  const win = page(html);
  assert.deepEqual([...win.document.querySelectorAll('a[href*="/reel/"]')].map(reelRowOf), [null, null, null, null, null]);
});

test('Hide reel rows hides rows on Home as they arrive, and brings them back when switched off', async () => {
  const win = page(post(1) + post(2));
  const doc = win.document;
  const hider = createHider({ doc });
  const subscribers = [];
  let on = true;
  hideReelsInFeed.setup({
    doc, win, router: { current: () => parseRoute(win.location.href), subscribe() {} }, hider, diagnostics: createDiagnostics(),
    settings: { subscribe: (fn) => subscribers.push(fn) }, enabled: () => on,
  });
  doc.querySelector('.feed').insertAdjacentHTML('beforeend', shelf([41, 42]) + post(3));
  await tick(400);
  const row = doc.querySelector('.shelf');
  assert.equal(hider.isHidden(row), true);
  assert.equal(hider.isHidden(doc.querySelector('[aria-posinset="3"]').parentElement), false);
  on = false;
  for (const fn of subscribers) fn({});
  assert.equal(hider.isHidden(row), false);
});
