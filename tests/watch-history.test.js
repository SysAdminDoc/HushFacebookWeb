// Don't send reel watch history: the request that reports a watched reel is held back with an
// empty success, and nothing else is.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureLines, parseLine } from './helpers/fixtures.js';
import noWatchHistory, { EMPTY_SUCCESS, HISTORY_MUTATIONS } from '../src/features/reels/no-watch-history.js';
import { SEEN_MUTATIONS } from '../src/features/stories/anonymous-stories.js';
import { describeRequest } from '../src/core/net/hooks.js';

const request = (friendly) => describeRequest({
  transport: 'fetch',
  url: '/api/graphql/',
  method: 'POST',
  body: new URLSearchParams({ fb_api_req_friendly_name: friendly, doc_id: '1', variables: '{}' }).toString(),
  headers: {},
  base: 'https://www.facebook.com/',
});

function setUp(on = true) {
  const rules = [];
  const rows = [];
  let changed = 0;
  noWatchHistory.setup({
    net: { blockRequests: (rule) => rules.push(rule) },
    enabled: () => on,
    diagnostics: { add: (label, read) => rows.push([label, read]), changed: () => changed++ },
  });
  return { rule: rules[0], rows, changed: () => changed };
}

test('the watched-reel report is held back with an empty success, and Diagnostics counts it', () => {
  const { rule, rows, changed } = setUp();
  assert.equal(rule.id, 'noWatchHistory');
  assert.ok(rule.match(request('FBUnifiedVideoSeenStateMutation')));
  assert.equal(rule.fakeResponse(), EMPTY_SUCCESS);
  assert.deepEqual(JSON.parse(EMPTY_SUCCESS), { data: {}, errors: [] });
  assert.deepEqual(rows.map(([label, read]) => [label, read()]), [['Watch reports held back', '1']]);
  assert.equal(changed(), 1);
});

test('the captured reports from four reels are each held back, and carry only the video and the account', async () => {
  const lines = await fixtureLines('FBUnifiedVideoSeenStateMutation.request.jsonl');
  assert.equal(lines.length, 4);
  const { rule } = setUp();
  for (const line of lines) {
    const record = parseLine(line);
    const body = new URLSearchParams({ fb_api_req_friendly_name: record.friendly, doc_id: record.doc_id, variables: record.variables }).toString();
    const ctx = describeRequest({ transport: 'xhr', url: record.path, method: record.method, body, headers: {}, base: 'https://www.facebook.com/reel/' });
    assert.ok(rule.match(ctx), `${ctx.friendlyName} should be held back`);
    const { input } = JSON.parse(record.variables);
    assert.deepEqual(Object.keys(input), ['video_ids', 'actor_id', 'client_mutation_id']);
    assert.equal(input.video_ids.length, 1);
  }
});

test('the reel itself, its ads check, story views and other mutations go through', () => {
  const { rule } = setUp();
  for (const name of ['FBUnifiedVideoContainerQuery', 'useInstreamAdsHaloFetcherQuery', 'storiesUpdateSeenStateMutation', 'CometUFIFeedbackReactMutation', '']) {
    assert.equal(rule.match(request(name)), false, name);
  }
  // Story views belong to View stories anonymously alone.
  for (const name of HISTORY_MUTATIONS) assert.equal(SEEN_MUTATIONS.has(name), false);
});

test('the switch starts off, sits with Reels and needs the page', () => {
  const { rule } = setUp(false);
  assert.equal(rule.enabled(), false);
  assert.equal(noWatchHistory.default, false);
  assert.equal(noWatchHistory.section, 'reels');
  assert.equal(noWatchHistory.needsPage, true);
});
