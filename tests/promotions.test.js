// Hide Facebook's own cards and tips, against three captured answers (scrubbed): the story
// viewer's, with one tip in qp_viewer.eligible_promotions, and the Messenger chat list banner's
// and Messenger menu's, which came back empty for the test account.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureLines, parseLine } from './helpers/fixtures.js';
import hidePromotions, { MARKERS, emptyPromotions } from '../src/features/meta/hide-promotions.js';
import { rulesFor } from '../src/core/net/payload.js';

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

test('the feature works through JSON.parse only and counts what it held back', async () => {
  const rules = [];
  const rows = [];
  hidePromotions.setup({
    net: { transformResponses: (rule) => rules.push(rule) },
    enabled: () => true,
    diagnostics: { add: (label, read) => rows.push([label, read]), changed() {} },
  });
  const [rule] = rules;
  assert.equal(rule.match({ transport: 'json-parse' }), true);
  assert.equal(rule.match({ transport: 'xhr' }), false);
  const lines = await fixtureLines('StoriesSuspenseContentPaneRootWithEntryPointQuery.jsonl');
  const line = lines.find((text) => text.includes('"qp_viewer"'));
  assert.equal(rulesFor(line, [rule]).length, 1);
  assert.equal(rule.transform(parseLine(line)), true);
  assert.deepEqual(rows.map(([label, read]) => [label, read()]), [['Cards and tips held back', '1']]);
  assert.equal(hidePromotions.default, false);
  assert.equal(hidePromotions.needsPage, true);
});
