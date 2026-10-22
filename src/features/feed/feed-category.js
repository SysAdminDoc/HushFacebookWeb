// Facebook's own category for each feed edge, the one it ranks and places the unit by. Live
// 2026-10-22 (every Home edge in 250 captured answers), it comes three ways:
//   edge.category: 'SPONSORED'                      the older shape, not seen since 2026-10-10
//   edge.cat_sensitive: {enc: null, cat: 'FB_SHORTS'} plain, on rows of reels, people or groups
//   edge.cat_sensitive: {enc: '<hex>', cat: null}   hashed, on every story
// The hash is sha256hex(sha256hex(post_id) + n), n being the category's place in
// FEED_CATEGORIES, so it reads back with the story's own post_id. Every hashed edge captured
// read back this way. The names and their order are Facebook's (imrehorvath's
// facebook-feeds-filter, MIT, lists the same 21).

import { sha256Hex } from '../../core/sha256.js';

export const FEED_CATEGORIES = [
  'UNKNOWN', 'ORGANIC', 'ENGAGEMENT', 'FIXED_POSITION', 'PROMOTION', 'SPONSORED', 'END_OF_FEED_CONTENT',
  'FB_STORIES', 'HIGH_VALUE_PROMOTION', 'FB_STORIES_ENGAGEMENT', 'SHOWCASE', 'FB_SHORTS', 'TRENDING',
  'ENGAGEMENT_QP', 'MULTI_FB_STORIES_TRAY', 'END_OF_FEED_REELS', 'FB_SHORTS_FALLBACK', 'FRIENDLY_FEED_MID_CARD',
  'FRIENDLY_FEED_PROMOTION', 'INJECTED_STORY', 'LIMITED_PERSONALIZATION_NOTICE',
];

// The hashed form of a category for one post id, as Facebook sends it.
export function categoryHash(postId, category) {
  const index = FEED_CATEGORIES.indexOf(category);
  if (index < 0) throw new Error(`${category} is not a feed category`);
  return sha256Hex(sha256Hex(String(postId)) + index);
}

// Which category a hash stands for with this post id, or null.
export function readCategoryHash(postId, enc) {
  if (postId == null || typeof enc !== 'string') return null;
  const base = sha256Hex(String(postId));
  return FEED_CATEGORIES.find((_, index) => sha256Hex(base + index) === enc) ?? null;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// An edge is checked by several rows, so each hash is read once.
const read = new WeakMap();

// The edge's category name, or null when it has none or it can't be read.
export function feedCategory(edge) {
  if (!isObject(edge)) return null;
  if (typeof edge.category === 'string') return edge.category;
  const sensitive = edge.cat_sensitive;
  if (!isObject(sensitive)) return null;
  if (typeof sensitive.cat === 'string') return sensitive.cat;
  if (!read.has(sensitive)) read.set(sensitive, readCategoryHash(edge.node?.post_id, sensitive.enc));
  return read.get(sensitive);
}
