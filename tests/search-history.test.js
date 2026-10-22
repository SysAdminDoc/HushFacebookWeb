// Don't save search history: the request that adds a search to your recent searches is held back
// with an empty success, and the search itself and everything else go through.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureLines, parseLine } from './helpers/fixtures.js';
import noSearchHistory, { SEARCH_HISTORY_MUTATIONS } from '../src/features/search/no-search-history.js';
import { EMPTY_SUCCESS, HISTORY_MUTATIONS } from '../src/features/reels/no-watch-history.js';
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
  noSearchHistory.setup({
    net: { blockRequests: (rule) => rules.push(rule) },
    enabled: () => on,
    diagnostics: { add: (label, read) => rows.push([label, read]), changed: () => changed++ },
  });
  return { rule: rules[0], rows, changed: () => changed };
}

test('the saved-search report is held back with an empty success, and Diagnostics counts it', () => {
  const { rule, rows, changed } = setUp();
  assert.equal(rule.id, 'noSearchHistory');
  assert.equal(rule.startupPrivacy, true);
  assert.ok(rule.match(request('CometAddTypeaheadRecentSearchMutation')));
  assert.equal(rule.fakeResponse(), EMPTY_SUCCESS);
  assert.deepEqual(rows.map(([label, read]) => [label, read()]), [['Searches held back', '1']]);
  assert.equal(changed(), 1);
});

test('the captured saved search is held back, and carries the typed text, the account and where it came from', async () => {
  const lines = await fixtureLines('CometAddTypeaheadRecentSearchMutation.request.jsonl');
  assert.ok(lines.length >= 1);
  const { rule } = setUp();
  for (const line of lines) {
    const record = parseLine(line);
    const body = new URLSearchParams({ fb_api_req_friendly_name: record.friendly, doc_id: record.doc_id, variables: record.variables }).toString();
    const ctx = describeRequest({ transport: 'xhr', url: record.path, method: record.method, body, headers: {}, base: 'https://www.facebook.com/' });
    assert.ok(rule.match(ctx), `${ctx.friendlyName} should be held back`);
    const { input } = JSON.parse(record.variables);
    assert.deepEqual(Object.keys(input).sort(), ['actor_id', 'client_mutation_id', 'selected_text', 'selected_type', 'source', 'user_input']);
  }
});

test('the search itself, typeahead suggestions, watch reports and other mutations go through', () => {
  const { rule } = setUp();
  for (const name of ['SearchCometResultsPaginatedResultsQuery', 'SearchCometResultsInitialResultsQuery', 'useCometTypeaheadDataSourceQuery',
    'CometSearchRecentSearchesQuery', 'FBUnifiedVideoSeenStateMutation', 'CometUFIFeedbackReactMutation', '']) {
    assert.equal(rule.match(request(name)), false, name);
  }
  // Watched reels belong to Don't send watch history alone.
  for (const name of SEARCH_HISTORY_MUTATIONS) assert.equal(HISTORY_MUTATIONS.has(name), false);
});

test('the switch starts off, sits with Search and needs the page', () => {
  const { rule } = setUp(false);
  assert.equal(rule.enabled(), false);
  assert.equal(noSearchHistory.default, false);
  assert.equal(noSearchHistory.section, 'search');
  assert.equal(noSearchHistory.needsPage, true);
});
