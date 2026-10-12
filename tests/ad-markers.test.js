// Fixtures here are synthetic. The first set follows uBlock Origin's old Facebook rules;
// the 2026 set copies the field names and shapes of the 2026-10-10 live capture, with
// every id, name and token replaced. tests/captured.test.js runs the same table against
// scrubbed captures.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AD_MARKERS, AD_MARKER_TEXT, adMarkerFor, adRule, FEEDS, hasAiLabel, hasSponsoredLabel, inScope, markersFor, pruneAds } from '../src/features/feed/ad-markers.js';
import { parseRoute } from '../src/core/route.js';
import { features } from '../src/features/index.js';
import { rulesFor, transformDocumentLine } from '../src/core/net/payload.js';

const rule = { id: 'hideSponsoredPosts', markers: AD_MARKER_TEXT, transform: (doc) => pruneAds(doc).length > 0 };

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
const labelOnly = () => {
  const edge = edge2026('ad', {}, { comet_sections: { context_layout: { story: { comet_sections: { metadata: [adLabel] } } } } });
  delete edge.node.th_dat_spo;
  return edge;
};

// The title section of a story, where the Follow and Join buttons live (2026-10-11 capture).
const titled = (id, title) => edge2026(id, {}, { comet_sections: { context_layout: { story: { comet_sections: { title } } } } });
const followTitle = { __typename: 'CometFeedStoryTitleWithActorStrategy', story: { comet_sections: { follow_button: { __typename: 'CometFeedStoryFollowButtonStrategy' } } } };
const joinTitle = { __typename: 'CometFeedStoryCommunityAttributionTitleStrategy', if_viewer_can_join_group: { join_action: { __typename: 'GroupJoinForumAction' } } };

// The AI label section as captured on 2026-10-11, in the story's header metadata.
const aiLabel = (detected = true, disclosed = false) => ({
  __typename: 'CometFeedStoryGenAIContentTransparencyStrategy',
  is_prod_eligible: true,
  was_detected_as_ai_generated: detected,
  was_self_disclosed_as_ai_generated: disclosed,
  ai_generated_detected_info: detected ? { gen_ai_transparency_type: 'PROVENANCE_DETECTED_CREATED' } : null,
});
const labeled = (id, label = aiLabel()) => edge2026(id, {}, { comet_sections: { context_layout: { story: { comet_sections: { metadata: [{ __typename: 'CometFeedStoryMinimizedTimestampStrategy' }, label] } } } } });

// One edge per row, caught by that row before any other.
const SAMPLES = {
  category: () => ({ category: 'SPONSORED', node: { __typename: 'Story', id: 'ad' }, cursor: 'c' }),
  cat_sensitive: () => edge2026('ad', { cat_sensitive: { enc: 'e'.repeat(64), cat: 'SPONSORED' } }),
  sponsored_data: () => ({ node: { __typename: 'Story', id: 'ad', sponsored_data: { ad_id: '1' } }, cursor: 'c' }),
  th_dat_spo: () => edge2026('ad', {}, { th_dat_spo: { is_demo_ad: false } }),
  'sponsored label': labelOnly,
  MarketplaceFeedAdStory: () => ({ node: { __typename: 'MarketplaceFeedAdStory', id: 'ad', ad_id_string: '1' }, cursor: 'm' }),
  SEARCH_ADS: () => ({ cursor: 's', node: { __typename: 'SearchRenderable', role: 'SEARCH_ADS' }, rendering_strategy: { __typename: 'SearchResultsAdRenderingStrategy' } }),
  // The shape is the live empty answer (tests/fixtures/useInstreamAdsHaloFetcherQuery.jsonl) with one break in it.
  instream_video_ad_breaks: () => ({ instream_video_ad_breaks: [{ id: 'break-1', start_time_ms: 30000 }], post_roll_ad_break: { id: 'post-roll' } }),
  // The schedule a video part carries (tests/fixtures/video-ad-breaks.jsonl).
  instream_video_ad_breaks_comet: () => ({
    id: 'v1',
    instream_extra_config: { instream_halo_delay_time_seconds: 16 },
    instream_video_ad_breaks_comet: { mid_rolls: [{ index: 0, instream_placement: 'MID_ROLL', time_offset_in_ms: 60000 }], pre_roll: null },
  }),
  reels_showcase: () => ({
    __typename: 'ShowcaseFeedUnit', showcase_story_type: 'SHOWCASE_SHORT_VIDEO',
    showcase_item: [{ id: 'reel-1', attachment: { __typename: 'ShowcaseShortVideoAttachment' } }],
  }),
  follow_button: () => titled('suggested', followTitle),
  group_join: () => titled('suggested', joinTitle),
  genai_label: () => labeled('ai'),
};

test('every row says where it was seen, what lets it past the prefilter and what it does', () => {
  const ids = AD_MARKERS.map((row) => row.id);
  const switches = new Set(features.map((feature) => feature.id));
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const row of AD_MARKERS) {
    assert.ok(row.surface && row.seen, `${row.id} names its surface and live check`);
    assert.ok(switches.has(row.feature), `${row.id} belongs to a real switch`);
    assert.ok(row.text.length > 0 && row.text.every((text) => AD_MARKER_TEXT.includes(text)), `${row.id} has prefilter text`);
    assert.equal(typeof row.match, 'function');
    assert.ok(['drop-node', 'empty-list'].includes(row.action), `${row.id} has a known action`);
    if (row.action === 'empty-list') assert.equal(row.kind, 'object', `${row.id}: empty-list works on objects`);
  }
});

test('a row only fires under its own switch', () => {
  const doc = () => ({ data: { serpResponse: { results: { edges: [SAMPLES.SEARCH_ADS()] } }, news_feed: { edges: [SAMPLES.th_dat_spo()] } } });
  assert.deepEqual(pruneAds(doc(), markersFor('hideSponsoredSearch').rows), ['SEARCH_ADS']);
  assert.deepEqual(pruneAds(doc(), markersFor('hideSponsoredPosts').rows), ['th_dat_spo']);
  assert.deepEqual(markersFor('hideSponsoredMarketplace').text, ['"MarketplaceFeedAdStory"']);
  const search = adRule('hideSponsoredSearch', () => true);
  const fired = [];
  const withReport = adRule('hideSponsoredPosts', () => true, (ids) => fired.push(...ids));
  const line = JSON.stringify(doc());
  assert.equal(rulesFor(line, [search]).length, 1);
  const out = JSON.parse(transformDocumentLine(line, [search, withReport]));
  assert.equal(out.data.serpResponse.results.edges[0].node, undefined);
  assert.equal(out.data.news_feed.edges[0].node, undefined);
  assert.deepEqual(fired, ['th_dat_spo']);
  assert.equal(search.match({ transport: 'xhr', path: '/api/graphql/' }), true);
  assert.equal(search.match({ transport: 'xhr', path: '/ajax/bz' }), false);
});

test('in-stream ad breaks are emptied to what Facebook sends when there are none', () => {
  const answer = { data: { scrubber: SAMPLES.instream_video_ad_breaks() }, extensions: { is_final: true } };
  assert.deepEqual(pruneAds(answer), ['instream_video_ad_breaks']);
  assert.deepEqual(answer.data.scrubber, { instream_video_ad_breaks: [], post_roll_ad_break: null });
  const onlyPostRoll = { scrubber: { instream_video_ad_breaks: [], post_roll_ad_break: { id: 'p' } } };
  assert.deepEqual(pruneAds(onlyPostRoll), ['instream_video_ad_breaks']);
  assert.equal(onlyPostRoll.scrubber.post_roll_ad_break, null);
  const none = { scrubber: { instream_video_ad_breaks: [], post_roll_ad_break: null } };
  assert.deepEqual(pruneAds(none), []);
  // Half the pair isn't the answer's shape, so it's left alone.
  const half = { scrubber: { instream_video_ad_breaks: [{ id: 'break-1' }] } };
  assert.deepEqual(pruneAds(half), []);
  assert.equal(half.scrubber.instream_video_ad_breaks.length, 1);
});

test('the ads fetched for a break are only emptied in the answer that fetches them', () => {
  const reels = adRule('hideSponsoredReels', () => true);
  const line = JSON.stringify({ data: { scrubber: SAMPLES.instream_video_ad_breaks() } });
  const ctx = (friendlyName) => ({ transport: 'xhr', path: '/api/graphql/', friendlyName });
  const own = JSON.parse(transformDocumentLine(line, [reels], ctx('useInstreamAdsHaloFetcherQuery')));
  assert.deepEqual(own.data.scrubber, { instream_video_ad_breaks: [], post_roll_ad_break: null });
  assert.equal(transformDocumentLine(line, [reels], ctx('FBUnifiedVideoContainerQuery')), line, 'another answer with the same keys is left alone');
  assert.equal(transformDocumentLine(line, [reels], { transport: 'json-parse', friendlyName: '' }), line, 'never in inline page data');
});

test('a video ad break schedule is set to what Facebook sends for a video without breaks', () => {
  const reels = adRule('hideSponsoredReels', () => true);
  const doc = { label: 'x', path: ['viewer', 'news_feed', 'edges', 2, 'node'], data: SAMPLES.instream_video_ad_breaks_comet() };
  const line = JSON.stringify(doc);
  for (const ctx of [{ transport: 'json-parse', friendlyName: '' }, { transport: 'fetch', path: '/api/graphql/', friendlyName: 'FBUnifiedVideoContainerQuery' }]) {
    const out = JSON.parse(transformDocumentLine(line, [reels], ctx));
    assert.deepEqual(out.data, { id: 'v1', instream_extra_config: { instream_halo_delay_time_seconds: 16 }, instream_video_ad_breaks_comet: null }, ctx.transport);
    assert.deepEqual(out.path, doc.path);
  }
  // A schedule with neither part is some other object of the same name, and stays.
  const other = { instream_video_ad_breaks_comet: { __dr: 'InstreamVideoAdBreaksPlayerImpl_adBreaks$normalization.graphql' } };
  assert.deepEqual(pruneAds(structuredClone(other)), []);
});

test('every row has a sample, and its line gets past the prefilter and is pruned by that row', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), AD_MARKERS.map((row) => row.id).sort());
  for (const row of AD_MARKERS) {
    if (row.action !== 'drop-node') continue;
    const edge = SAMPLES[row.id]();
    assert.equal(adMarkerFor(edge)?.id, row.id, `${row.id} catches its own sample first`);
    const line = JSON.stringify({ data: { viewer: { news_feed: { edges: [edge2026('o1'), edge] } } } });
    assert.ok(row.text.some((text) => line.includes(text)), `${row.id}: its own text is in the line`);
    assert.equal(rulesFor(line, [rule]).length, 1, `${row.id}: the line isn't skipped`);
    const out = JSON.parse(transformDocumentLine(line, [rule]));
    const [kept, pruned] = out.data.viewer.news_feed.edges;
    assert.equal(kept.node.id, 'o1');
    assert.equal('node' in pruned || 'rendering_strategy' in pruned, false, `${row.id}: what Facebook draws from is gone`);
    assert.equal(pruned.cursor, edge.cursor, `${row.id}: the cursor stays`);
  }
});

test('sponsored edges lose their node but keep their cursor', () => {
  const doc = feed();
  assert.deepEqual(pruneAds(doc), ['category', 'sponsored_data']);
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
  assert.deepEqual(pruneAds(doc), []);
  assert.deepEqual(doc, before);
});

test('streamed @stream chunks are pruned too', () => {
  const chunk = { label: 'CometNewsFeed_viewer$stream$CometNewsFeed_viewer_news_feed', path: ['viewer', 'news_feed', 'edges', 4], data: { category: 'SPONSORED', node: { id: 'ad' }, cursor: 'e' } };
  assert.deepEqual(pruneAds(chunk), ['category']);
  assert.deepEqual(chunk.data, { category: 'SPONSORED', cursor: 'e' });
});

test('inline page data (ScheduledServerJS / RelayPrefetchedStreamCache) is reached', () => {
  const inline = { require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { require: [['RelayPrefetchedStreamCache', 'next', [], ['id', { __bbox: { result: feed() } }]]] } }]]] };
  assert.deepEqual(pruneAds(inline), ['category', 'sponsored_data']);
  const edges = inline.require[0][3][0].__bbox.require[0][3][1].__bbox.result.data.viewer.news_feed.edges;
  assert.equal(edges.filter((edge) => edge.node).length, 2);
});

test('adMarkerFor rejects things that are not edges', () => {
  assert.equal(adMarkerFor(null), null);
  assert.equal(adMarkerFor([]), null);
  assert.equal(adMarkerFor({ category: 'SPONSORED' }), null);
  assert.equal(adMarkerFor({ node: null }), null);
  assert.equal(adMarkerFor({ node: { sponsored_data: null } }), null);
  assert.equal(adMarkerFor({ node: null, category: 'SPONSORED' })?.id, 'category');
});

test('2026 feed: organic edges with the renamed fields set to null are kept', () => {
  const doc = { data: { viewer: { news_feed: { edges: [edge2026('o1'), edge2026('o2')] } } } };
  const before = structuredClone(doc);
  assert.deepEqual(pruneAds(doc), []);
  assert.deepEqual(doc, before);
});

test('2026 feed: the sponsored label section marks an ad even when field names change again', () => {
  const doc = { data: { viewer: { news_feed: { edges: [edge2026('o1'), labelOnly()] } } } };
  assert.deepEqual(pruneAds(doc), ['sponsored label']);
  assert.deepEqual(doc.data.viewer.news_feed.edges.map((e) => e.node?.id ?? null), ['o1', null]);
});

test('a friend sharing an ad is not an ad', () => {
  const share = edge2026('share', {}, { attached_story: { __typename: 'Story', id: 'shared-ad', comet_sections: adLabel } });
  assert.equal(hasSponsoredLabel(share.node), false);
  assert.equal(adMarkerFor(share), null);
});

test('a page wrapper holding an ad deep inside keeps its node', () => {
  const group = { data: { node: { __typename: 'Group', group_feed: { edges: [edge2026('g1'), edge2026('g-ad', {}, { comet_sections: adLabel })] } } } };
  assert.equal(adMarkerFor(group.data), null);
  assert.deepEqual(pruneAds(group), ['sponsored label']);
  assert.equal(group.data.node.__typename, 'Group');
  assert.deepEqual(group.data.node.group_feed.edges.map((e) => e.node?.id ?? null), ['g1', null]);
});

test('Marketplace ad cards go, listings stay', () => {
  const doc = { data: { viewer: { marketplace_feed_stories: { edges: [
    { node: { __typename: 'MarketplaceFeedGeneralListingObject', id: 'l1' }, cursor: 'm1' },
    { node: { __typename: 'MarketplaceFeedAdStory', id: 'ad', ad_id_string: '1', ad_impression_client_token: 'x' }, cursor: 'm2' },
  ] } } } };
  assert.deepEqual(pruneAds(doc), ['MarketplaceFeedAdStory']);
  assert.deepEqual(doc.data.viewer.marketplace_feed_stories.edges.map((e) => e.node?.id ?? null), ['l1', null]);
});

test('search ads go with the story beside their node, other search modules stay', () => {
  // Live shape 2026-10-10: the ad's story sits in rendering_strategy, next to node, not in it.
  const post = (role) => ({ cursor: role, logging_unit_id: 'u', node: { __typename: 'SearchRenderable', role }, rendering_strategy: { __typename: 'SearchRichPostRenderingStrategy', click_model: {} } });
  const ad = {
    cursor: 'ad', logging_unit_id: 'u', node: { __typename: 'SearchRenderable', role: 'SEARCH_ADS' },
    rendering_strategy: { __typename: 'SearchResultsAdRenderingStrategy', view_model: { story: { th_dat_spo: { x: 1 }, comet_sections: adLabel } } },
  };
  const doc = { data: { serpResponse: { results: { edges: [post('FEED_POSTS'), ad, post('POST_SILVER_TORCH')] } } } };
  assert.deepEqual(pruneAds(doc), ['SEARCH_ADS']);
  const edges = doc.data.serpResponse.results.edges;
  assert.deepEqual(edges.map((e) => e.node?.role ?? null), ['FEED_POSTS', null, 'POST_SILVER_TORCH']);
  assert.deepEqual(edges[1], { cursor: 'ad', logging_unit_id: 'u' });
  assert.equal(edges[0].rendering_strategy.__typename, 'SearchRichPostRenderingStrategy');
  assert.doesNotMatch(JSON.stringify(doc), /th_dat_spo|CometStorySponsoredLabelStrategy/);
});

test('markers: a 2026 ad line is picked up, an organic line with null ad fields is not', () => {
  const organic = JSON.stringify({ data: { viewer: { news_feed: { edges: [edge2026('o1')] } } } });
  const ad = JSON.stringify({ data: { viewer: { news_feed: { edges: [SAMPLES.th_dat_spo()] } } } });
  assert.equal(rulesFor(organic, [rule]).length, 0);
  assert.equal(rulesFor(ad, [rule]).length, 1);
});

test('the network rule prunes a GraphQL line end to end', () => {
  const out = JSON.parse(transformDocumentLine(JSON.stringify(feed()), [rule]));
  assert.deepEqual(out.data.viewer.news_feed.edges.map((edge) => edge.node?.id ?? null), ['organic-1', null, 'organic-2', null]);
});

test('suggested posts go only on Home and the groups feed, never in search or on a Page', () => {
  const answer = () => ({ data: { viewer: { news_feed: { edges: [edge2026('friend'), SAMPLES.follow_button(), SAMPLES.group_join()] } } } });
  const fired = [];
  const route = { current: parseRoute('https://www.facebook.com/') };
  const suggested = adRule('hideSuggestedPosts', () => true, (ids) => fired.push(...ids), { route: () => route.current });
  const kept = (doc) => doc.data.viewer.news_feed.edges.map((edge) => edge.node?.id ?? null);
  const run = (ctx) => {
    const doc = answer();
    suggested.transform(doc, ctx);
    return kept(doc);
  };
  const query = (friendlyName) => ({ transport: 'xhr', path: '/api/graphql/', friendlyName });
  assert.deepEqual(run(query('CometNewsFeedPaginationQuery')), ['friend', null, null]);
  assert.deepEqual(run(query('GroupsCometCrossGroupFeedPaginationQuery')), ['friend', null, null]);
  for (const name of ['SearchCometResultsPaginatedResultsQuery', 'ProfileCometTimelineFeedRefetchQuery', 'GroupsCometFeedRegularStoriesPaginationQuery', '']) {
    assert.deepEqual(run(query(name)), ['friend', 'suggested', 'suggested'], name || 'no name');
  }
  const inline = { transport: 'json-parse', path: '', friendlyName: '' };
  assert.deepEqual(run(inline), ['friend', null, null], 'inline data on Home');
  for (const [href, expected] of [['/groups/feed/', null], ['/groups/123/', 'suggested'], ['/search/top/?q=x', 'suggested'], ['/somepage', 'suggested'], ['/home.php', null]]) {
    route.current = parseRoute(`https://www.facebook.com${href}`);
    assert.equal(run(inline)[1], expected, href);
  }
  assert.deepEqual(fired.slice(0, 2), ['follow_button', 'group_join']);
  assert.equal(inScope({ scope: FEEDS }, inline, null), false, 'no router, no inline pruning');
  assert.equal(inScope({}, query('anything'), null), true, 'a row without a scope runs everywhere');
});

test("a friend sharing a suggested Page's post is not a suggestion", () => {
  const share = edge2026('share', {}, { attached_story: titled('page-post', followTitle).node });
  assert.equal(adMarkerFor(share), null);
  assert.equal(adMarkerFor(titled('page-post', followTitle))?.id, 'follow_button', 'the same post on its own is one');
});

test('a Follow or Join button outside the title is not a suggestion', () => {
  const plainTitle = { __typename: 'CometFeedStoryTitleWithActorStrategy', story: { comet_sections: {} } };
  const elsewhere = (button) => edge2026('friend', {}, { comet_sections: {
    context_layout: { story: { comet_sections: { title: plainTitle } } },
    content: { story: { comet_sections: { attached_story_layout: { story: { button } } } } },
  } });
  assert.equal(adMarkerFor(elsewhere(followTitle.story.comet_sections.follow_button)), null);
  assert.equal(adMarkerFor(elsewhere(joinTitle.if_viewer_can_join_group.join_action)), null);
});

test('a post labeled as made with AI goes, whether Facebook detected it or the author said so', () => {
  assert.equal(adMarkerFor(labeled('ai'))?.id, 'genai_label');
  assert.equal(adMarkerFor(labeled('ai', aiLabel(false, true)))?.id, 'genai_label', 'disclosed by the author');
  assert.equal(adMarkerFor(labeled('plain', aiLabel(false, false))), null, 'a label section that says no');
  assert.equal(hasAiLabel(null), false);

  const share = edge2026('share', {}, { comet_sections: { content: { story: { attached_story: labeled('original').node } } } });
  assert.equal(adMarkerFor(share)?.id, 'genai_label', 'a share of a labeled post');

  // A search result keeps its story behind the result, as in the 2026-10-11 capture.
  const result = { cursor: 'r', node: { __typename: 'SearchRenderable', role: 'TOP_PUBLIC_POSTS' }, rendering_strategy: { view_model: { click_model: { story: labeled('found').node } } } };
  assert.equal(adMarkerFor(result)?.id, 'genai_label');
  const organic = { cursor: 'o', node: { __typename: 'SearchRenderable', role: 'TOP_PUBLIC_POSTS' }, rendering_strategy: { view_model: { click_model: { story: edge2026('fine').node } } } };
  assert.equal(adMarkerFor(organic), null);
});

test('AI-labeled posts go from the feeds and search, never from a post opened by its link or a profile', () => {
  const route = { current: parseRoute('https://www.facebook.com/') };
  const fired = [];
  const rule = adRule('hideAiPosts', () => true, (ids) => fired.push(...ids), { route: () => route.current });
  const run = (ctx) => {
    const doc = { data: { edges: [edge2026('fine'), labeled('ai')] } };
    rule.transform(doc, ctx);
    return doc.data.edges.map((edge) => edge.node?.id ?? null);
  };
  const query = (friendlyName) => ({ transport: 'xhr', path: '/api/graphql/', friendlyName });
  for (const name of ['CometNewsFeedPaginationQuery', 'GroupsCometCrossGroupFeedPaginationQuery', 'SearchCometResultsPaginatedResultsQuery']) {
    assert.deepEqual(run(query(name)), ['fine', null], name);
  }
  for (const name of ['ProfileCometTimelineFeedRefetchQuery', 'GroupsCometFeedRegularStoriesPaginationQuery', 'CometSinglePostDialogContentQuery', '']) {
    assert.deepEqual(run(query(name)), ['fine', 'ai'], name || 'no name');
  }
  const inline = { transport: 'json-parse', path: '', friendlyName: '' };
  for (const [href, expected] of [['/', null], ['/groups/feed/', null], ['/search/top/?q=x', null], ['/someone/posts/pfbid0P1', 'ai'], ['/groups/123/posts/456/', 'ai'], ['/someone', 'ai']]) {
    route.current = parseRoute(`https://www.facebook.com${href}`);
    assert.equal(run(inline)[1], expected, href);
  }
  assert.ok(fired.length > 0 && fired.every((id) => id === 'genai_label'));
});
