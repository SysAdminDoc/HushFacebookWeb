// Facebook's feed categories. The hashes here are worked out with Node's own SHA-256 from made-up
// post ids, the way Facebook builds them (feed-category.js).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { categoryHash, FEED_CATEGORIES, feedCategory, readCategoryHash } from '../src/features/feed/feed-category.js';

const POST_ID = '1000000000000301';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const facebookHash = (postId, index) => sha(sha(postId) + index);
const hashed = (category, postId = POST_ID) => ({ cat_sensitive: { enc: facebookHash(postId, FEED_CATEGORIES.indexOf(category)), cat: null }, node: { __typename: 'Story', post_id: postId }, cursor: 'c' });

test("the 21 categories are Facebook's, in its order", () => {
  assert.equal(FEED_CATEGORIES.length, 21);
  assert.equal(new Set(FEED_CATEGORIES).size, 21);
  for (const [index, name] of [[0, 'UNKNOWN'], [1, 'ORGANIC'], [2, 'ENGAGEMENT'], [4, 'PROMOTION'], [5, 'SPONSORED'], [8, 'HIGH_VALUE_PROMOTION'], [11, 'FB_SHORTS'], [13, 'ENGAGEMENT_QP'], [18, 'FRIENDLY_FEED_PROMOTION'], [20, 'LIMITED_PERSONALIZATION_NOTICE']]) {
    assert.equal(FEED_CATEGORIES[index], name);
  }
});

test('every category hashes the way Facebook does and reads back from its post id', () => {
  FEED_CATEGORIES.forEach((name, index) => {
    const enc = facebookHash(POST_ID, index);
    assert.equal(categoryHash(POST_ID, name), enc, name);
    assert.equal(readCategoryHash(POST_ID, enc), name, name);
  });
  assert.equal(categoryHash(Number('100000000000302'), 'ENGAGEMENT'), facebookHash('100000000000302', 2), 'a numeric post id hashes as its digits');
  assert.throws(() => categoryHash(POST_ID, 'SUGGESTED'), /not a feed category/);
});

test("a hash only reads back with the story's own post id", () => {
  const enc = facebookHash(POST_ID, 2);
  assert.equal(readCategoryHash('1000000000000399', enc), null);
  assert.equal(readCategoryHash(POST_ID, facebookHash(POST_ID, 21)), null, 'a place past the list');
  assert.equal(readCategoryHash(POST_ID, 'f'.repeat(64)), null);
  assert.equal(readCategoryHash(null, enc), null);
  for (const missing of [null, undefined]) {
    assert.equal(readCategoryHash(missing, categoryHash(String(missing), 'ENGAGEMENT')), null, `a missing post id isn't read as "${missing}"`);
  }
  assert.equal(readCategoryHash(POST_ID, null), null);
});

test('feedCategory reads all three shapes', () => {
  assert.equal(feedCategory(hashed('ENGAGEMENT')), 'ENGAGEMENT');
  assert.equal(feedCategory(hashed('ORGANIC')), 'ORGANIC');
  assert.equal(feedCategory(hashed('SPONSORED', '1000000000000302')), 'SPONSORED');
  assert.equal(feedCategory({ cat_sensitive: { enc: null, cat: 'FB_SHORTS' }, node: { __typename: 'ShowcaseFeedUnit' } }), 'FB_SHORTS');
  assert.equal(feedCategory({ category: 'SPONSORED', node: { id: 'ad' } }), 'SPONSORED');
  assert.equal(feedCategory({ category: 'SPONSORED', cat_sensitive: { enc: null, cat: 'ORGANIC' } }), 'SPONSORED', 'the older field first');
});

test("feedCategory is null when there's nothing to read", () => {
  const unreadable = hashed('ENGAGEMENT');
  delete unreadable.node.post_id;
  assert.equal(feedCategory(unreadable), null, 'no post id');
  const dropped = hashed('ENGAGEMENT');
  delete dropped.node;
  assert.equal(feedCategory(dropped), null, 'no node');
  assert.equal(feedCategory({ cat_sensitive: { enc: 'f'.repeat(64), cat: null }, node: { post_id: POST_ID } }), null, 'a stand-in hash');
  assert.equal(feedCategory({ cat_sensitive: null, node: { post_id: POST_ID } }), null);
  assert.equal(feedCategory({ cat_sensitive: 'ENGAGEMENT', node: { post_id: POST_ID } }), null);
  assert.equal(feedCategory({ node: { post_id: POST_ID } }), null);
  assert.equal(feedCategory(null), null);
  assert.equal(feedCategory([hashed('ENGAGEMENT')]), null);
});

test('a hash is read once per edge', () => {
  const edge = hashed('PROMOTION');
  assert.equal(feedCategory(edge), 'PROMOTION');
  edge.node.post_id = '1000000000000399';
  assert.equal(feedCategory(edge), 'PROMOTION', 'the first reading stands');
  assert.equal(feedCategory({ ...edge, cat_sensitive: { ...edge.cat_sensitive } }), null, 'a new cat_sensitive is read again');
});
