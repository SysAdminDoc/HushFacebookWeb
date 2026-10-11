// Hide that you're writing a comment: the comment box's live typing broadcast is held back with
// an empty success, and nothing else is.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import hideCommentTyping, { COMMENT_TYPING } from '../src/features/comments/hide-comment-typing.js';
import { EMPTY_SUCCESS } from '../src/features/reels/no-watch-history.js';
import { describeRequest } from '../src/core/net/hooks.js';

const request = (friendly, transport = 'xhr') => describeRequest({
  transport,
  url: '/api/graphql/',
  method: 'POST',
  body: new URLSearchParams({ fb_api_req_friendly_name: friendly, doc_id: '1', variables: '{}' }).toString(),
  headers: {},
  base: 'https://www.facebook.com/NASA/',
});

function setUp(on = true) {
  const rules = [];
  const rows = [];
  let changed = 0;
  hideCommentTyping.setup({
    net: { blockRequests: (rule) => rules.push(rule) },
    enabled: () => on,
    diagnostics: { add: (label, read) => rows.push([label, read]), changed: () => changed++ },
  });
  return { rule: rules[0], rows, changed: () => changed };
}

test('the typing broadcast, start and stop, is held back with an empty success and counted', () => {
  const { rule, rows, changed } = setUp();
  assert.equal(rule.id, 'hideCommentTyping');
  // The start half is the name seen live (2026-10-11) as the first letter went in.
  for (const name of ['CometUFILiveTypingBroadcastMutation_StartMutation', 'CometUFILiveTypingBroadcastMutation_StopMutation']) {
    assert.ok(rule.match(request(name)), name);
    assert.ok(rule.match(request(name, 'fetch')), `${name} over fetch`);
  }
  assert.equal(rule.fakeResponse(), EMPTY_SUCCESS);
  assert.deepEqual(rows.map(([label, read]) => [label, read()]), [['Comment typing signals held back', '1']]);
  assert.equal(changed(), 1);
});

test('the comment itself, mentions, reactions and chat typing go through', () => {
  const { rule } = setUp();
  for (const name of [
    'useCometUFICreateCommentMutation',
    'useFeedComposerCometMentionsNetworkDataSourceWithTaggingTransparencyQuery',
    'CometUFIFeedbackReactMutation',
    'CometUFILiveTypingBroadcastMutation_StartMutationX',
    'XCometUFILiveTypingBroadcastMutation_StartMutation',
    '',
  ]) {
    assert.equal(rule.match(request(name)), false, name);
  }
  assert.equal(COMMENT_TYPING.test('CometUFILiveTypingBroadcastMutation_Start'), false);
});

test('the switch starts off, sits with Comments and needs the page', () => {
  const { rule } = setUp(false);
  assert.equal(rule.enabled(), false);
  assert.equal(hideCommentTyping.default, false);
  assert.equal(hideCommentTyping.section, 'comments');
  assert.equal(hideCommentTyping.needsPage, true);
});
