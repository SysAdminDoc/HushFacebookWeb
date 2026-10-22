// The page checks of Hide suggested posts and Hide reel rows, against posts shaped like the
// live 2026-10-11 Home feed, plus the data check against a captured reel-row response.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { createDiagnostics } from '../src/core/diagnostics.js';
import { createHider, MARK } from '../src/core/dom/hide.js';
import { watchPostChecks } from '../src/core/dom/post-checks.js';
import { createPostTracker } from '../src/core/dom/posts.js';
import { installNetworkHooks } from '../src/core/net/hooks.js';
import { transformDocumentLine } from '../src/core/net/payload.js';
import { parseRoute } from '../src/core/route.js';
import hideReelsInFeed, { reelRowOf } from '../src/features/feed/hide-reels-in-feed.js';
import hideSuggestedPosts, { headingGroups, suggestionButton } from '../src/features/feed/hide-suggested-posts.js';
import { categoryHash } from '../src/features/feed/feed-category.js';
import { fixtureLines, parseLine } from './helpers/fixtures.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(html, href = 'https://www.facebook.com/') {
  const win = testWindow(href);
  windows.push(win);
  win.document.body.innerHTML = `<div role="main"><div class="feed">${html}</div></div>`;
  return win;
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

// "Name · Follow": the button is a div[role=button] holding a span, inside the h4.
const post = (n, { name = 'Friend', button = '', shared = '', link = `/p${n}` } = {}) => `
  <div class="row"><div aria-posinset="${n}">
    <h4><span><a href="${link}">${name}</a></span>${button ? ` · <span><div role="button" tabindex="0"><span>${button}</span></div></span>` : ''}</h4>
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
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0].markers.sort(), [
    '"CometFeedStoryFollowButtonStrategy"', '"ENGAGEMENT"', '"ENGAGEMENT_QP"', '"GroupJoinForumAction"', '"GroupsYouShouldJoinFeedUnit"',
    '"PaginatedPeopleYouMayKnowFeedUnit"', '"cat_sensitive":{"enc":"',
  ]);
  assert.equal(rules[1].observe, true, 'the groups rule only reads');
  assert.deepEqual(rules[1].markers, ['"GroupJoinForumAction"']);
});

// A story from a group with a Join action in its title, Facebook's category hashed from its
// post id as on Home in 2026-10, and the group named by id in the action and by address in `to`.
const groupStory = (postId, group, category) => ({
  cat_sensitive: { enc: categoryHash(postId, category), cat: null },
  cursor: `c-${postId}`,
  node: {
    __typename: 'Story', id: `s-${postId}`, post_id: postId,
    to: { __typename: 'Group', id: group, url: `https://www.facebook.com/groups/${group}/` },
    comet_sections: { context_layout: { story: { comet_sections: { title: {
      __typename: 'CometFeedStoryCommunityAttributionTitleStrategy',
      if_viewer_can_join_group: { join_action: { __typename: 'GroupJoinForumAction', group: { id: group } } },
    } } } } },
  },
});

test("the groups a post's heading links to", () => {
  const win = page(post(1, { button: 'Join', link: '/groups/90210777/?__cft__[0]=x' }) + post(2, { link: '/groups/Bakers/' }) + post(3)
    + post(4, { shared: '<div role="article"><h4><a href="/groups/31337555/">Shared</a></h4></div>' }));
  assert.deepEqual([...win.document.querySelectorAll('[aria-posinset]')].map(headingGroups), [['90210777'], ['bakers'], [], []]);
});

test('a Join post from a group Facebook files as ORGANIC stays on the page, other Join posts still go', async () => {
  const win = page('');
  const doc = win.document;
  const posts = createPostTracker({ doc });
  const hider = createHider({ doc, posts });
  const diagnostics = createDiagnostics();
  const rules = [];
  hideSuggestedPosts.setup({
    net: { transformResponses: (rule) => rules.push(rule) }, router: { current: () => parseRoute(win.location.href) }, posts, hider, diagnostics,
    settings: { subscribe() {} }, enabled: () => true,
  });
  const line = JSON.stringify({ data: { viewer: { news_feed: { edges: [groupStory('501', '90210777', 'ORGANIC'), groupStory('502', '31337555', 'ENGAGEMENT')] } } } });
  const out = JSON.parse(transformDocumentLine(line, rules, { transport: 'xhr', path: '/api/graphql/', friendlyName: 'CometNewsFeedPaginationQuery' }));
  assert.deepEqual(out.data.viewer.news_feed.edges.map((edge) => edge.node?.post_id ?? null), ['501', null], 'the data keeps the ORGANIC one');
  doc.querySelector('.feed').innerHTML = post(1, { button: 'Join', link: '/groups/90210777/?__cft__[0]=x' })
    + post(2, { button: 'Join', link: '/groups/31337555/?__cft__[0]=y' }) + post(3, { button: 'Follow' });
  await tick(20);
  assert.deepEqual([...doc.querySelectorAll('[aria-posinset]')].map((p) => hider.isHidden(p)), [false, true, true]);
  const rows = Object.fromEntries(diagnostics.rows().map(({ label, value }) => [label, value]));
  assert.equal(rows['Posts from your groups kept despite a Join button'], '1 in the data, 1 on the page');
  assert.equal(rows['Suggested posts hidden on the page'], 'Join 1, Follow 1');
  assert.doesNotMatch(JSON.stringify(diagnostics.rows()), /90210777|31337555/, 'the groups stay out of Diagnostics');
  posts.stop();
  await tick();
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

// The row each reel link resolves to, by its aria-posinset or 'row' for a shelf. A failed
// deepEqual on elements tries to print all of happy-dom and runs out of memory.
const rowsOf = (root) => [...root.querySelectorAll('a[href*="/reel/"]')].map((a) => {
  const row = reelRowOf(a);
  return row ? row.getAttribute('aria-posinset') ?? 'row' : null;
});

test('a row of reels between posts is a reel row, a reel inside a post is not', () => {
  const win = page(post(1) + shelf([11, 12, 13]) + post(2, { shared: '<a href="/reel/21/">a friend\'s reel</a><a href="/reel/22/">another</a>' }) + shelf([31, 31]) + post(3));
  const shelves = win.document.querySelectorAll('.shelf');
  assert.ok([...shelves[0].querySelectorAll('a')].every((a) => reelRowOf(a) === shelves[0]));
  assert.deepEqual(rowsOf(win.document), ['row', 'row', 'row', null, null, null, null]);
});

test('reels linked from a post with a comment under it are part of the post', () => {
  const text = '<div data-ad-rendering-role="story_message"><a href="/reel/41/">one</a> and <a href="/reel/42/">two</a></div>';
  const comment = '<div class="comments"><div role="article" aria-label="Comment by Sam"><a href="/sam">Sam</a> nice</div></div>';
  const html = `<div class="row"><div aria-posinset="1"><h4><a href="/p1">Friend</a></h4><div>${text}${comment}</div></div></div>${post(2)}`;
  const win = page(html);
  assert.deepEqual(rowsOf(win.document), [null, null]);
});

test('the Stories tray, the right column and the sidebar are never reel rows', () => {
  const html = `<div class="column">
    <div class="tray"><div role="region" data-focus-target="stories_tray"><a href="/reel/1/">r</a><a href="/reel/2/">r</a></div></div>
    <div class="feed">${post(1)}${post(2)}</div></div>
    <div role="navigation"><a href="/reel/?s=tab">Reels</a></div>
    <div role="complementary"><a href="/reel/3/">r</a><a href="/reel/4/">r</a></div>`;
  const win = page(html);
  assert.deepEqual(rowsOf(win.document), [null, null, null, null, null]);
});

// Home's Reels row as drawn on 2026-10-22 (test account, content mode), trimmed: a feed unit of
// its own with a decoy block, an actions button, a Reels heading and a grid of reel cards, each
// a link holding a Menu button.
const reelCard = (id) => `<div data-type="hscroll-child" role="gridcell" tabindex="0"><a aria-label="Reel by Someone" href="/reel/${id}/?s=fb&amp;__cft__[0]=x" role="link" tabindex="0"><div><img></div><div><span><div aria-expanded="false" aria-haspopup="dialog" aria-label="Menu" role="button" tabindex="0"><svg aria-hidden="true"><path></path></svg></div></span></div></a></div>`;
const reelUnit = (n, ids) => `<div class="row"><div aria-posinset="${n}"><div><div data-virtualized="false">
  <div aria-hidden="true" data-0="0" data-1="1"><blockquote>Facebook</blockquote><div aria-hidden="true" role="button" tabindex="-1"></div></div>
  <h3><span>Reels</span></h3><div aria-label="Actions for this post" aria-haspopup="menu" role="button" tabindex="0"><svg></svg></div>
  <div aria-hidden="true"><div aria-disabled="true" aria-label="Previous items" role="button" tabindex="-1"><svg aria-hidden="true"><path></path></svg></div></div>
  <div><div aria-label="Reels" role="grid"><div role="row">${ids.map(reelCard).join('')}</div></div></div>
  <div aria-label="Next items" role="button" tabindex="0"><svg></svg></div>
</div></div></div></div>`;
const friendsReel = (n) => post(n, { shared: `<a href="/reel/9${n}/?s=fb" aria-label="Open reel in Reels Viewer">reel</a><a href="/somepage">Page</a>` });

test("Home's Reels row is a feed unit of its own, a friend's reel or two reels in a post are not", () => {
  const win = page(post(1) + reelUnit(2, [51, 52, 53, 54, 55, 56]) + friendsReel(3)
    + post(4, { shared: '<a href="/reel/61/">one</a><a href="/reel/62/">two</a>' }) + reelUnit(5, [71, 71]) + reelUnit(6, [81])
    + reelUnit(7, [91, 92]).replace('<h3>', '<h3><a href="/reel/?s=tab">See all</a><a href="https://www.facebook.com/reels/">Reels</a>'));
  assert.deepEqual(rowsOf(win.document), ['2', '2', '2', '2', '2', '2', null, null, null, null, null, null, '7', '7', '7']);
});

test('a Reels unit inside a post, with a link that is not a reel, or an article of reels is not the row', () => {
  const win = page(post(1, { shared: reelUnit(9, [11, 12]) }) + reelUnit(2, [21, 22]).replace('<h3>', '<h3><a href="/watch/?ref=tab">Watch</a>')
    + reelUnit(3, [23, 24]).replace('<h3>', '<h3><a href="#">Soon</a>')
    + '<div role="article"><a href="/reel/31/">one</a><a href="/reel/32/">two</a></div>');
  assert.deepEqual(rowsOf(win.document), [null, null, null, null, null, null, null, null]);
});

test('Hide reel rows hides the Reels unit on Home as it arrives, keeps the posts and brings it back', async () => {
  const win = page(post(1));
  const doc = win.document;
  const hider = createHider({ doc });
  const subscribers = [];
  let on = true;
  hideReelsInFeed.setup({
    doc, win, router: { current: () => parseRoute(win.location.href), subscribe() {} }, hider, diagnostics: createDiagnostics(),
    settings: { subscribe: (fn) => subscribers.push(fn) }, enabled: () => on,
  });
  doc.querySelector('.feed').insertAdjacentHTML('beforeend', reelUnit(2, [41, 42, 43]) + friendsReel(3));
  await tick(400);
  const shown = () => [1, 2, 3].map((n) => hider.isHidden(doc.querySelector(`[aria-posinset="${n}"]`)));
  assert.deepEqual(shown(), [false, true, false]);
  on = false;
  for (const fn of subscribers) fn({});
  assert.deepEqual(shown(), [false, false, false]);
});

test('a hidden Reels unit Facebook reuses for a post comes back, one that gains a reel stays hidden', async () => {
  const win = page(post(1) + reelUnit(2, [41, 42]) + reelUnit(3, [43, 44]));
  const doc = win.document;
  const hider = createHider({ doc });
  hideReelsInFeed.setup({
    doc, win, router: { current: () => parseRoute(win.location.href), subscribe() {} }, hider, diagnostics: createDiagnostics(),
    settings: { subscribe() {} }, enabled: () => true,
  });
  await tick(400);
  const unit = (n) => doc.querySelector(`[aria-posinset="${n}"]`);
  const hidden = () => [1, 2, 3].map((n) => hider.isHidden(unit(n)));
  assert.deepEqual(hidden(), [false, true, true]);
  // The mark stays on the unit's first child, so only the sweep can take it off.
  unit(2).querySelector('[data-virtualized]').innerHTML = '<h4><a href="/p9">Friend</a></h4><a href="/p9/posts/pfbid0P9">2h</a><div>Text 9</div>';
  await tick(400);
  assert.deepEqual(hidden(), [false, false, true]);
  unit(3).querySelector('[role="row"]').insertAdjacentHTML('beforeend', reelCard(45));
  await tick(400);
  assert.deepEqual(hidden(), [false, false, true]);
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

function reelDataHook(enabled = () => true) {
  const win = { JSON: { parse: JSON.parse }, location: { href: 'https://www.facebook.com/' } };
  const net = installNetworkHooks({ win, log: { error() {}, warn() {}, info() {}, debug() {} } });
  const rules = [];
  const diagnostics = createDiagnostics();
  hideReelsInFeed.setup({
    net: { transformResponses: (rule) => { rules.push(rule); net.transformResponses(rule); } },
    router: { current: () => parseRoute(win.location.href) }, diagnostics, enabled,
  });
  return { win, rules, diagnostics };
}

test('the captured Home reel unit loses only its six showcase items before the page draws', async () => {
  // Inline Relay response from run12, 2026-10-11. The saved HTML has no row DOM.
  const [line] = await fixtureLines('reel-row.jsonl');
  const captured = parseLine(line);
  assert.equal(captured.data.node.__typename, 'ShowcaseFeedUnit');
  assert.equal(captured.data.node.showcase_story_type, 'SHOWCASE_SHORT_VIDEO');
  assert.equal(captured.data.node.showcase_item.length, 6);
  assert.ok(captured.data.node.showcase_item.every((item) => item.attachment.__typename === 'ShowcaseShortVideoAttachment'));
  const expected = structuredClone(captured);
  expected.data.node.showcase_item = [];
  const { win, diagnostics } = reelDataHook();
  const out = win.JSON.parse(line);
  assert.deepEqual(out, expected, 'all response fields outside showcase_item stay intact');
  assert.equal(diagnostics.decisions().filter((decision) => decision.rule === 'Reels').length, 1);
  assert.deepEqual(win.JSON.parse(JSON.stringify(out)), out, 'an already empty row stays empty');
  assert.equal(diagnostics.decisions().filter((decision) => decision.rule === 'Reels').length, 1);
});

test('the captured reel unit is filtered only in the feeds and while its switch is on', async () => {
  const [line] = await fixtureLines('reel-row.jsonl');
  const captured = parseLine(line);
  let on = true;
  const { win, rules } = reelDataHook(() => on);
  assert.equal(rules.length, 1, 'the data rule is registered without a DOM or hider');
  for (const [href, hidden] of [
    ['https://www.facebook.com/', true],
    ['https://www.facebook.com/groups/feed/', true],
    ['https://www.facebook.com/search/top/?q=reels', false],
    ['https://www.facebook.com/somepage/', false],
  ]) {
    win.location.href = href;
    const expected = structuredClone(captured);
    if (hidden) expected.data.node.showcase_item = [];
    assert.deepEqual(win.JSON.parse(line), expected, href);
  }
  for (const [friendlyName, hidden] of [
    ['CometNewsFeedPaginationQuery', true],
    ['GroupsCometCrossGroupFeedPaginationQuery', true],
    ['ProfileCometTimelineFeedRefetchQuery', false],
    ['SearchCometResultsPaginatedResultsQuery', false],
  ]) {
    const expected = structuredClone(captured);
    if (hidden) expected.data.node.showcase_item = [];
    assert.deepEqual(parseLine(transformDocumentLine(line, rules, { transport: 'fetch', path: '/api/graphql/', friendlyName })), expected, friendlyName);
  }
  win.location.href = 'https://www.facebook.com/';
  on = false;
  assert.deepEqual(win.JSON.parse(line), captured, 'a disabled switch leaves the real unit intact');
});

test('friends reel posts and other Showcase units stay intact in the data', async () => {
  const [line] = await fixtureLines('reel-row.jsonl');
  const captured = parseLine(line).data.node;
  const friend = {
    __typename: 'Story', __isFeedUnit: 'Story', id: 'friend-reel',
    attachments: [structuredClone(captured.showcase_item[0].attachment)],
  };
  const otherShowcase = { ...structuredClone(captured), showcase_story_type: 'OTHER' };
  const wrongType = { ...structuredClone(captured), __typename: 'Story', __isFeedUnit: 'Story' };
  const doc = { data: { edges: [{ cursor: 'friend', node: friend }, { cursor: 'other', node: otherShowcase }, { cursor: 'wrong', node: wrongType }] } };
  const { win } = reelDataHook();
  assert.deepEqual(win.JSON.parse(JSON.stringify(doc)), doc);
});
