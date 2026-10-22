// Every marker the feed cleanup switches act on (ads, posts Facebook suggests, and posts it
// labels as made with AI), one row each.
//
//   id       a short name for tests and Diagnostics
//   feature  the switch that turns it on (one per surface, as on Android)
//   surface  where Facebook sends it
//   seen     the live check behind the row, or "not yet" for a shape kept from older captures
//   text     strings that let a response line past the cheap prefilter (rulesFor in payload.js).
//            A line carrying none of them is never parsed for this rule.
//   kind     edge (default): match gets (edge, node) for objects with a node key, node may be
//            null. object: match gets any object.
//   match    whether this value is one to remove
//   scope    optional: which answers the row may touch. Without one, every GraphQL answer and
//            inline page blob. queries: GraphQL friendly names. routes: page types (route.js)
//            for inline page data, which has no name.
//   action   what happens to a match:
//              drop-node   the edge keeps its cursor and every other key, so paging still works,
//                          and loses node and rendering_strategy, which is what Facebook draws
//                          from (uBlock Origin's old approach; a search ad keeps its story in
//                          rendering_strategy, beside the node)
//              empty-list  the row's `empty` keys are set to what Facebook sends when there's
//                          nothing to show
//              drop-items  the row's `list` key keeps only the items `drop` says no to, in
//                          order, so one box leaves a list of boxes and the rest stay
//
// Facebook renames ad fields per relay provider (GHLShouldChangeSponsoredDataFieldName and
// friends were on in the 2026-10-10 capture): sponsored_data arrives as th_dat_spo and the
// edge category is hashed into cat_sensitive {enc, cat: null}. Field names rotate, typenames
// don't, so the label section's typename is the row that lasts.

import { walk, SKIP } from '../../core/json-walk.js';
import { later } from '../../core/net/payload.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const LABEL_TYPENAME = 'CometStorySponsoredLabelStrategy';
const FOLLOW_TYPENAME = 'CometFeedStoryFollowButtonStrategy';
const JOIN_TYPENAME = 'GroupJoinForumAction';

// Looks for a value inside one story. Nested edges and a shared post's attached story speak
// for themselves, so a friend's share of an ad or a group page holding an ad doesn't count
// as an ad. A share carries its post more than once (the story's own attached_story, another
// under content.story, and the section that draws it), so every attached_story is left out,
// however deep.
export function storyMatches(node, test) {
  let found = false;
  const shared = new Set();
  walk(node, (value) => {
    if (found || shared.has(value)) return SKIP;
    if (value !== node && 'node' in value && 'cursor' in value) return SKIP;
    if (isObject(value.attached_story)) shared.add(value.attached_story);
    if (test(value)) found = true;
    return undefined;
  });
  return found;
}

export const storyHas = (node, typename) => storyMatches(node, (value) => value.__typename === typename);

export const hasSponsoredLabel = (node) => storyHas(node, LABEL_TYPENAME);

// The Follow and Join buttons that mark a suggestion sit in the story's title, next to the
// author's name. Elsewhere in a story (a shared post's layout, a group you're in) they mean
// something else. When Facebook moves the title, the whole story is searched instead.
export function titleHas(node, typename) {
  const title = node?.comet_sections?.context_layout?.story?.comet_sections?.title;
  return isObject(title) ? storyHas(title, typename) : storyHas(node, typename);
}

// Home and the groups feed, where Facebook mixes in what you don't follow. Search results,
// a Page's own timeline and a group you're browsing carry the same Follow and Join buttons,
// so the suggestion rows stay off there.
export const FEEDS = {
  queries: /^(?:CometNewsFeedPaginationQuery|GroupsCometCrossGroupFeedPaginationQuery)$/,
  routes: (route) => route?.type === 'home' || /^\/groups\/feed\/?$/.test(route?.path ?? ''),
};

// The feeds plus search results: everywhere posts come from all over. A post opened from its
// link, a profile and a group you're browsing aren't included.
export const FEEDS_AND_SEARCH = {
  queries: /^(?:CometNewsFeedPaginationQuery|GroupsCometCrossGroupFeedPaginationQuery|SearchCometResultsPaginatedResultsQuery)$/,
  routes: (route) => FEEDS.routes(route) || route?.type === 'search',
};

// The answer that fetches the ads for a video's breaks. It has never come inline with a page.
export const INSTREAM_ADS = {
  queries: /^useInstreamAdsHaloFetcherQuery$/,
  routes: () => false,
};

// Facebook's AI label, a section of the story's header (live 2026-10-11, all 5 labeled
// stories on Home, the groups feed and search): {__typename: GENAI_TYPENAME,
// was_detected_as_ai_generated: true, was_self_disclosed_as_ai_generated: false,
// ai_generated_detected_info: {gen_ai_transparency_type: 'PROVENANCE_DETECTED_CREATED'}}.
// It only counts when it says the post was made with AI, either way.
const GENAI_TYPENAME = 'CometFeedStoryGenAIContentTransparencyStrategy';
const isAiLabel = (value) => isObject(value) && value.__typename === GENAI_TYPENAME
  && (value.was_detected_as_ai_generated === true
    || value.was_self_disclosed_as_ai_generated === true
    || Boolean(value.ai_generated_detected_info?.gen_ai_transparency_type));

// A story carrying the label in its header, or a share of one. When Facebook moves the
// header, the whole story is searched instead.
export function hasAiLabel(story) {
  if (!isObject(story)) return false;
  const metadata = story.comet_sections?.context_layout?.story?.comet_sections?.metadata;
  const own = Array.isArray(metadata) ? metadata.some(isAiLabel) : storyMatches(story, isAiLabel);
  if (own) return true;
  const shared = story.comet_sections?.content?.story?.attached_story ?? story.attached_story;
  return shared !== story && isObject(shared) && hasAiLabel(shared);
}

// Home's right column (live 2026-10-21): viewer.auxColumnUnits.nodes lists its boxes in order,
// an AdsSideFeedUnit for the Sponsored box (its ads under item_collection.nodes[].rhc_ad) and
// a FriendingRequestsSideFeedUnit for Friend requests. Without the ad unit in the list Facebook
// draws the column the way it does for someone it has no ads for.
const SIDE_AD_TYPENAME = 'AdsSideFeedUnit';
const isSideAdUnit = (value) => isObject(value) && value.__typename === SIDE_AD_TYPENAME;

// The story an edge draws: its node in a feed, or the story behind a search result.
const storyOf = (edge, node) => (isObject(node) && node.__typename === 'Story'
  ? node
  : edge.rendering_strategy?.view_model?.click_model?.story ?? edge.rendering_strategy?.view_model?.story ?? null);

export const AD_MARKERS = [
  {
    id: 'category',
    feature: 'hideSponsoredPosts',
    surface: 'news feed (older shape)',
    seen: 'not yet',
    text: ['"SPONSORED"'],
    match: (edge) => edge.category === 'SPONSORED',
    action: 'drop-node',
  },
  {
    id: 'cat_sensitive',
    feature: 'hideSponsoredPosts',
    surface: 'news feed',
    seen: '2026-10-10: on every feed edge, cat null on organic stories',
    text: ['"SPONSORED"'],
    match: (edge) => isObject(edge.cat_sensitive) && edge.cat_sensitive.cat === 'SPONSORED',
    action: 'drop-node',
  },
  {
    id: 'sponsored_data',
    feature: 'hideSponsoredPosts',
    surface: 'news feed (older shape)',
    seen: 'not yet',
    text: ['"sponsored_data":{'],
    match: (edge, node) => isObject(node) && node.sponsored_data != null,
    action: 'drop-node',
  },
  {
    id: 'th_dat_spo',
    feature: 'hideSponsoredPosts',
    surface: 'news feed',
    seen: '2026-10-10: null on every organic feed story, set inside a search ad',
    text: ['"th_dat_spo":{'],
    match: (edge, node) => isObject(node) && node.th_dat_spo != null,
    action: 'drop-node',
  },
  {
    id: 'sponsored label',
    feature: 'hideSponsoredPosts',
    surface: 'news feed',
    seen: '2026-10-10: the "Ad" label section of a search ad',
    text: [`"${LABEL_TYPENAME}"`],
    // Only on real edges (with a cursor): a wrapper holding an ad deep inside isn't an ad.
    match: (edge, node) => isObject(node) && 'cursor' in edge && hasSponsoredLabel(node),
    action: 'drop-node',
  },
  {
    id: 'AdsSideFeedUnit',
    feature: 'hideSponsoredPosts',
    surface: "Home's right column (the Sponsored box)",
    seen: '2026-10-21: inline CometRightSideHeaderCardsQuery data on every Home load, the Sponsored box first in viewer.auxColumnUnits.nodes with two ads, Friend requests after it',
    text: [`"${SIDE_AD_TYPENAME}"`],
    kind: 'object',
    match: (value) => Array.isArray(value.nodes) && value.nodes.some(isSideAdUnit),
    action: 'drop-items',
    list: 'nodes',
    drop: isSideAdUnit,
  },
  {
    id: 'MarketplaceFeedAdStory',
    feature: 'hideSponsoredMarketplace',
    surface: 'Marketplace',
    seen: '2026-10-10: 8 ad cards pruned in the page, grid intact',
    text: ['"MarketplaceFeedAdStory"'],
    match: (edge, node) => isObject(node) && node.__typename === 'MarketplaceFeedAdStory',
    action: 'drop-node',
  },
  {
    id: 'SEARCH_ADS',
    feature: 'hideSponsoredSearch',
    surface: 'search results',
    seen: '2026-10-10: the ad result pruned with its story',
    text: ['"SEARCH_ADS"'],
    match: (edge, node) => isObject(node) && node.role === 'SEARCH_ADS',
    action: 'drop-node',
  },
  {
    id: 'instream_video_ad_breaks_comet',
    feature: 'hideSponsoredReels',
    surface: 'videos and reels in the feed, search, Marketplace and video pages (the ad break schedule)',
    seen: '2026-10-10: each video part comes as {id, instream_extra_config, instream_video_ad_breaks_comet}, in feed pages, video containers, Marketplace, search and inline page data; filled with MID_ROLL breaks (60 s, 120 s) on longer videos and null on the rest',
    text: ['"instream_video_ad_breaks_comet":{'],
    kind: 'object',
    match: (value) => {
      const schedule = value.instream_video_ad_breaks_comet;
      return isObject(schedule) && ('mid_rolls' in schedule || 'pre_roll' in schedule);
    },
    action: 'empty-list',
    empty: { instream_video_ad_breaks_comet: null },
  },
  {
    id: 'instream_video_ad_breaks',
    feature: 'hideSponsoredReels',
    surface: 'videos and reels (the ads fetched for a break)',
    seen: '2026-10-11: useInstreamAdsHaloFetcherQuery sent {scrubber: {instream_video_ad_breaks: [], post_roll_ad_break: null}} for all 31 videos and reels the test account opened; a filled answer not seen yet. Both keys only ever came in that answer',
    text: ['"instream_video_ad_breaks":[{', '"post_roll_ad_break":{'],
    scope: INSTREAM_ADS,
    kind: 'object',
    match: (value) => 'instream_video_ad_breaks' in value && 'post_roll_ad_break' in value
      && ((Array.isArray(value.instream_video_ad_breaks) && value.instream_video_ad_breaks.length > 0) || isObject(value.post_roll_ad_break)),
    action: 'empty-list',
    empty: { instream_video_ad_breaks: [], post_roll_ad_break: null },
  },
  {
    id: 'reels_showcase',
    feature: 'hideReelsInFeed',
    surface: 'news feed and groups feed (rows of reels)',
    seen: '2026-10-11: a Home inline Relay response carries a ShowcaseFeedUnit with SHOWCASE_SHORT_VIDEO and six ShowcaseShortVideoAttachment items; its page markup has not been captured',
    text: ['"ShowcaseFeedUnit"'],
    scope: FEEDS,
    kind: 'object',
    match: (value) => value.__typename === 'ShowcaseFeedUnit' && value.showcase_story_type === 'SHOWCASE_SHORT_VIDEO'
      && Array.isArray(value.showcase_item) && value.showcase_item.length > 0,
    action: 'empty-list',
    empty: { showcase_item: [] },
  },
  {
    id: 'follow_button',
    feature: 'hideSuggestedPosts',
    surface: "news feed and groups feed (Pages and people you don't follow)",
    seen: '2026-10-11: 36 of 137 captured Home stories, always in the title section, drawn as "Name · Follow"',
    text: [`"${FOLLOW_TYPENAME}"`],
    scope: FEEDS,
    match: (edge, node) => isObject(node) && 'cursor' in edge && titleHas(node, FOLLOW_TYPENAME),
    action: 'drop-node',
  },
  {
    id: 'group_join',
    feature: 'hideSuggestedPosts',
    surface: "news feed and groups feed (groups you aren't in)",
    seen: '2026-10-11: 17 of 137 captured Home stories, always in the title section, drawn as "Group · Join"',
    text: [`"${JOIN_TYPENAME}"`],
    scope: FEEDS,
    match: (edge, node) => isObject(node) && 'cursor' in edge && titleHas(node, JOIN_TYPENAME),
    action: 'drop-node',
  },
  {
    id: 'genai_label',
    feature: 'hideAiPosts',
    surface: 'news feed, groups feed and search results (posts labeled as made with AI)',
    seen: '2026-10-11: 5 labeled stories, 1 on Home, 1 in the groups feed and 3 in search results, all detected rather than disclosed',
    text: [`"${GENAI_TYPENAME}"`],
    scope: FEEDS_AND_SEARCH,
    match: (edge, node) => 'cursor' in edge && hasAiLabel(storyOf(edge, node)),
    action: 'drop-node',
  },
];

const DROPPED_BY = { 'drop-node': ['node', 'rendering_strategy'] };

const textOf = (rows) => [...new Set(rows.flatMap((row) => row.text))];

// The prefilter strings for every row, once each.
export const AD_MARKER_TEXT = textOf(AD_MARKERS);

// The rows one switch owns, and their prefilter strings.
export function markersFor(feature) {
  const rows = AD_MARKERS.filter((row) => row.feature === feature);
  return { rows, text: textOf(rows) };
}

// The first row that says this value is an ad, or null.
export function adMarkerFor(value, rows = AD_MARKERS) {
  if (!isObject(value)) return null;
  const edge = 'node' in value;
  return rows.find((row) => ((row.kind ?? 'edge') === 'edge' ? edge && row.match(value, value.node) : row.match(value))) ?? null;
}

// Whether a row may touch this answer. route() is the page the inline data arrived on.
export function inScope(row, ctx, route) {
  if (!row.scope) return true;
  if (ctx?.transport === 'json-parse') return Boolean(route && row.scope.routes(route()));
  return row.scope.queries.test(ctx?.friendlyName ?? '');
}

// The id a match is known by: the story's for an edge, the object's own otherwise.
export const matchId = (value) => value.node?.post_id ?? value.node?.id ?? value.id ?? null;

// The network rule for one switch: its rows, on every GraphQL answer and inline page blob
// their scope allows. onPrune gets the ids of the rows that fired. With diagnostics and a
// reason, each match goes on the Diagnostics decision list too. Both wait until the page gets
// the pruned answer, and the decision's id is read before the match is changed.
export function adRule(feature, enabled, onPrune, { route, diagnostics, reason } = {}) {
  const { rows, text } = markersFor(feature);
  const noting = Boolean(diagnostics && reason);
  return {
    id: feature,
    enabled,
    markers: text,
    match: (ctx) => ctx.transport === 'json-parse' || ctx.path.startsWith('/api/graphql'),
    transform(doc, ctx, stage) {
      const active = rows.filter((row) => inScope(row, ctx, route));
      if (!active.length) return false;
      const decisions = [];
      const report = noting ? (row, value) => decisions.push({ post: matchId(value), rule: reason, signal: row.id, layer: 'data' }) : undefined;
      const fired = pruneAds(doc, active, report);
      if (!fired.length) return false;
      later(stage, () => {
        for (const decision of decisions) diagnostics.decide(decision);
        onPrune?.(fired);
      });
      return true;
    },
  };
}

// Applies each matching row's action. Returns the ids of the rows that fired, one entry per
// match, so an empty list means nothing changed. report(row, value) hears each match before
// it's changed.
export function pruneAds(doc, rows = AD_MARKERS, report) {
  const fired = [];
  walk(doc, (value) => {
    const row = adMarkerFor(value, rows);
    if (!row) return undefined;
    report?.(row, value);
    if (row.action === 'empty-list') {
      for (const [key, empty] of Object.entries(row.empty)) if (key in value) value[key] = Array.isArray(empty) ? [] : empty;
    } else if (row.action === 'drop-items') {
      value[row.list] = value[row.list].filter((item) => !row.drop(item));
    } else {
      for (const key of DROPPED_BY[row.action]) delete value[key];
    }
    fired.push(row.id);
    return SKIP;
  });
  return fired;
}
