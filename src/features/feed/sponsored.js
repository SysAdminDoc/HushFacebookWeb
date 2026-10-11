// Sponsored units in Facebook's GraphQL and inline page data.
//
// Facebook renames its ad fields when relay providers such as
// GHLShouldChangeSponsoredDataFieldName are on (they were in the 2026-10-10 capture):
// sponsored_data arrives as th_dat_spo, and the edge category is hashed into
// cat_sensitive {enc, cat: null}. Field names alone can't be trusted, so an edge counts as
// an ad when any of these hold:
//   - edge.category or edge.cat_sensitive.cat is "SPONSORED" (older and plain shapes)
//   - node.sponsored_data or node.th_dat_spo is set (null on organic stories)
//   - the node carries a CometStorySponsoredLabelStrategy section (typenames aren't renamed)
//   - Marketplace: node.__typename "MarketplaceFeedAdStory"
//   - search results: node.role "SEARCH_ADS"
// The edge stays and only what Facebook draws from goes, so cursors and paging survive
// (uBlock Origin's old approach). That's the node, and on search results also the
// rendering_strategy beside it, which is where a search ad keeps its story.
//
// Seen live: the renamed fields, the label section on a search ad, Marketplace and search
// ads, and Marketplace pruned in the page with the grid intact (2026-10-10). Not seen yet:
// an ad in the main feed (none in 141 stories on the test account).

import { SKIP, walk } from '../../core/json-walk.js';

export const SPONSORED_MARKERS = [
  '"SPONSORED"',
  '"sponsored_data":{',
  '"th_dat_spo":{',
  '"CometStorySponsoredLabelStrategy"',
  '"MarketplaceFeedAdStory"',
  '"SEARCH_ADS"',
];

const AD_DATA_FIELDS = ['sponsored_data', 'th_dat_spo'];
const DRAWN_FIELDS = ['node', 'rendering_strategy'];
const LABEL_TYPENAME = 'CometStorySponsoredLabelStrategy';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

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

export function isSponsoredEdge(value) {
  if (!isObject(value) || !('node' in value)) return false;
  if (value.category === 'SPONSORED') return true;
  if (isObject(value.cat_sensitive) && value.cat_sensitive.cat === 'SPONSORED') return true;
  const node = value.node;
  if (!isObject(node)) return false;
  if (node.__typename === 'MarketplaceFeedAdStory' || node.role === 'SEARCH_ADS') return true;
  if (AD_DATA_FIELDS.some((key) => node[key] != null)) return true;
  return 'cursor' in value && hasSponsoredLabel(node);
}

// Returns true when it removed anything.
export function pruneSponsoredEdges(doc) {
  let changed = false;
  walk(doc, (value) => {
    if (!isSponsoredEdge(value)) return undefined;
    for (const key of DRAWN_FIELDS) delete value[key];
    changed = true;
    return SKIP;
  });
  return changed;
}
