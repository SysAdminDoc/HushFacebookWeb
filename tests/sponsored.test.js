// Fixtures here are synthetic. The first set follows uBlock Origin's old Facebook rules;
// the 2026 set copies the field names and shapes of the 2026-10-10 live capture, with
// every id, name and token replaced.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SPONSORED_MARKERS, hasSponsoredLabel, isSponsoredEdge, pruneSponsoredEdges } from '../src/features/feed/sponsored.js';
import { rulesFor, transformDocumentLine } from '../src/core/net/payload.js';

const feed = () => ({
  data: {
    viewer: {
      news_feed: {
        edges: [
          { node: { __typename: 'Story', id: 'organic-1' }, cursor: 'a' },
          { category: 'SPONSORED', node: { __typename: 'Story', id: 'ad-1', sponsored_data: { ad_id: '9' } }, cursor: 'b' },
          { category: 'ORGANIC', node: { __typename: 'Story', id: 'organic-2', sponsored_data: null }, cursor: 'c' },
          { node: { __typename: 'Story', id: 'ad-2', sponsored_data: { ad_id: '10' } }, cursor: 'd' },
        ],
      },
    },
  },
});

test('sponsored edges lose their node but keep their cursor', () => {
  const doc = feed();
  assert.equal(pruneSponsoredEdges(doc), true);
  const edges = doc.data.viewer.news_feed.edges;
  assert.equal(edges.length, 4);
  assert.deepEqual(edges[1], { category: 'SPONSORED', cursor: 'b' });
  assert.deepEqual(edges[3], { cursor: 'd' });
  assert.equal(edges[0].node.id, 'organic-1');
  assert.equal(edges[2].node.id, 'organic-2');
});

test('a feed without ads is left exactly as it was', () => {
  const doc = feed();
  doc.data.viewer.news_feed.edges = [doc.data.viewer.news_feed.edges[0], doc.data.viewer.news_feed.edges[2]];
  const before = structuredClone(doc);
  assert.equal(pruneSponsoredEdges(doc), false);
  assert.deepEqual(doc, before);
});

test('streamed @stream chunks are pruned too', () => {
  const chunk = { label: 'CometNewsFeed_viewer$stream$CometNewsFeed_viewer_news_feed', path: ['viewer', 'news_feed', 'edges', 4], data: { category: 'SPONSORED', node: { id: 'ad' }, cursor: 'e' } };
  assert.equal(pruneSponsoredEdges(chunk), true);
  assert.deepEqual(chunk.data, { category: 'SPONSORED', cursor: 'e' });
});

test('inline page data (ScheduledServerJS / RelayPrefetchedStreamCache) is reached', () => {
  const inline = { require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { require: [['RelayPrefetchedStreamCache', 'next', [], ['id', { __bbox: { result: feed() } }]]] } }]]] };
  assert.equal(pruneSponsoredEdges(inline), true);
  const edges = inline.require[0][3][0].__bbox.require[0][3][1].__bbox.result.data.viewer.news_feed.edges;
  assert.equal(edges.filter((edge) => edge.node).length, 2);
});

test('isSponsoredEdge rejects things that are not edges', () => {
  assert.equal(isSponsoredEdge(null), false);
  assert.equal(isSponsoredEdge([]), false);
  assert.equal(isSponsoredEdge({ category: 'SPONSORED' }), false);
  assert.equal(isSponsoredEdge({ node: null }), false);
  assert.equal(isSponsoredEdge({ node: { sponsored_data: null } }), false);
  assert.equal(isSponsoredEdge({ node: null, category: 'SPONSORED' }), true);
});

// 2026 shapes: renamed fields (th_dat_spo, cat_sensitive) on every feed edge.
const edge2026 = (id, extra = {}, node = {}) => ({
  brs_content_label: 0,
  cat_sensitive: { enc: 'f'.repeat(64), cat: null },
  is_ad_eligible_for_ad_pod: false,
  sposnsor_new_distac_action: null,
  node: { __typename: 'Story', id, th_dat_spo: null, attached_story: null, ...node },
  cursor: `c-${id}`,
  ...extra,
});
const adLabel = { sponsored_label: { __typename: 'CometStorySponsoredLabelStrategy', label: 'Ad', story: { th_dat_spo: { is_demo_ad: false } } } };

test('2026 feed: organic edges with the renamed fields set to null are kept', () => {
  const doc = { data: { viewer: { news_feed: { edges: [edge2026('o1'), edge2026('o2')] } } } };
  const before = structuredClone(doc);
  assert.equal(pruneSponsoredEdges(doc), false);
  assert.deepEqual(doc, before);
});

test('2026 feed: th_dat_spo (renamed sponsored_data) marks an ad', () => {
  const edge = edge2026('ad', {}, { th_dat_spo: { is_demo_ad: false } });
  assert.equal(isSponsoredEdge(edge), true);
});

test('2026 feed: a hashed category that still says SPONSORED marks an ad', () => {
  assert.equal(isSponsoredEdge(edge2026('ad', { cat_sensitive: { enc: 'e'.repeat(64), cat: 'SPONSORED' } })), true);
});

test('2026 feed: the sponsored label section marks an ad even when field names change again', () => {
  const edge = edge2026('ad', {}, { th_dat_spo: undefined, comet_sections: { context_layout: { story: { comet_sections: { metadata: [adLabel] } } } } });
  delete edge.node.th_dat_spo;
  assert.equal(isSponsoredEdge(edge), true);
  const doc = { data: { viewer: { news_feed: { edges: [edge2026('o1'), edge] } } } };
  assert.equal(pruneSponsoredEdges(doc), true);
  assert.deepEqual(doc.data.viewer.news_feed.edges.map((e) => e.node?.id ?? null), ['o1', null]);
});

test('a friend sharing an ad is not an ad', () => {
  const share = edge2026('share', {}, { attached_story: { __typename: 'Story', id: 'shared-ad', comet_sections: adLabel } });
  assert.equal(hasSponsoredLabel(share.node), false);
  assert.equal(isSponsoredEdge(share), false);
});

test('a page wrapper holding an ad deep inside keeps its node', () => {
  const group = { data: { node: { __typename: 'Group', group_feed: { edges: [edge2026('g1'), edge2026('g-ad', {}, { comet_sections: adLabel })] } } } };
  assert.equal(isSponsoredEdge(group.data), false);
  assert.equal(pruneSponsoredEdges(group), true);
  assert.equal(group.data.node.__typename, 'Group');
  assert.deepEqual(group.data.node.group_feed.edges.map((e) => e.node?.id ?? null), ['g1', null]);
});

test('Marketplace ad cards go, listings stay', () => {
  const doc = { data: { viewer: { marketplace_feed_stories: { edges: [
    { node: { __typename: 'MarketplaceFeedGeneralListingObject', id: 'l1' }, cursor: 'm1' },
    { node: { __typename: 'MarketplaceFeedAdStory', id: 'ad', ad_id_string: '1', ad_impression_client_token: 'x' }, cursor: 'm2' },
  ] } } } };
  assert.equal(pruneSponsoredEdges(doc), true);
  assert.deepEqual(doc.data.viewer.marketplace_feed_stories.edges.map((e) => e.node?.id ?? null), ['l1', null]);
});

test('search ads go, other search modules stay', () => {
  const result = (role) => ({ cursor: role, logging_unit_id: 'u', rendering_strategy: { __typename: 'SearchResultsAdRenderingStrategy' }, node: { __typename: 'SearchRenderable', role } });
  const doc = { data: { serpResponse: { results: { edges: [result('FEED_POSTS'), result('SEARCH_ADS'), result('POST_SILVER_TORCH')] } } } };
  assert.equal(pruneSponsoredEdges(doc), true);
  assert.deepEqual(doc.data.serpResponse.results.edges.map((e) => e.node?.role ?? null), ['FEED_POSTS', null, 'POST_SILVER_TORCH']);
});

test('markers: a 2026 ad line is picked up, an organic line with null ad fields is not', () => {
  const rule = { id: 'hideSponsoredPosts', markers: SPONSORED_MARKERS };
  const organic = JSON.stringify({ data: { viewer: { news_feed: { edges: [edge2026('o1')] } } } });
  const ad = JSON.stringify({ data: { viewer: { news_feed: { edges: [edge2026('ad', {}, { th_dat_spo: { is_demo_ad: false } })] } } } });
  assert.equal(rulesFor(organic, [rule]).length, 0);
  assert.equal(rulesFor(ad, [rule]).length, 1);
});

test('the network rule prunes a GraphQL line end to end', () => {
  const rule = { id: 'hideSponsoredPosts', markers: SPONSORED_MARKERS, transform: (doc) => pruneSponsoredEdges(doc) };
  const out = JSON.parse(transformDocumentLine(JSON.stringify(feed()), [rule]));
  assert.deepEqual(out.data.viewer.news_feed.edges.map((edge) => edge.node?.id ?? null), ['organic-1', null, 'organic-2', null]);
});
