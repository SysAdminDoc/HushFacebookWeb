// Every ad marker Hide sponsored posts acts on, one row each.
//
//   id       a short name for tests and Diagnostics
//   feature  the switch that turns it on (one per surface, as on Android)
//   surface  where Facebook sends it
//   seen     the live check behind the row, or "not yet" for a shape kept from older captures
//   text     strings that let a response line past the cheap prefilter (rulesFor in payload.js).
//            A line carrying none of them is never parsed for this rule.
//   kind     edge (default): match gets (edge, node) for objects with a node key, node may be
//            null. object: match gets any object.
//   match    whether this value is an ad
//   action   what happens to a match:
//              drop-node   the edge keeps its cursor and every other key, so paging still works,
//                          and loses node and rendering_strategy, which is what Facebook draws
//                          from (uBlock Origin's old approach; a search ad keeps its story in
//                          rendering_strategy, beside the node)
//              empty-list  the row's `empty` keys are set to what Facebook sends when there's
//                          nothing to show
//
// Facebook renames ad fields per relay provider (GHLShouldChangeSponsoredDataFieldName and
// friends were on in the 2026-10-10 capture): sponsored_data arrives as th_dat_spo and the
// edge category is hashed into cat_sensitive {enc, cat: null}. Field names rotate, typenames
// don't, so the label section's typename is the row that lasts.

import { walk, SKIP } from '../../core/json-walk.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const LABEL_TYPENAME = 'CometStorySponsoredLabelStrategy';

// Looks for the ad label inside one story. Nested edges and a shared post's attached story
// speak for themselves, so a friend's share of an ad or a group page holding an ad doesn't
// count as an ad.
export function hasSponsoredLabel(node) {
  let found = false;
  walk(node, (value) => {
    if (found || value === node.attached_story) return SKIP;
    if (value !== node && 'node' in value && 'cursor' in value) return SKIP;
    if (value.__typename === LABEL_TYPENAME) found = true;
    return undefined;
  });
  return found;
}

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
    id: 'instream_video_ad_breaks',
    feature: 'hideSponsoredReels',
    surface: 'videos and reels (in-stream ad breaks)',
    seen: '2026-10-11: useInstreamAdsHaloFetcherQuery sent {scrubber: {instream_video_ad_breaks: [], post_roll_ad_break: null}} for all 31 videos and reels the test account opened; a filled answer not seen yet',
    text: ['"instream_video_ad_breaks":[{', '"post_roll_ad_break":{'],
    kind: 'object',
    match: (value) => (Array.isArray(value.instream_video_ad_breaks) && value.instream_video_ad_breaks.length > 0)
      || isObject(value.post_roll_ad_break),
    action: 'empty-list',
    empty: { instream_video_ad_breaks: [], post_roll_ad_break: null },
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

// The network rule for one switch: its rows, on every GraphQL answer and inline page blob.
// onPrune gets the ids of the rows that fired.
export function adRule(feature, enabled, onPrune) {
  const { rows, text } = markersFor(feature);
  return {
    id: feature,
    enabled,
    markers: text,
    match: (ctx) => ctx.transport === 'json-parse' || ctx.path.startsWith('/api/graphql'),
    transform(doc) {
      const fired = pruneAds(doc, rows);
      if (fired.length) onPrune?.(fired);
      return fired.length > 0;
    },
  };
}

// Applies each matching row's action. Returns the ids of the rows that fired, one entry per
// match, so an empty list means nothing changed.
export function pruneAds(doc, rows = AD_MARKERS) {
  const fired = [];
  walk(doc, (value) => {
    const row = adMarkerFor(value, rows);
    if (!row) return undefined;
    if (row.action === 'empty-list') {
      for (const [key, empty] of Object.entries(row.empty)) if (key in value) value[key] = Array.isArray(empty) ? [] : empty;
    } else {
      for (const key of DROPPED_BY[row.action]) delete value[key];
    }
    fired.push(row.id);
    return SKIP;
  });
  return fired;
}
