// Fixtures here are synthetic, shaped after the paths in uBlock Origin's Facebook rules.
// Replace them with scrubbed captures from the live site (see CONTRIBUTING.md).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SPONSORED_MARKERS, isSponsoredEdge, pruneSponsoredEdges } from '../src/features/feed/sponsored.js';
import { transformDocumentLine } from '../src/core/net/payload.js';

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

test('the network rule prunes a GraphQL line end to end', () => {
  const rule = { id: 'hideSponsoredPosts', markers: SPONSORED_MARKERS, transform: (doc) => pruneSponsoredEdges(doc) };
  const out = JSON.parse(transformDocumentLine(JSON.stringify(feed()), [rule]));
  assert.deepEqual(out.data.viewer.news_feed.edges.map((edge) => edge.node?.id ?? null), ['organic-1', null, 'organic-2', null]);
});
