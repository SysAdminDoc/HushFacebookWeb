// Show progress while posts load, against the end of a feed as it was live on 2026-11-04:
// Facebook's gray loading cards (role=status, data-visualcompletion=loading-state) inside a
// role=article with no links, below the posts in role=main. The network and the hider are
// stand-ins that hand over what the real ones would.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import showLoadProgress, { NOTE, emptiedEdges, feedCard, noteText } from '../src/features/feed/load-progress.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const CARD = (id) => `<div role="article"><div id="${id}" aria-label="Loading..." role="status" data-visualcompletion="loading-state"><div></div></div></div>`;
const VIDEO = '<div aria-posinset="1"><a href="/someone">Someone</a><div id="video" role="status" data-visualcompletion="loading-state"></div></div>';
const FEED = `<div role="main"><div class="feed">${VIDEO}<div>${CARD('first')}${CARD('second')}</div></div></div>`;
const HOME = { type: 'home', href: 'https://www.facebook.com/' };
const MARKETPLACE = { type: 'marketplace', href: 'https://www.facebook.com/marketplace/' };

function setup({ on = true } = {}) {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  const doc = win.document;
  doc.body.innerHTML = FEED;
  const state = { on, route: HOME, hidden: 0 };
  const rules = [];
  const listeners = { hider: new Set(), router: new Set(), settings: new Set() };
  const tell = (set) => { for (const listener of set) listener(); };
  const hider = {
    hiddenPosts: () => state.hidden,
    subscribe: (listener) => listeners.hider.add(listener),
  };
  showLoadProgress.setup({
    win, doc, hider,
    net: { transformResponses: (rule) => rules.push(rule) },
    router: { current: () => state.route, subscribe: (listener) => listeners.router.add(listener) },
    settings: { subscribe: (listener) => listeners.settings.add(listener) },
    enabled: () => state.on,
  });
  const [rule] = rules;
  const answer = (data, ctx = { transport: 'xhr', friendlyName: 'CometNewsFeedPaginationQuery' }) => {
    if (rule.enabled() && rule.match(ctx)) rule.transform(data, ctx);
  };
  const settle = () => win.happyDOM.waitUntilComplete();
  return {
    doc, state, rule, answer, settle,
    note: (id = 'first') => doc.getElementById(id).getAttribute(NOTE),
    hide(count) {
      state.hidden += count;
      tell(listeners.hider);
    },
    go(route) {
      state.route = route;
      tell(listeners.router);
    },
    toggle(on) {
      state.on = on;
      tell(listeners.settings);
    },
  };
}

// A page of feed edges, the ones a rule emptied keeping only their cursor and deduplication_key,
// each a post not sent before unless its keys are given.
let serial = 0;
const page = (kept, emptied, keys = Array.from({ length: emptied }, () => String(++serial))) => ({
  data: { viewer: { news_feed: { edges: [
    ...Array.from({ length: kept }, (_, i) => ({ cursor: `k${i}`, deduplication_key: `k${++serial}`, node: { __typename: 'Story', __isFeedUnit: 'Story' } })),
    ...keys.map((key, i) => ({ cursor: `e${i}`, category: 'ORGANIC', deduplication_key: key })),
  ] } } },
});

test('lists the edges a rule emptied by key, not the ones kept or the comments inside a story', () => {
  assert.deepEqual(emptiedEdges(page(3, 2, ['-7875591307351691376', '42'])), ['-7875591307351691376', '42']);
  const story = { cursor: 'a', node: { __typename: 'Story', feedback: { comments: { edges: [{ cursor: 'c1' }, { cursor: 'c2', node: null }] } } } };
  assert.deepEqual(emptiedEdges({ data: { viewer: { news_feed: { edges: [story] } } } }), []);
  // A streamed edge comes as a document of its own, and one without a key is listed as null.
  assert.deepEqual(emptiedEdges({ label: 'x', path: ['viewer', 'news_feed', 'edges', 4], data: { cursor: 'd' } }), [null]);
  assert.deepEqual(emptiedEdges({ data: { viewer: { news_feed: { page_info: { end_cursor: 'z', has_next_page: true } } } } }), []);
});

test("finds the feed's first loading card, not one inside a post", () => {
  const { doc } = setup();
  // A post Facebook is drawing again after its own X: the same card, and no links left.
  doc.querySelector('.feed').insertAdjacentHTML('afterbegin', `<div aria-posinset="2">${CARD('redrawn')}</div>`);
  assert.equal(feedCard(doc)?.id, 'first');
  doc.getElementById('first').parentElement.remove();
  assert.equal(feedCard(doc)?.id, 'second');
  doc.getElementById('second').parentElement.remove();
  assert.ok(feedCard(doc) === null, "a post's own loader isn't the feed's");
});

test('a post Facebook sends again counts once', async () => {
  const { answer, note, settle } = setup();
  answer(page(1, 2, ['ad', 'friend']));
  answer(page(2, 2, ['ad', 'group']));
  // A later answer with only posts already counted.
  answer(page(0, 2, ['friend', 'group']));
  answer(page(0, 2, [null, null]));
  await settle();
  assert.equal(note(), 'Hid 5 posts so far. Getting more from Facebook', 'three posts with keys and two without');
});

test('the first card says how many posts were hidden, from the data and on the page', async () => {
  const { answer, hide, note, settle } = setup();
  await settle();
  assert.equal(note(), null, 'nothing hidden, nothing to say');
  answer(page(3, 2));
  hide(1);
  await settle();
  assert.equal(note(), 'Hid 3 posts so far. Getting more from Facebook');
  assert.equal(note('second'), null, 'only the first card');
  answer(page(0, 5), { transport: 'xhr', friendlyName: 'GroupsCometFeedRegularStoriesPaginationQuery' });
  await settle();
  assert.equal(note(), 'Hid 8 posts so far. Getting more from Facebook');
  assert.equal(noteText(1), 'Hid 1 post so far. Getting more from Facebook');
});

test("only feed answers count, and Home's first posts inside the page do", async () => {
  const { answer, note, settle } = setup();
  answer(page(0, 4), { transport: 'xhr', friendlyName: 'CometSearchResultsPaginationQuery' });
  await settle();
  assert.equal(note(), null);
  answer(page(1, 2), { transport: 'json-parse' });
  await settle();
  assert.equal(note(), 'Hid 2 posts so far. Getting more from Facebook');
});

test('switched off the note comes off, and back on it returns', async () => {
  const { answer, note, settle, toggle } = setup();
  answer(page(0, 2));
  await settle();
  assert.equal(note(), 'Hid 2 posts so far. Getting more from Facebook');
  toggle(false);
  await settle();
  assert.equal(note(), null);
  answer(page(0, 3));
  toggle(true);
  await settle();
  assert.equal(note(), 'Hid 2 posts so far. Getting more from Facebook', 'answers while off are not counted');
});

test('a page that is not a feed gets no note, and a feed opened again counts from zero', async () => {
  const { answer, go, hide, note, settle } = setup();
  hide(4);
  await settle();
  assert.equal(note(), 'Hid 4 posts so far. Getting more from Facebook');
  go(MARKETPLACE);
  await settle();
  assert.equal(note(), null);
  answer(page(0, 3));
  go(HOME);
  await settle();
  assert.equal(note(), null, 'hidden before this feed opened');
  hide(1);
  await settle();
  assert.equal(note(), 'Hid 1 post so far. Getting more from Facebook');
});

test('a card Facebook draws again gets the note, and the old one loses it', async () => {
  const { answer, doc, note, settle } = setup();
  answer(page(0, 2));
  await settle();
  const old = doc.getElementById('first');
  old.parentElement.insertAdjacentHTML('beforebegin', CARD('fresh'));
  old.parentElement.remove();
  await settle();
  assert.equal(note('fresh'), 'Hid 2 posts so far. Getting more from Facebook');
  assert.equal(old.getAttribute(NOTE), null);
});
