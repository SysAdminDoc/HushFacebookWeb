// A feed post Facebook drew on the server keeps its data, so React can hydrate it without #418,
// and is hidden on the page by its place instead. The inline shapes are the groups feed's as
// captured live on 2026-11-03: the first edge in the page's own answer, the next one streamed in
// after it as a blob of its own with a path.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adRule, drawnEdges } from '../src/features/feed/ad-markers.js';
import { hideDrawnPosts } from '../src/features/feed/drawn-posts.js';
import { transformDocumentLine } from '../src/core/net/payload.js';

const joinTitle = { __typename: 'CometFeedStoryCommunityAttributionTitleStrategy', if_viewer_can_join_group: { join_action: { __typename: 'GroupJoinForumAction' } } };
const suggested = (id) => ({ node: { __typename: 'Story', id, comet_sections: { context_layout: { story: { comet_sections: { title: joinTitle } } } } }, cursor: `c-${id}` });
const friend = (id) => ({ node: { __typename: 'Story', id }, cursor: `c-${id}` });

const handle = (result, sequence) => ({ require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { require: [['RelayPrefetchedStreamCache', 'next', [], ['adp_GroupsFeed', { __bbox: { complete: false, result, sequence_number: sequence } }]]] } }]]] });
const initial = (...edges) => handle({ data: { viewer: { groups_tab: { cross_group_feed: { edges } } } }, extensions: { is_final: false } }, 0);
const streamed = (edge, index) => handle({ data: edge, extensions: {}, label: 'GroupsFeed_viewer$stream$cross_group_feed', path: ['viewer', 'groups_tab', 'cross_group_feed', 'edges', index] }, index);

const INLINE = { transport: 'json-parse', method: '', url: '', host: '', path: '', friendlyName: '' };
const FETCHED = { transport: 'fetch', method: 'POST', url: '', host: 'www.facebook.com', path: '/api/graphql/', friendlyName: 'GroupsCometCrossGroupFeedPaginationQuery' };
const GROUPS = { type: 'groups', path: '/groups/feed/', href: 'https://www.facebook.com/groups/feed/' };

const feedOf = (doc) => doc.require[0][3][0].__bbox.require[0][3][1].__bbox.result.data;
const run = (doc, rule, ctx = INLINE) => JSON.parse(transformDocumentLine(JSON.stringify(doc), [rule], ctx));

test("the edges in the page's own answer are the drawn ones, numbered from 1, and a streamed one isn't", () => {
  // A row that isn't a story (People you may know) is drawn too.
  const people = { node: { __typename: 'PaginatedPeopleYouMayKnowFeedUnit', __isFeedUnit: 'PaginatedPeopleYouMayKnowFeedUnit' }, cursor: 'c-p' };
  const doc = initial(friend('a'), suggested('b'), people);
  const places = drawnEdges(doc);
  const edges = feedOf(doc).viewer.groups_tab.cross_group_feed.edges;
  assert.deepEqual(edges.map((edge) => places.get(edge)), [1, 2, 3]);
  assert.equal(drawnEdges(streamed(suggested('c'), 1)).size, 0);
});

test('a suggestion the server drew keeps its node and goes to onDrawn, and one streamed in or fetched is dropped', () => {
  const pruned = [];
  const drawn = [];
  const rule = adRule('hideSuggestedPosts', () => true, (ids) => pruned.push(...ids), { route: () => GROUPS, onDrawn: (kept) => drawn.push(...kept) });

  const first = run(initial(suggested('s1'), friend('f1')), rule);
  assert.ok(feedOf(first).viewer.groups_tab.cross_group_feed.edges[0].node, 'the drawn suggestion keeps its node');
  assert.deepEqual(drawn, [{ place: 1, signal: 'group_join' }]);
  assert.deepEqual(pruned, []);

  const next = run(streamed(suggested('s2'), 1), rule);
  assert.equal(feedOf(next).node, undefined, 'the streamed suggestion is dropped');
  assert.deepEqual(pruned, ['group_join']);

  const fetched = run({ data: { viewer: { groups_tab: { cross_group_feed: { edges: [suggested('s3')] } } } }, extensions: {} }, adRule('hideSuggestedPosts', () => true, undefined, { onDrawn: (kept) => drawn.push(...kept) }), FETCHED);
  assert.equal(fetched.data.viewer.groups_tab.cross_group_feed.edges[0].node, undefined, 'a fetched page is dropped');
  assert.equal(drawn.length, 1);
});

// Live 2026-11-03 on /search/posts/: a story taken out of the inline answer threw no #418, and the
// page numbered the results left 1, 2, 3..., so after the pruned ad an edge's place would name the
// next post.
test("search results in the page's own answer aren't drawn ones, so an AI-labeled one is dropped", () => {
  const aiLabel = { __typename: 'CometFeedStoryGenAIContentTransparencyStrategy', was_detected_as_ai_generated: true };
  const result = (id, story) => ({ node: { __typename: 'SearchRenderable', role: 'PUBLIC_POSTS' }, rendering_strategy: { view_model: { click_model: { story: { __typename: 'Story', id, ...story } } } }, cursor: `c-${id}` });
  const ad = { node: { __typename: 'SearchRenderable', role: 'SEARCH_ADS' }, rendering_strategy: { view_model: {} }, cursor: 'c-ad' };
  const labeled = result('ai', { comet_sections: { context_layout: { story: { comet_sections: { metadata: [aiLabel] } } } } });
  const inline = { data: { serpResponse: { results: { edges: [result('a'), ad, labeled] } } }, extensions: { is_final: false } };
  assert.equal(drawnEdges(inline).size, 0);

  const drawn = [];
  const pruned = [];
  const rule = adRule('hideAiPosts', () => true, (ids) => pruned.push(...ids), { route: () => ({ type: 'search', path: '/search/posts/', href: 'https://www.facebook.com/search/posts/?q=bread' }), onDrawn: (kept) => drawn.push(...kept) });
  const edges = run(inline, rule).data.serpResponse.results.edges;
  assert.deepEqual(edges.map((edge) => edge.rendering_strategy?.view_model?.click_model?.story?.id ?? null), ['a', null, null]);
  assert.equal(edges[2].cursor, 'c-ai');
  assert.deepEqual(pruned, ['genai_label']);
  assert.deepEqual(drawn, []);
});

test('without a page to hide it on, a drawn suggestion is dropped as before', () => {
  const rule = adRule('hideSuggestedPosts', () => true, undefined, { route: () => GROUPS });
  assert.equal(feedOf(run(initial(suggested('s1')), rule)).viewer.groups_tab.cross_group_feed.edges[0].node, undefined);
  assert.equal(hideDrawnPosts({ posts: null, hider: {}, router: {} }), undefined);
});

test('the page hides the post at the drawn place, on the feed it loaded with only', () => {
  const listeners = new Map();
  const current = [];
  const posts = {
    on: (event, fn) => {
      listeners.set(event, fn);
      return () => listeners.delete(event);
    },
    current: () => current,
  };
  const add = (place) => {
    const element = { isConnected: true, getAttribute: (name) => (name === 'aria-posinset' ? String(place) : null) };
    current.push({ element });
    listeners.get('post/add')({ element });
    return element;
  };
  const hidden = [];
  const hider = { hide: (element, reason) => hidden.push([element, reason]) > 0 };
  let route = GROUPS;
  const signals = [];
  const onDrawn = hideDrawnPosts({ posts, hider, router: { current: () => route }, enabled: () => true, reason: 'Suggested', onHide: (signal) => signals.push(signal), schedule: () => 0, cancel: () => {} });

  const first = add(1);
  add(2);
  assert.equal(hidden.length, 0, 'nothing before the data says which');
  onDrawn([{ place: 1, signal: 'group_join' }]);
  assert.deepEqual(hidden, [[first, 'Suggested']]);
  assert.deepEqual(signals, ['group_join']);

  route = { type: 'home', path: '/', href: 'https://www.facebook.com/' };
  add(1);
  assert.equal(hidden.length, 1, 'another feed numbers its posts from 1 too');
  route = GROUPS;
  const again = add(1);
  assert.equal(hidden.at(-1)[0], again, 'back on the feed, Facebook draws the same edge there again');
});

test('switched off, the drawn post comes back, and switched on it hides again', () => {
  const current = [];
  const posts = { on: () => () => {}, current: () => current };
  const element = { isConnected: true, getAttribute: () => '1' };
  current.push({ element });
  let on = true;
  let notify;
  const shown = [];
  let hides = 0;
  const hider = { hide: () => ++hides > 0, showAll: (reason) => shown.push(reason) };
  const onDrawn = hideDrawnPosts({ posts, hider, router: { current: () => GROUPS }, settings: { subscribe: (fn) => (notify = fn) }, enabled: () => on, reason: 'AI-labeled', schedule: () => 0, cancel: () => {} });

  onDrawn([{ place: 1, signal: 'genai_label' }]);
  assert.equal(hides, 1);
  on = false;
  notify();
  assert.deepEqual(shown, ['AI-labeled']);
  on = true;
  notify();
  assert.equal(hides, 2);
});
