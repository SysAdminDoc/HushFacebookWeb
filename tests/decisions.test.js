// The Diagnostics decision list: what goes on it, from the page and from Facebook's data, and
// how much of it is kept.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { createDiagnostics, DECISIONS, decisionLine, postTag } from '../src/core/diagnostics.js';
import { createHider } from '../src/core/dom/hide.js';
import { adRule } from '../src/features/feed/ad-markers.js';
import { pruneFiltered } from '../src/features/feed/filters.js';
import { compileFilters } from '../src/core/filters/engine.js';
import { pruneSeen } from '../src/features/feed/hide-seen-posts.js';
import hideSponsoredReels from '../src/features/reels/hide-sponsored-reels.js';
import { transformDocumentLine } from '../src/core/net/payload.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

test('a post tag is short, steady for one id and different for another', () => {
  assert.match(postTag('UzpfSTEyMw'), /^#[0-9a-z]{6}$/);
  assert.equal(postTag('UzpfSTEyMw'), postTag('UzpfSTEyMw'));
  assert.notEqual(postTag('UzpfSTEyMw'), postTag('UzpfSTEyNA'));
  assert.equal(postTag(null), 'no id yet');
  assert.equal(postTag(''), 'no id yet');
});

test('only the last 50 decisions are kept, oldest first, each telling listeners', () => {
  let heard = 0;
  const diagnostics = createDiagnostics({ now: () => Date.UTC(2026, 9, 11, 18, 24, 5) });
  diagnostics.subscribe(() => heard++);
  for (let i = 0; i < DECISIONS + 7; i++) diagnostics.decide({ post: `p${i}`, rule: 'Filter', signal: `w${i}`, layer: 'data' });
  const kept = diagnostics.decisions();
  assert.equal(kept.length, DECISIONS);
  assert.equal(kept[0].signal, 'w7');
  assert.equal(kept.at(-1).signal, `w${DECISIONS + 6}`);
  assert.equal(heard, DECISIONS + 7);
  assert.equal(decisionLine(kept[0]), `18:24:05 data ${postTag('p7')} Filter: w7`);
  // A copy each time, so nobody edits the list from outside.
  kept[0].rule = 'changed';
  assert.equal(diagnostics.decisions()[0].rule, 'Filter');
  // Anything that isn't data counts as the page, and a missing signal is left off the line.
  diagnostics.decide({ post: 'x', rule: 'Seen' });
  assert.equal(decisionLine(diagnostics.decisions().at(-1)), `18:24:05 page ${postTag('x')} Seen`);
});

test('the hider reports each new reason on a post once, with its signal or detail', () => {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  win.document.body.innerHTML = '<div aria-posinset="1"><div><a href="/a/posts/111">1h</a>Post</div></div>';
  const post = win.document.querySelector('[aria-posinset]');
  const heard = [];
  const hider = createHider({ doc: win.document, onHide: ({ element, reason, detail, signal }) => heard.push([element === post, reason, detail, signal]) });
  hider.hide(post, 'Sponsored', undefined, 'header label');
  hider.hide(post, 'Sponsored', undefined, 'header label');
  hider.hide(post, 'Filter', 'cats');
  assert.deepEqual(heard, [[true, 'Sponsored', undefined, 'header label'], [true, 'Filter', 'cats', undefined]]);
  // A listener that throws doesn't stop the hide.
  const broken = createHider({ doc: win.document, log: { error() {} }, onHide: () => { throw new Error('nope'); } });
  win.document.body.insertAdjacentHTML('beforeend', '<div aria-posinset="2"><div>Second</div></div>');
  assert.equal(broken.hide(win.document.querySelector('[aria-posinset="2"]'), 'Seen'), true);
});

test('the data rules report the post they took out and the rule that matched', () => {
  const diagnostics = createDiagnostics();
  const rule = adRule('hideSponsoredPosts', () => true, undefined, { diagnostics, reason: 'Sponsored' });
  const line = JSON.stringify({ data: { viewer: { news_feed: { edges: [
    { cursor: 'a', node: { __typename: 'Story', id: 'organic', post_id: '1' } },
    { cursor: 'b', category: 'SPONSORED', node: { __typename: 'Story', id: 'ad-story', post_id: '2' } },
  ] } } } });
  transformDocumentLine(line, [rule], { transport: 'fetch', path: '/api/graphql/', friendlyName: 'CometNewsFeedPaginationQuery' });
  assert.deepEqual(diagnostics.decisions().map(({ post, rule: name, signal, layer }) => [post, name, signal, layer]), [[postTag('2'), 'Sponsored', 'category', 'data']]);
  // Without diagnostics, nothing is reported and the rule still works.
  const quiet = adRule('hideSponsoredPosts', () => true);
  const out = JSON.parse(transformDocumentLine(line, [quiet], { transport: 'fetch', path: '/api/graphql/', friendlyName: 'CometNewsFeedPaginationQuery' }));
  assert.equal(out.data.viewer.news_feed.edges[1].node, undefined);
});

test('a post in an answer a later rule fails on is never reported or counted as taken out', () => {
  const diagnostics = createDiagnostics();
  let counted = 0;
  const rule = adRule('hideSponsoredPosts', () => true, (fired) => { counted += fired.length; }, { diagnostics, reason: 'Sponsored' });
  const broken = { id: 'broken', transform() { throw new Error('boom'); } };
  const line = JSON.stringify({ data: { viewer: { news_feed: { edges: [
    { cursor: 'b', category: 'SPONSORED', node: { __typename: 'Story', id: 'ad-story', post_id: '2' } },
  ] } } } });
  const ctx = { transport: 'fetch', path: '/api/graphql/', friendlyName: 'CometNewsFeedPaginationQuery' };
  assert.equal(transformDocumentLine(line, [rule, broken], ctx, () => {}), line);
  assert.equal(diagnostics.decisions().length, 0);
  assert.equal(counted, 0);
  transformDocumentLine(line, [rule], ctx);
  assert.deepEqual(diagnostics.decisions().map(({ post }) => post), [postTag('2')], 'the id was read before the story went');
  assert.equal(counted, 1);
});

test('a cleared video ad break schedule is counted but stays off the decision list', () => {
  const diagnostics = createDiagnostics();
  const rules = [];
  hideSponsoredReels.setup({ net: { transformResponses: (rule) => rules.push(rule) }, enabled: () => true, diagnostics });
  const line = JSON.stringify({ data: { video: { id: 'v1', instream_video_ad_breaks_comet: { mid_rolls: [{ index: 0, instream_placement: 'MID_ROLL', time_offset_in_ms: 60000 }], pre_roll: null } } } });
  const ctx = { transport: 'xhr', path: '/api/graphql/', friendlyName: 'FBUnifiedVideoContainerQuery' };
  for (let i = 0; i < 3; i++) {
    assert.equal(JSON.parse(transformDocumentLine(line, rules, ctx)).data.video.instream_video_ad_breaks_comet, null);
  }
  assert.deepEqual(diagnostics.decisions(), []);
  assert.deepEqual(diagnostics.rows().find((row) => row.label === 'Videos cleared of ad breaks'), { label: 'Videos cleared of ad breaks', value: '3', shareable: false });
});

test('word filters and seen posts report each story they drop, with what matched', () => {
  const doc = () => ({ edges: [
    { cursor: 'a', node: { __typename: 'Story', id: 's1', message: { text: 'Everything you ever wanted to know about crypto, and more' } } },
    { cursor: 'b', node: { __typename: 'Story', id: 's2', message: { text: 'A quiet walk along the river on a Sunday afternoon' } } },
  ] });
  const filtered = [];
  const filter = { rules: compileFilters('crypto').rules, kinds: new Set() };
  const reasons = pruneFiltered(doc(), filter, (story, reason) => filtered.push([story.id, reason]));
  assert.deepEqual(reasons, ['crypto']);
  assert.deepEqual(filtered, [['s1', 'crypto']]);
  const seen = [];
  const count = pruneSeen(doc(), (key) => key.startsWith('t:'), (story, key) => seen.push([story.id, key.slice(0, 2)]));
  assert.equal(count, 2);
  assert.deepEqual(seen, [['s1', 't:'], ['s2', 't:']]);
});
