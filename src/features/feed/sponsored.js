// Sponsored feed units in Facebook's GraphQL and inline page data.
//
// A sponsored feed edge carries category "SPONSORED" or a node with sponsored_data. The
// edge stays and only its node goes: the cursor is kept, so Relay keeps paging and leaves
// no gap. (Same idea uBlock Origin's Facebook rules used before they were retired.)
//
// Confidence: the markers are verified from uBlock Origin's filters; whether removing the
// node renders cleanly on the live site needs checking against a captured response.

import { SKIP, walk } from '../../core/json-walk.js';

export const SPONSORED_MARKERS = ['"SPONSORED"', '"sponsored_data"'];

export function isSponsoredEdge(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !('node' in value)) return false;
  if (value.category === 'SPONSORED') return true;
  const node = value.node;
  return node !== null && typeof node === 'object' && node.sponsored_data != null;
}

// Returns true when it removed anything.
export function pruneSponsoredEdges(doc) {
  let changed = false;
  walk(doc, (value) => {
    if (!isSponsoredEdge(value)) return undefined;
    delete value.node;
    changed = true;
    return SKIP;
  });
  return changed;
}
