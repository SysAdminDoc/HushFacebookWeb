// Hide posts by words in the Reels viewer: the reel fields read from Facebook's data, the
// viewer's card buttons, and the skipper. The documents are built in the shape the viewer got
// live on 2026-11-04 (reel-skips.js), with made-up words and ids.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { createDiagnostics } from '../src/core/diagnostics.js';
import { parseRoute } from '../src/core/route.js';
import { transformDocumentLine } from '../src/core/net/payload.js';
import hidePostsByWords from '../src/features/feed/filters.js';
import { cardButton, createReelSkipper, eachReel, reelFields, reelIdOf } from '../src/features/feed/reel-skips.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const FOOTER = 'FBUnifiedVideoMediaContentContainer_reels$defer$FBUnifiedVideoMediaFooter_footer_eAnYh';
const STREAM = 'FBUnifiedVideoContainer_reels$stream$FBUnifiedVideoContainer_video_feed_unit_feed';
const LIKES = 'FBUnifiedVideoMediaTransitionContainer_video$defer$FBUnifiedVideoFeedbackBar_feedback';

// A reel's edge as it streams in: no words, no one named.
const edge = (id, place = 1) => ({
  label: STREAM,
  path: ['viewer', 'video_feed_unit_feed', 'edges', place],
  data: { cursor: `c${id}`, node: { __typename: 'Story', id: `S:${id}`, attachments: [{ media: { __typename: 'Video', id } }] } },
});
// Its like bar: the same video, still no one named.
const likes = (id, place = 1) => ({
  label: LIKES,
  path: ['viewer', 'video_feed_unit_feed', 'edges', place, 'node'],
  data: { id: `S:${id}`, post_id: `p${id}`, attachments: [{ media: { __typename: 'Video', id } }], feedback: { id: `f${id}` } },
});
// Its footer: caption, who posted it, its sound and a link.
const footer = (id, { caption = null, author = 'Reel Maker', sound = null, link = null, place = 1 } = {}) => ({
  label: FOOTER,
  path: ['viewer', 'video_feed_unit_feed', 'edges', place, 'node'],
  data: {
    id: `S:${id}`,
    post_id: `p${id}`,
    actors: [{ __typename: 'User', id: `u${id}`, name: author }],
    message: caption === null ? null : { text: caption },
    attachments: [{
      media: { __typename: 'Video', id, owner: { name: author }, ...(sound ? { track_title: sound } : {}) },
      call_to_action_renderer: link ? { action_link: { url: link } } : null,
    }],
    music_attribution_metadata_renderer: sound ? { story: { attachments: [{ media: { __typename: 'Video', id, track_title: sound } }] } } : null,
    feedback: { id: `f${id}` },
  },
});
const line = (doc) => JSON.stringify(doc);

const REEL_CTX = { transport: 'xhr', path: '/api/graphql/', friendlyName: 'FBUnifiedVideoContainerQuery' };
const INLINE_CTX = { transport: 'json-parse', path: '' };
const FEED_CTX = { transport: 'xhr', path: '/api/graphql/', friendlyName: 'CometNewsFeedPaginationQuery' };

test('reel fields come from the footer: caption, sound, who posted it and its links, and no kinds', () => {
  const seen = [];
  const answer = { first: edge('111'), likes: likes('111'), footer: footer('111', { caption: 'Sourdough at dawn', author: 'Bread Club', sound: 'Morning Song', link: 'https://l.facebook.com/l.php?u=https%3A%2F%2Fshop.example%2Floaf' }) };
  eachReel(answer, (id, story) => seen.push([id, reelFields(story)]));
  assert.equal(seen.length, 1, 'the bare edge and the like bar name no one, so only the footer counts');
  const [id, fields] = seen[0];
  assert.equal(id, '111');
  assert.deepEqual(fields.text, ['Sourdough at dawn', 'Morning Song']);
  assert.deepEqual(fields.authors, ['Bread Club']);
  assert.deepEqual(fields.sites, ['shop.example']);
  assert.equal(fields.kinds.size, 0, 'every reel is a video, so no kind switch reaches reels');
  const quiet = [];
  eachReel(footer('222'), (reel, story) => quiet.push([reel, reelFields(story)]));
  assert.deepEqual(quiet[0][1].text, [], 'a reel with no caption or sound has no words');
  const notVideo = footer('333');
  notVideo.data.attachments[0].media.__typename = 'Photo';
  let found = 0;
  eachReel(notVideo, () => found++);
  assert.equal(found, 0, 'a story with no video is no reel');
});

test('the reel an address shows is the number after /reel/, and only there', () => {
  assert.equal(reelIdOf(parseRoute('https://www.facebook.com/reel/1234567')), '1234567');
  assert.equal(reelIdOf(parseRoute('https://www.facebook.com/reel/?s=tab')), null);
  assert.equal(reelIdOf(parseRoute('https://www.facebook.com/watch/?v=1234567')), null);
  assert.equal(reelIdOf(parseRoute('https://www.facebook.com/someone/videos/1234567')), null);
  assert.equal(reelIdOf(null), null);
});

// The viewer: the two card buttons two levels under main, as live.
function viewer({ first = false, extra = '' } = {}) {
  const win = testWindow('https://www.facebook.com/reel/?s=tab');
  windows.push(win);
  win.document.body.innerHTML = `<div role="main"><div><div>
    <div role="button" aria-label="Previous Card"${first ? ' aria-disabled="true"' : ''}></div>
    <div><video></video><div role="button" aria-label="Like"></div></div>
    <div role="button" aria-label="Next Card"></div>${extra}
  </div></div></div>`;
  return win;
}

test('card buttons: Previous is the first, Next the last, and an off or missing one is none', () => {
  const doc = viewer().document;
  assert.equal(cardButton(doc, false)?.getAttribute('aria-label'), 'Next Card');
  assert.equal(cardButton(doc, true)?.getAttribute('aria-label'), 'Previous Card');
  assert.equal(cardButton(viewer({ first: true }).document, true) === null, true, 'no Previous Card on the first reel');
  assert.equal(cardButton(viewer({ extra: '<div role="button" aria-label="More"></div>' }).document, false) === null, true, 'three buttons there is a viewer it does not know');
  const empty = testWindow('https://www.facebook.com/reel/1');
  windows.push(empty);
  assert.equal(cardButton(empty.document, false) === null, true);
});

// A router that moves when the test says so, and a viewer whose card buttons move it through
// reels in order, like Facebook's.
function reelViewer({ start, order, first = false }) {
  const win = viewer({ first });
  const doc = win.document;
  const listeners = new Set();
  let route = parseRoute(start);
  const go = (href) => {
    route = parseRoute(href);
    for (const fn of listeners) fn(route);
  };
  const router = { current: () => route, subscribe: (fn) => listeners.add(fn) };
  const clicks = [];
  const move = (step) => () => {
    const at = order.indexOf(reelIdOf(route));
    clicks.push(step > 0 ? 'next' : 'previous');
    const next = order[at + step];
    if (next) go(`https://www.facebook.com/reel/${next}`);
  };
  cardButton(doc, false).addEventListener('click', move(1));
  if (!first) cardButton(doc, true).addEventListener('click', move(-1));
  return { doc, router, go, clicks, at: () => reelIdOf(route) };
}

// Timers the test runs by hand.
function manualTimers() {
  const queue = [];
  return {
    setTimer: (fn) => queue.push(fn),
    run() {
      while (queue.length) queue.shift()();
    },
  };
}

test('from the Reels tab, a matching reel is skipped forward, even the first one', () => {
  const view = reelViewer({ start: 'https://www.facebook.com/reel/?s=tab', order: ['1', '2', '3', '4'] });
  const timers = manualTimers();
  const skipped = [];
  createReelSkipper({ doc: view.doc, router: view.router, setTimer: timers.setTimer, verdict: (id) => (id === '1' || id === '3' ? 'bread' : null), skipped: (id, reason) => skipped.push([id, reason]) });
  view.go('https://www.facebook.com/reel/1');
  timers.run();
  assert.equal(view.at(), '2');
  view.go('https://www.facebook.com/reel/3');
  timers.run();
  assert.equal(view.at(), '4');
  assert.deepEqual(skipped, [['1', 'bread'], ['3', 'bread']]);
  assert.deepEqual(view.clicks, ['next', 'next']);
});

test('the reel opened by its link always shows, and the ones after it can go', () => {
  const view = reelViewer({ start: 'https://www.facebook.com/reel/1', order: ['1', '2', '3'] });
  const timers = manualTimers();
  createReelSkipper({ doc: view.doc, router: view.router, setTimer: timers.setTimer, verdict: () => 'bread', skipped() {} });
  timers.run();
  assert.equal(view.at(), '1', 'opened by its link');
  view.go('https://www.facebook.com/reel/2');
  timers.run();
  assert.equal(view.at(), '3');
  // Back on the one it opened on, it still shows.
  view.go('https://www.facebook.com/reel/1');
  timers.run();
  assert.equal(view.at(), '1');
});

test('a reel opened from another page by its link is opened too, and leaving forgets the viewer', () => {
  const view = reelViewer({ start: 'https://www.facebook.com/', order: ['1', '2', '3'] });
  const timers = manualTimers();
  createReelSkipper({ doc: view.doc, router: view.router, setTimer: timers.setTimer, verdict: (id) => (id === '3' ? null : 'bread'), skipped() {} });
  view.go('https://www.facebook.com/reel/2');
  timers.run();
  assert.equal(view.at(), '2', 'opened from Home');
  view.go('https://www.facebook.com/');
  view.go('https://www.facebook.com/reel/1');
  timers.run();
  assert.equal(view.at(), '1', 'opened again by its link');
  view.go('https://www.facebook.com/reel/?s=tab');
  view.go('https://www.facebook.com/reel/1');
  timers.run();
  assert.equal(view.at(), '3', 'the Reels tab opens on no reel of yours, so 1 and 2 go');
});

test('going back to a skipped reel skips it backward, and the first reel with no Previous Card stays', () => {
  const view = reelViewer({ start: 'https://www.facebook.com/reel/?s=tab', order: ['1', '2', '3', '4'] });
  const timers = manualTimers();
  const hidden = new Set(['2']);
  createReelSkipper({ doc: view.doc, router: view.router, setTimer: timers.setTimer, verdict: (id) => (hidden.has(id) ? 'bread' : null), skipped() {} });
  for (const id of ['1', '2']) {
    view.go(`https://www.facebook.com/reel/${id}`);
    timers.run();
  }
  assert.equal(view.at(), '3');
  view.go('https://www.facebook.com/reel/2');
  timers.run();
  assert.equal(view.at(), '1', 'the user went back, so it goes on back');
  assert.deepEqual(view.clicks, ['next', 'previous']);

  const start = reelViewer({ start: 'https://www.facebook.com/reel/?s=tab', order: ['1', '2'], first: true });
  const more = manualTimers();
  createReelSkipper({ doc: start.doc, router: start.router, setTimer: more.setTimer, verdict: (id) => (id === '1' ? 'bread' : null), skipped() {} });
  start.go('https://www.facebook.com/reel/1');
  more.run();
  assert.equal(start.at(), '2');
  start.go('https://www.facebook.com/reel/1');
  more.run();
  assert.equal(start.at(), '1', 'nothing before it to go to');
});

test('after the limit of skips in a row the next match stays, and a reel that stays starts the count over', () => {
  const order = Array.from({ length: 12 }, (_, i) => String(i + 1));
  const view = reelViewer({ start: 'https://www.facebook.com/reel/?s=tab', order });
  const timers = manualTimers();
  const shown = new Set(['6']);
  createReelSkipper({ doc: view.doc, router: view.router, setTimer: timers.setTimer, limit: 3, verdict: (id) => (shown.has(id) ? null : 'bread'), skipped() {} });
  view.go('https://www.facebook.com/reel/1');
  timers.run();
  timers.run();
  timers.run();
  assert.equal(view.at(), '4', 'three skips, then the fourth match stays');
  assert.equal(view.clicks.length, 3);
  view.go('https://www.facebook.com/reel/5');
  timers.run();
  assert.equal(view.at(), '5', 'still at the limit');
  view.go('https://www.facebook.com/reel/6');
  timers.run();
  view.go('https://www.facebook.com/reel/7');
  timers.run();
  assert.equal(view.at(), '10', 'a reel stayed, so three more go before the next one stays');
  assert.equal(view.clicks.length, 6);
});

test('check() looks again at the reel on screen, for data that came in after it', () => {
  const view = reelViewer({ start: 'https://www.facebook.com/reel/?s=tab', order: ['1', '2'] });
  const timers = manualTimers();
  let known = false;
  const skipper = createReelSkipper({ doc: view.doc, router: view.router, setTimer: timers.setTimer, verdict: () => (known ? 'bread' : null), skipped() {} });
  view.go('https://www.facebook.com/reel/1');
  timers.run();
  assert.equal(view.at(), '1');
  known = true;
  skipper.check();
  timers.run();
  assert.equal(view.at(), '2');
});

// The feature, end to end: its net rules on the documents, the skipper on the viewer.
function setupReels({ words = 'bread', lists = {}, kinds = {}, reels = true, preview = false, start = 'https://www.facebook.com/reel/?s=tab', order = ['1', '2', '3'] } = {}) {
  const view = reelViewer({ start, order });
  const values = { words, reels, preview, ...lists, ...kinds };
  const rules = [];
  const diagnostics = createDiagnostics();
  hidePostsByWords.setup({
    doc: view.doc, net: { transformResponses: (rule) => rules.push(rule) }, router: view.router, posts: null, hider: null, diagnostics,
    log: { warn() {}, error() {}, info() {} },
    settings: { subscribe() {} }, enabled: () => true, option: (key) => values[key],
  });
  const row = () => diagnostics.rows().find(({ label }) => label === 'Reels skipped by your filters')?.value;
  const set = (key, value) => {
    values[key] = value;
  };
  return { ...view, rules, row, diagnostics, set };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 320));

test('with the reels option on, a reel whose data matches is skipped, and the data goes on as it came', async () => {
  const view = setupReels();
  const sent = [edge('1'), footer('1', { caption: 'Fresh bread today' }), edge('2', 2), footer('2', { caption: 'Garden tour', place: 2 })].map(line);
  for (const text of sent) assert.equal(transformDocumentLine(text, view.rules, REEL_CTX), text, 'reels are never taken out of the data');
  view.go('https://www.facebook.com/reel/1');
  await settle();
  assert.equal(view.at(), '2');
  assert.equal(view.row(), 'bread 1');
  assert.equal(view.diagnostics.decisions().some((decision) => decision.id === '1' && decision.detail === 'bread' && decision.layer === 'page'), true);
});

test('the reels option starts off, and preview, an always-show line and the kind switches leave reels alone', async () => {
  assert.equal(hidePostsByWords.options.find((option) => option.key === 'reels').default, false);
  for (const [name, options] of [
    ['off', { reels: false }],
    ['preview', { preview: true }],
    ['always show', { lists: { showPeople: 'Bread Club' } }],
    ['kinds only', { words: '', kinds: { videos: true } }],
  ]) {
    const view = setupReels(options);
    transformDocumentLine(line(footer('1', { caption: 'Fresh bread today', author: 'Bread Club' })), view.rules, REEL_CTX);
    view.go('https://www.facebook.com/reel/1');
    await settle();
    assert.equal(view.at(), '1', name);
    assert.equal(view.clicks.length, 0, name);
  }
});

test('a reel kept while the option was on stays once it is turned off or preview is on', async () => {
  for (const [key, value] of [['reels', false], ['preview', true]]) {
    const view = setupReels();
    transformDocumentLine(line(footer('1', { caption: 'Fresh bread today' })), view.rules, REEL_CTX);
    view.set(key, value);
    view.go('https://www.facebook.com/reel/1');
    await settle();
    assert.equal(view.at(), '1', key);
    assert.equal(view.clicks.length, 0, key);
  }
});

test('people and site lines skip reels too, and the sound counts as words', async () => {
  for (const [lists, doc] of [
    [{ words: '', people: 'Loud Page' }, footer('1', { author: 'Loud Page' })],
    [{ words: '', sites: 'shop.example' }, footer('1', { link: 'https://shop.example/deal' })],
    [{ words: 'morning song' }, footer('1', { sound: 'Morning Song' })],
  ]) {
    const { words = '', ...rest } = lists;
    const view = setupReels({ words, lists: rest });
    transformDocumentLine(line(doc), view.rules, REEL_CTX);
    view.go('https://www.facebook.com/reel/1');
    await settle();
    assert.equal(view.at(), '2', JSON.stringify(lists));
  }
});

test('the first reel comes in the page\'s own data on the Reels page, and other answers are left out', async () => {
  const inline = setupReels();
  transformDocumentLine(line({ require: [[{ __bbox: { result: { data: { viewer: { video_feed_unit_feed: { edges: [edge('1').data] } } } } } }], [footer('1', { caption: 'bread' })]] }), inline.rules, INLINE_CTX);
  inline.go('https://www.facebook.com/reel/1');
  await settle();
  assert.equal(inline.at(), '2', 'inline on /reel/');

  const elsewhere = setupReels({ start: 'https://www.facebook.com/' });
  transformDocumentLine(line(footer('1', { caption: 'bread' })), elsewhere.rules, INLINE_CTX);
  transformDocumentLine(line(footer('1', { caption: 'bread' })), elsewhere.rules, FEED_CTX);
  elsewhere.go('https://www.facebook.com/reel/?s=tab');
  elsewhere.go('https://www.facebook.com/reel/1');
  await settle();
  assert.equal(elsewhere.at(), '1', 'read off the Reels page, or from another answer, it was never kept');
});

test('a reel\'s data that comes after the viewer reached it still skips it', async () => {
  const view = setupReels();
  view.go('https://www.facebook.com/reel/1');
  await settle();
  assert.equal(view.at(), '1');
  transformDocumentLine(line(footer('1', { caption: 'bread rolls' })), view.rules, REEL_CTX);
  await settle();
  assert.equal(view.at(), '2');
});
