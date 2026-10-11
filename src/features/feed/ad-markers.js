// Every ad marker Hide sponsored posts acts on, one row each.
//
//   id       a short name for tests and Diagnostics
//   surface  where Facebook sends it
//   seen     the live check behind the row, or "not yet" for a shape kept from older captures
//   text     strings that let a response line past the cheap prefilter (rulesFor in payload.js).
//            A line carrying none of them is never parsed for this rule.
//   match    (edge, node) => whether this edge is an ad. edge has a node key, node may be null.
//   action   what happens to a matching edge:
//              drop-node  the edge keeps its cursor and every other key, so paging still works,
//                         and loses node and rendering_strategy, which is what Facebook draws
//                         from (uBlock Origin's old approach; a search ad keeps its story in
//                         rendering_strategy, beside the node)
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
    surface: 'news feed (older shape)',
    seen: 'not yet',
    text: ['"SPONSORED"'],
    match: (edge) => edge.category === 'SPONSORED',
    action: 'drop-node',
  },
  {
    id: 'cat_sensitive',
    surface: 'news feed',
    seen: '2026-10-10: on every feed edge, cat null on organic stories',
    text: ['"SPONSORED"'],
    match: (edge) => isObject(edge.cat_sensitive) && edge.cat_sensitive.cat === 'SPONSORED',
    action: 'drop-node',
  },
  {
    id: 'sponsored_data',
    surface: 'news feed (older shape)',
    seen: 'not yet',
    text: ['"sponsored_data":{'],
    match: (edge, node) => isObject(node) && node.sponsored_data != null,
    action: 'drop-node',
  },
  {
    id: 'th_dat_spo',
    surface: 'news feed, search',
    seen: '2026-10-10: null on every organic feed story, set inside a search ad',
    text: ['"th_dat_spo":{'],
    match: (edge, node) => isObject(node) && node.th_dat_spo != null,
    action: 'drop-node',
  },
  {
    id: 'sponsored label',
    surface: 'news feed, search',
    seen: '2026-10-10: the "Ad" label section of a search ad',
    text: [`"${LABEL_TYPENAME}"`],
    // Only on real edges (with a cursor): a wrapper holding an ad deep inside isn't an ad.
    match: (edge, node) => isObject(node) && 'cursor' in edge && hasSponsoredLabel(node),
    action: 'drop-node',
  },
  {
    id: 'MarketplaceFeedAdStory',
    surface: 'Marketplace',
    seen: '2026-10-10: 8 ad cards pruned in the page, grid intact',
    text: ['"MarketplaceFeedAdStory"'],
    match: (edge, node) => isObject(node) && node.__typename === 'MarketplaceFeedAdStory',
    action: 'drop-node',
  },
  {
    id: 'SEARCH_ADS',
    surface: 'search results',
    seen: '2026-10-10: the ad result pruned with its story',
    text: ['"SEARCH_ADS"'],
    match: (edge, node) => isObject(node) && node.role === 'SEARCH_ADS',
    action: 'drop-node',
  },
];

const DROPPED_BY = { 'drop-node': ['node', 'rendering_strategy'] };

// The prefilter strings for every row, once each.
export const AD_MARKER_TEXT = [...new Set(AD_MARKERS.flatMap((row) => row.text))];

// The first row that says this edge is an ad, or null.
export function adMarkerFor(value) {
  if (!isObject(value) || !('node' in value)) return null;
  return AD_MARKERS.find((row) => row.match(value, value.node)) ?? null;
}

// Applies each matching row's action. Returns the ids of the rows that fired, one entry per
// edge, so an empty list means nothing changed.
export function pruneAds(doc) {
  const fired = [];
  walk(doc, (value) => {
    const row = adMarkerFor(value);
    if (!row) return undefined;
    for (const key of DROPPED_BY[row.action]) delete value[key];
    fired.push(row.id);
    return SKIP;
  });
  return fired;
}
