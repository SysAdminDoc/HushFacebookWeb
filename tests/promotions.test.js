// Hide Facebook's own cards and tips, against three captured answers (scrubbed): the story
// viewer's, with one tip in qp_viewer.eligible_promotions, and the Messenger chat list banner's
// and Messenger menu's, which came back empty for the test account. Home's promotion units
// haven't come up yet, so theirs is made up.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureLines, parseLine } from './helpers/fixtures.js';
import hidePromotions, { MARKERS, emptyPromotions } from '../src/features/meta/hide-promotions.js';
import { rulesFor } from '../src/core/net/payload.js';
import { parseRoute } from '../src/core/route.js';
import { categoryHash } from '../src/features/feed/feed-category.js';

const storyLines = async () => (await fixtureLines('StoriesSuspenseContentPaneRootWithEntryPointQuery.jsonl')).map(parseLine);
const findQp = (docs) => docs.map((doc) => doc?.data?.qp_viewer).find(Boolean);

test("the story viewer's tip is taken out, and everything else in the answer stays", async () => {
  const docs = await storyLines();
  const qp = findQp(docs);
  assert.equal(qp.eligible_promotions.nodes.length, 1);
  assert.equal(qp.eligible_promotions.nodes[0].trigger, 'fb_stories_www_tofu_nux');
  const before = structuredClone(docs);
  assert.equal(docs.reduce((n, doc) => n + emptyPromotions(doc), 0), 1);
  assert.deepEqual(findQp(docs).eligible_promotions, { nodes: [] });
  findQp(before).eligible_promotions.nodes = [];
  assert.deepEqual(docs, before, 'only the tip changed');
  assert.equal(docs.reduce((n, doc) => n + emptyPromotions(doc), 0), 0, 'a second pass changes nothing');
});

test("the Messenger banner and menu answers have the same lists, and an empty one is left alone", async () => {
  for (const name of ['MWQuickPromotionThreadlistBannerQuery.jsonl', 'CometMessagingJewelDropdownEBUpsellContainerQuery.jsonl']) {
    const lines = await fixtureLines(name);
    assert.ok(lines.some((line) => MARKERS.some((marker) => line.includes(marker))), name);
    for (const line of lines) {
      const doc = parseLine(line);
      const before = structuredClone(doc);
      assert.equal(emptyPromotions(doc), 0);
      assert.deepEqual(doc, before);
    }
  }
  // As it would come with the card in it.
  const banner = parseLine((await fixtureLines('MWQuickPromotionThreadlistBannerQuery.jsonl'))[0]);
  banner.data.viewer.eligible_promotions.nodes.push({ id: '1', surface_id: 1, trigger: 'messenger_thread_list' });
  const menu = { data: { viewer: { jewel_qp: { nodes: [{ id: '2' }, { id: '3' }] } } } };
  assert.equal(emptyPromotions(banner) + emptyPromotions(menu), 3);
  assert.deepEqual(banner.data.viewer.eligible_promotions.nodes, []);
  assert.deepEqual(menu.data.viewer.jewel_qp.nodes, []);
});

test('the feature empties promotion lists through JSON.parse, drops Home promotion units, and counts both', async () => {
  const rules = [];
  const rows = [];
  const decisions = [];
  hidePromotions.setup({
    net: { transformResponses: (rule) => rules.push(rule) },
    router: { current: () => parseRoute('https://www.facebook.com/') },
    enabled: () => true,
    diagnostics: { add: (label, read) => rows.push([label, read]), changed() {}, decide: (decision) => decisions.push(decision) },
  });
  const [rule, units] = rules;
  assert.equal(rules.length, 2);
  assert.notEqual(rule.id, units.id, 'each rule logs its own failures');
  assert.equal(rule.match({ transport: 'json-parse' }), true);
  assert.equal(rule.match({ transport: 'xhr' }), false);
  const lines = await fixtureLines('StoriesSuspenseContentPaneRootWithEntryPointQuery.jsonl');
  const line = lines.find((text) => text.includes('"qp_viewer"'));
  assert.equal(rulesFor(line, [rule]).length, 1);
  assert.equal(rule.transform(parseLine(line)), true);

  // Home's own promotion units, by Facebook's category for the edge (none seen live yet).
  assert.equal(units.id, 'hidePromotions');
  const postId = '1000000000000401';
  const home = { data: { viewer: { news_feed: { edges: [
    { cat_sensitive: { enc: categoryHash('1000000000000400', 'ORGANIC'), cat: null }, node: { __typename: 'Story', post_id: '1000000000000400' }, cursor: 'a' },
    { cat_sensitive: { enc: categoryHash(postId, 'PROMOTION'), cat: null }, node: { __typename: 'Story', post_id: postId }, cursor: 'b' },
  ] } } } };
  assert.equal(rulesFor(JSON.stringify(home), [units]).length, 1);
  assert.equal(units.transform(home, { transport: 'json-parse' }), true);
  assert.deepEqual(home.data.viewer.news_feed.edges.map((edge) => edge.node?.post_id ?? null), ['1000000000000400', null]);
  assert.deepEqual(decisions, [{ post: postId, rule: 'Promotion', signal: 'promotion category', layer: 'data' }]);
  assert.deepEqual(rows.map(([label, read]) => [label, read()]), [['Cards and tips held back', '2']]);
  assert.equal(hidePromotions.default, false);
  assert.equal(hidePromotions.needsPage, true);
});
