// The page-side ad check against hand-built posts in happy-dom. happy-dom has no layout, so
// every rect is empty and the header test falls back to DOM order (anything before the post's
// text or first picture), and glyphs decode by flex order only.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { createDiagnostics } from '../src/core/diagnostics.js';
import { createHider, MARK } from '../src/core/dom/hide.js';
import { createLabelCache } from '../src/core/dom/label-cache.js';
import { createPostTracker } from '../src/core/dom/posts.js';
import { isHidden, normalizeText } from '../src/core/dom/visible-text.js';
import hideSponsoredPosts from '../src/features/feed/hide-sponsored-posts.js';
import { adLabel, isAdsAboutLink, readAdSignals, watchSponsoredPosts } from '../src/features/feed/sponsored-dom.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(html) {
  const win = new Window({ url: 'https://www.facebook.com/' });
  windows.push(win);
  win.document.body.innerHTML = `<div role="main"><div class="feed">${html}</div></div>`;
  return win;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const ZWSP = String.fromCharCode(0x200b);
const NBSP = String.fromCharCode(0xa0);
const RLM = String.fromCharCode(0x200f);

// A feed post: author row, byline, then text. byline goes where "2h · Public" usually is.
const post = ({ n = 1, author = '<a href="/brand">Brand</a>', byline = '<a href="/brand/posts/pfbid0P1">2h</a>', text = 'Post text', extra = '' } = {}) => `
  <div aria-posinset="${n}">
    <div class="header">
      <h4><span data-ad-rendering-role="profile_name">${author}</span></h4>
      <div class="byline">${byline}</div>
    </div>
    <div data-ad-rendering-role="story_message">${text}</div>
    ${extra}
  </div>`;
const CTA = '<div data-ad-rendering-role="cta-button"><a href="https://shop.example/">Shop now</a></div>';

const read = (win, options) => readAdSignals(win.document.querySelector('[aria-posinset]'), options);

test('ad labels match exactly, with dots, padding and invisible marks stripped', () => {
  for (const value of ['Sponsored', 'sponsored', ' Ad ', '· Sponsored', 'Sponsored ·', 'Paid partnership', `Spon${ZWSP}sored`, `${RLM}Ad${NBSP}`]) {
    assert.ok(adLabel(value), value);
  }
  for (const value of ['Sponsored by my mom', 'Ads', 'Adam', 'Advertisement', 'Add', '', null, 'Sponsored post']) {
    assert.equal(adLabel(value), null, String(value));
  }
  assert.equal(normalizeText(`a${ZWSP}b${NBSP} c`), 'ab c');
});

test('header label: the exact label in the byline is an ad, corroborated by an ad button', () => {
  const win = page(post({ byline: '<span>Sponsored</span> · <span>Public</span>', extra: CTA }));
  assert.deepEqual(read(win), { signal: 'header label', label: 'Sponsored', corroborated: true });
});

test('header label: "Ad" with no ad button still counts, just not corroborated', () => {
  const win = page(post({ byline: '<span>Ad</span>' }));
  assert.deepEqual(read(win), { signal: 'header label', label: 'Ad', corroborated: false });
});

test('the label in the post text, below it, in the heading or the author name is not an ad', () => {
  const cases = [
    post({ text: 'Sponsored' }),
    post({ text: 'Hi', extra: '<div><span>Sponsored</span></div>' }),
    post({ author: '<a href="/ad">Ad</a>' }),
    post({ author: '<a href="/x"><span>Sponsored</span></a>' }),
    post({ byline: '<div data-ad-rendering-role="title"><span>Ad</span></div>' }),
    // One block wrapping the post text and a later "Sponsored" (a reply, a caption).
    `<div aria-posinset="1"><h4><a href="/x">X</a></h4><div class="wrap"><div data-ad-rendering-role="story_message">Hi</div><span>Sponsored</span></div></div>`,
  ];
  for (const html of cases) assert.equal(read(page(html)), null, html);
});

test('hidden letters and decoys never read as a label', () => {
  const cases = [
    '<span style="display:none">Sponsored</span>',
    '<span aria-hidden="true">Sponsored</span>',
    '<span style="visibility:hidden">Ad</span>',
    '<span style="opacity:0">Ad</span>',
    '<span style="font-size:0">Ad</span>',
    '<span hidden>Ad</span>',
  ];
  for (const byline of cases) assert.equal(read(page(post({ byline }))), null, byline);
});

test('isHidden looks up to the boundary and no further', () => {
  const win = page('<div id="outer" style="display:none"><div id="post"><span id="leaf">x</span></div></div>');
  const leaf = win.document.getElementById('leaf');
  assert.equal(isHidden(leaf, win.document.getElementById('post')), false);
  assert.equal(isHidden(leaf), true);
});

test('labelledby: a live target that reads as a label', () => {
  const win = page(post({ byline: '<span aria-labelledby="lbl1"></span>' }));
  win.document.body.insertAdjacentHTML('beforeend', '<span id="lbl1">Sponsored</span>');
  assert.equal(read(win).signal, 'labelledby');
});

test('labelledby: a target Facebook already removed is read from the label cache', async () => {
  const win = page(post({ byline: '<span aria-labelledby="gone"></span>' }));
  const cache = createLabelCache({ doc: win.document });
  cache.start();
  win.document.body.insertAdjacentHTML('beforeend', '<div><span id="gone">Sponsored</span></div>');
  await tick();
  win.document.getElementById('gone').remove();
  assert.equal(read(win), null, 'without the cache there is nothing to read');
  assert.equal(read(win, { labelCache: cache }).signal, 'labelledby');
  cache.stop();
});

test('labelledby: a scrambled target is decoded by flex order', () => {
  const win = page(post({ byline: '<span aria-labelledby="scr"></span>' }));
  win.document.body.insertAdjacentHTML('beforeend',
    '<span id="scr" style="display:flex"><span style="order:2">d</span><span style="order:1">A</span></span>');
  assert.equal(read(win).signal, 'labelledby');
});

test('svg: <text> in the header, and a <use> target live or cached', async () => {
  // Visible <text> is header text too, so the first signal already has it.
  assert.equal(read(page(post({ byline: '<svg><text>Sponsored</text></svg>' }))).label, 'Sponsored');

  const live = page(post({ byline: '<svg><use href="#sv1"></use></svg>' }));
  live.document.body.insertAdjacentHTML('beforeend', '<svg><text id="sv1">Ad</text></svg>');
  assert.equal(read(live).signal, 'svg');

  const gone = page(post({ byline: '<svg><use xlink:href="#sv2"></use></svg>' }));
  const cache = createLabelCache({ doc: gone.document });
  cache.start();
  gone.document.body.insertAdjacentHTML('beforeend', '<svg><text id="sv2">Sponsored</text></svg>');
  await tick();
  gone.document.getElementById('sv2').remove();
  assert.equal(read(gone, { labelCache: cache }).signal, 'svg');
  cache.stop();
});

test('glyph order: shuffled letters are put back in flex order, skipping hidden and absolute decoys', () => {
  const byline = `<span style="display:flex">
    <span style="order:4">r</span><span style="order:3;position:absolute">x</span>
    <span style="order:2">d</span><span style="order:0;display:none">S</span>
    <span style="order:1">A</span><span style="order:5" aria-hidden="true">q</span></span>`;
  assert.deepEqual(read(page(post({ byline: byline.replace('<span style="order:4">r</span>', '') }))), { signal: 'glyph order', label: 'Ad', corroborated: false });
  assert.equal(read(page(post({ byline }))), null, '"Adr" is not a label');
});

test('glyph order: a scrambled timestamp stays organic', () => {
  const byline = '<span style="display:flex"><span style="order:2">h</span><span style="order:1">2</span><span style="order:3;position:absolute">A</span><span style="order:4;position:absolute">d</span></span>';
  assert.equal(read(page(post({ byline }))), null);
});

test('ads link: facebook.com/ads/about in the header, straight or through l.php', () => {
  assert.equal(read(page(post({ byline: '<a href="https://www.facebook.com/ads/about/?entry_product=ad_preferences">i</a>' }))).signal, 'ads link');
  assert.equal(read(page(post({ text: '<a href="/ads/about/">why am I seeing this</a>' }))), null, 'only in the header');
  assert.ok(isAdsAboutLink('/ads/about'));
  assert.ok(isAdsAboutLink(`https://l.facebook.com/l.php?u=${encodeURIComponent('https://www.facebook.com/ads/about/?x=1')}&amp;h=AT0`));
  assert.ok(!isAdsAboutLink('https://www.facebook.com/ads/aboutus'));
  assert.ok(!isAdsAboutLink('https://facebook.com.evil.example/ads/about'));
  assert.ok(!isAdsAboutLink('https://www.facebook.com/ads/manager'));
  assert.ok(!isAdsAboutLink('::nope'));
});

test('an ad button alone is only reported, and never from a group post or a reshare', () => {
  assert.deepEqual(read(page(post({ extra: CTA }))), { adButton: true });
  const fromGroup = post({ author: '<a href="/groups/1234567/">Group</a> <a href="/brand">Brand</a>', extra: CTA });
  assert.equal(read(page(fromGroup)), null);
  assert.deepEqual(read(page(post({ author: '<a href="/groups/feed/">Your feed</a>', extra: CTA }))), { adButton: true }, 'group feed pages are not a group');
  const reshare = post({ extra: `<div role="article"><h4><a href="/orig">Orig</a></h4><span>Sponsored</span>${CTA}</div>` });
  assert.equal(read(page(reshare)), null, "the shared post's label and button belong to it");
});

test('the watcher hides an ad once its label fills in, and reports an unread ad button only after the last retry', () => {
  const win = page(post({ n: 1, extra: CTA }) + post({ n: 2, byline: '<span class="late"></span>' }));
  const [first, second] = win.document.querySelectorAll('[aria-posinset]');
  const listeners = {};
  const posts = {
    on(type, fn) { (listeners[type] ??= []).push(fn); return () => {}; },
    current: () => [{ element: first }, { element: second }],
  };
  const hidden = [];
  const hider = { hide: (element, reason) => { hidden.push([element, reason]); return true; }, showAll() {} };
  const queue = [];
  const schedule = (fn) => { queue.push(fn); return queue.length; };
  const cancelled = new Set();
  const ads = [];
  const buttons = [];
  let on = true;
  watchSponsoredPosts({
    posts, hider, enabled: () => on, schedule, cancel: (id) => cancelled.add(id),
    onAd: (result) => ads.push(result.signal), onAdButton: (element) => buttons.push(element),
  });
  for (const element of [first, second]) listeners['post/add'][0]({ element });
  assert.equal(hidden.length, 0);
  assert.equal(buttons.length, 0, 'not on the first look');

  second.querySelector('.late').textContent = 'Sponsored';
  queue[3]();
  assert.deepEqual(hidden, [[second, 'Sponsored']]);
  assert.deepEqual(ads, ['header label']);
  assert.ok(cancelled.has(5) && cancelled.has(6), "the hidden post's other retries are cancelled");

  queue[0]();
  queue[1]();
  assert.equal(buttons.length, 0);
  queue[2]();
  assert.deepEqual(buttons, [first], 'reported after the last retry');

  on = false;
  first.querySelector('.byline').innerHTML = '<span>Ad</span>';
  listeners['post/update'][0]({ element: first });
  assert.equal(hidden.length, 1, 'nothing happens while the switch is off');
});

test('Hide sponsored posts hides a drawn ad in content mode, counts it, and lets it back when switched off', async () => {
  const win = page(post({ n: 1, byline: '<span>Sponsored</span>', extra: CTA }) + post({ n: 2, author: '<a href="/friend">Friend</a>', byline: '<a href="/friend/posts/pfbid0F">3h</a>' }));
  const doc = win.document;
  const warnings = [];
  const log = { info() {}, warn: (message) => warnings.push(message), error() {} };
  const posts = createPostTracker({ doc, log });
  const hider = createHider({ doc, posts, log });
  const diagnostics = createDiagnostics();
  const subscribers = [];
  let on = true;
  hideSponsoredPosts.setup({
    doc, net: null, posts, hider, log, diagnostics,
    settings: { subscribe: (fn) => subscribers.push(fn) },
    enabled: () => on,
  });
  const [ad, organic] = doc.querySelectorAll('[aria-posinset]');
  assert.ok(ad.querySelector(`[${MARK}]`), 'the ad is marked');
  assert.equal(organic.querySelector(`[${MARK}]`), null, 'the organic post is not');
  const rows = Object.fromEntries(diagnostics.rows().map(({ label, value }) => [label, value]));
  assert.equal(rows['Ads hidden on the page'], 'header label 1');
  assert.match(rows['Ads taken out of the data'], /^Off/);
  assert.deepEqual(warnings, [], 'no "got past the data rules" warning in content mode');

  on = false;
  for (const fn of subscribers) fn({ keys: ['hideSponsoredPosts'] });
  assert.equal(ad.querySelector(`[${MARK}]`), null, 'switched off, the ad is back');
  on = true;
  for (const fn of subscribers) fn({ keys: ['hideSponsoredPosts'] });
  assert.ok(ad.querySelector(`[${MARK}]`), 'and hidden again when switched back on');
  posts.stop();
  await tick();
});

test('in page mode, an ad the data rules missed is hidden and logged once', () => {
  const win = page(post({ n: 1, byline: '<span>Sponsored</span>' }) + post({ n: 2, byline: '<span>Ad</span>' }));
  const doc = win.document;
  const warnings = [];
  const log = { info() {}, warn: (message) => warnings.push(message), error() {} };
  const posts = createPostTracker({ doc, log });
  const hider = createHider({ doc, posts, log });
  const rules = [];
  hideSponsoredPosts.setup({
    doc, net: { transformResponses: (rule) => rules.push(rule) }, posts, hider, log,
    diagnostics: createDiagnostics(), settings: { subscribe() {} }, enabled: () => true,
  });
  assert.equal(rules.length, 1, 'the data rule is still added');
  assert.equal(doc.querySelectorAll(`[${MARK}]`).length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /got past the data rules.*header label/);
  posts.stop();
});
