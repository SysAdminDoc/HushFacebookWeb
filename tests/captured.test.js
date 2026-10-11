// The shipped rules against scrubbed captures of what facebook.com really sends (2026-10-10).
// Shapes come from the site, so a rule that only matched the hand-built fixtures would fail here.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureLines, parseLine } from './helpers/fixtures.js';
import { AD_MARKERS, adRule, pruneAds as pruneRows } from '../src/features/feed/ad-markers.js';
import { parseRoute } from '../src/core/route.js';
import { SEEN_MUTATIONS } from '../src/features/stories/anonymous-stories.js';
import { describeRequest, installNetworkHooks } from '../src/core/net/hooks.js';
import { rulesFor, transformDocumentLine } from '../src/core/net/payload.js';

// The ad rows only. Suggested posts have their own test below, since the organic feed capture
// holds one.
const AD_ROWS = AD_MARKERS.filter((row) => row.feature.startsWith('hideSponsored'));
const AD_ROW_TEXT = [...new Set(AD_ROWS.flatMap((row) => row.text))];
const pruneAds = (doc) => pruneRows(doc, AD_ROWS);
const rule = { id: 'hideSponsoredPosts', enabled: () => true, markers: AD_ROW_TEXT, match: () => true, transform: (doc) => pruneAds(doc).length > 0 };
// The quotes matter: a cursor's logging JSON counts a LATE_DEPENDENT_SEARCH_ADS role, which is not an ad.
const AD_TEXT = /MarketplaceFeedAdStory|"SEARCH_ADS"|CometStorySponsoredLabelStrategy|"th_dat_spo":\{|"sponsored_data":\{/;

function countMatches(value, predicate, seen = { n: 0 }) {
  if (value && typeof value === 'object') {
    if (predicate(value)) seen.n++;
    for (const child of Object.values(value)) countMatches(child, predicate, seen);
  }
  return seen.n;
}

test('a feed page with no ad goes through untouched, and the markers skip the parse', async () => {
  const lines = await fixtureLines('CometNewsFeedPaginationQuery.jsonl');
  assert.equal(lines.length, 3);
  const first = parseLine(lines[0]);
  assert.equal(first.data.viewer.news_feed.edges.length, 1);
  assert.ok('th_dat_spo' in first.data.viewer.news_feed.edges[0].node, 'the renamed sponsored_data field is in the capture');
  assert.ok('cat_sensitive' in first.data.viewer.news_feed.edges[0], 'the hashed category is in the capture');
  for (const line of lines) {
    assert.equal(rulesFor(line, [rule]).length, 0, 'an organic page carries none of the ad markers');
    assert.equal(transformDocumentLine(line, [rule]), line);
    const doc = parseLine(line);
    const before = structuredClone(doc);
    assert.deepEqual(pruneAds(doc), []);
    assert.deepEqual(doc, before);
  }
});

test("the home page's inline feed data reaches the JSON.parse hook and comes back whole", async () => {
  const lines = await fixtureLines('home-data-sjs.jsonl');
  assert.equal(lines.length, 2);
  const win = { JSON: { parse: JSON.parse }, location: { href: 'https://www.facebook.com/' } };
  const net = installNetworkHooks({ win, log: { error: () => {}, warn() {}, info() {}, debug() {} } });
  let transforms = 0;
  net.transformResponses({ ...rule, match: (ctx) => ctx.transport === 'json-parse', transform: (doc) => { transforms++; return pruneAds(doc).length > 0; } });
  for (const line of lines) {
    const hooked = win.JSON.parse(line);
    assert.deepEqual(hooked, JSON.parse(line));
    const cache = JSON.stringify(hooked).includes('RelayPrefetchedStreamCache');
    assert.ok(cache, 'the blob carries a RelayPrefetchedStreamCache entry');
  }
  assert.equal(transforms, 0, 'no marker, so the organic first screen is never walked');
  assert.match(lines[0], /"news_feed":\{"edges":\[\{/);
  assert.match(lines[0], /"th_dat_spo":null/);
});

test('Marketplace: the ad card loses its node, listings and paging stay', async () => {
  const lines = await fixtureLines('MarketplaceCometBrowseFeedLightPaginationQuery.jsonl');
  assert.equal(lines.length, 6);
  const adLines = lines.filter((line) => line.includes('"MarketplaceFeedAdStory"'));
  assert.equal(adLines.length, 1);
  for (const line of lines) {
    const out = transformDocumentLine(line, [rule]);
    assert.notEqual(out, null, 'the line is never dropped');
    if (!adLines.includes(line)) {
      assert.equal(out, line, 'listing chunks are byte for byte what Facebook sent');
      continue;
    }
    const before = parseLine(line);
    const after = parseLine(out);
    assert.deepEqual(pruneAds(parseLine(line)), ['MarketplaceFeedAdStory'], 'the Marketplace row catches it');
    assert.equal(before.data.node.__typename, 'MarketplaceFeedAdStory');
    assert.equal(before.label, after.label);
    assert.deepEqual(before.path, after.path);
    assert.deepEqual(after.data, { cursor: before.data.cursor });
    assert.deepEqual(after.extensions, before.extensions);
    assert.doesNotMatch(out, AD_TEXT);
  }
  const first = parseLine(lines[0]);
  assert.equal(first.data.marketplace_home_feed.edges[0].node.__typename, 'MarketplaceFeedGeneralListingObject');
});

test('search: the ad edge is emptied beside the organic results', async () => {
  const [line] = await fixtureLines('SearchCometResultsPaginatedResultsQuery.jsonl');
  const before = parseLine(line);
  const roles = before.data.serpResponse.results.edges.map((edge) => edge.node.role);
  assert.deepEqual(roles, ['POST_INTEREST_KEYWORDS', 'FEED_POSTS', 'SEARCH_ADS', 'POST_SILVER_TORCH']);
  const ad = before.data.serpResponse.results.edges[2];
  assert.equal(ad.rendering_strategy.__typename, 'SearchResultsAdRenderingStrategy');
  assert.ok(JSON.stringify(ad.rendering_strategy).includes('CometStorySponsoredLabelStrategy'), 'the ad keeps its story in rendering_strategy');

  assert.deepEqual(pruneAds(parseLine(line)), ['SEARCH_ADS'], 'the search row catches it, and nothing else does');
  const out = transformDocumentLine(line, [rule]);
  const after = parseLine(out);
  const edges = after.data.serpResponse.results.edges;
  assert.equal(edges.length, 4);
  assert.deepEqual(edges.map((edge) => edge.node?.role ?? null), ['POST_INTEREST_KEYWORDS', 'FEED_POSTS', null, 'POST_SILVER_TORCH']);
  assert.deepEqual(Object.keys(edges[2]).sort(), Object.keys(ad).filter((key) => key !== 'node' && key !== 'rendering_strategy').sort());
  for (const i of [0, 1, 3]) assert.deepEqual(edges[i], before.data.serpResponse.results.edges[i]);
  assert.deepEqual(after.data.serpResponse.results.page_info, before.data.serpResponse.results.page_info);
  assert.doesNotMatch(out, AD_TEXT);
  assert.ok(countMatches(before, (value) => value.__typename === 'CometStorySponsoredLabelStrategy') >= 1, 'the capture carries the ad label section');
  assert.equal(countMatches(after, (value) => value.__typename === 'CometStorySponsoredLabelStrategy'), 0);
});

test('a video with no in-stream ads: the live answer is left alone and never parsed', async () => {
  const [line] = await fixtureLines('useInstreamAdsHaloFetcherQuery.jsonl');
  const doc = parseLine(line);
  assert.deepEqual(doc.data.scrubber, { instream_video_ad_breaks: [], post_roll_ad_break: null });
  assert.equal(rulesFor(line, [rule]).length, 0, 'empty breaks carry none of the markers');
  assert.deepEqual(pruneAds(doc), []);
  // The same answer with a break in it is emptied back to this shape.
  const filled = parseLine(line);
  filled.data.scrubber.instream_video_ad_breaks.push({ id: 'break-1' });
  const out = transformDocumentLine(JSON.stringify(filled), [rule]);
  assert.deepEqual(parseLine(out), doc);
});

test('the story seen request is the one View stories anonymously holds back', async () => {
  const lines = await fixtureLines('storiesUpdateSeenStateMutation.request.jsonl');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const record = parseLine(line);
    assert.equal(record.method, 'POST');
    assert.equal(record.path, '/api/graphql/');
    const body = new URLSearchParams({ fb_api_req_friendly_name: record.friendly, doc_id: record.doc_id, variables: record.variables }).toString();
    const ctx = describeRequest({ transport: 'xhr', url: record.path, method: record.method, body, headers: {}, base: 'https://www.facebook.com/' });
    assert.ok(SEEN_MUTATIONS.has(ctx.friendlyName), `${ctx.friendlyName} should be blocked`);
    const variables = JSON.parse(record.variables);
    assert.deepEqual(Object.keys(variables.input), ['bucket_id', 'story_id', 'actor_id', 'client_mutation_id']);
    assert.equal(variables.scale, 1);
  }
});

test('the suggested post in the captured Home page goes, the rest of the page stays', async () => {
  const lines = await fixtureLines('CometNewsFeedPaginationQuery.jsonl');
  const fired = [];
  const suggested = adRule('hideSuggestedPosts', () => true, (ids) => fired.push(...ids), { route: () => parseRoute('https://www.facebook.com/') });
  const ctx = { transport: 'xhr', path: '/api/graphql/', friendlyName: 'CometNewsFeedPaginationQuery' };
  let pruned = 0;
  for (const line of lines) {
    const out = transformDocumentLine(line, [suggested], ctx);
    if (out === line) continue;
    pruned++;
    const before = parseLine(line).data.viewer.news_feed.edges;
    const after = parseLine(out).data.viewer.news_feed.edges;
    assert.equal(after.length, before.length, 'the edge stays, with its cursor');
    assert.deepEqual(after.map((edge) => edge.cursor), before.map((edge) => edge.cursor));
    assert.ok(after.every((edge) => !('node' in edge)));
  }
  assert.equal(pruned, 1);
  assert.deepEqual(fired, ['follow_button']);
  const search = { ...ctx, friendlyName: 'SearchCometResultsPaginatedResultsQuery' };
  for (const line of lines) assert.equal(transformDocumentLine(line, [suggested], search), line, 'not outside the feeds');
});
