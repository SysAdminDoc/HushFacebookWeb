// Hide that you're writing a comment: the comment box's live typing broadcast is held back with
// an empty success, and nothing else is. Hide when others are writing a comment empties the line
// Facebook draws for them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import hideCommentTyping, { COMMENT_TYPING } from '../src/features/comments/hide-comment-typing.js';
import { EMPTY_SUCCESS } from '../src/features/reels/no-watch-history.js';
import { describeRequest } from '../src/core/net/hooks.js';
import hideIncomingCommentTyping, { dropTypingLines } from '../src/features/comments/hide-incoming-typing.js';
import { rulesFor, transformDocumentLine } from '../src/core/net/payload.js';
import { features } from '../src/features/index.js';

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

// Hide when others are writing a comment: the comment list's typing line comes back empty.
const incoming = () => {
  const rules = [];
  const rows = [];
  let on = true;
  hideIncomingCommentTyping.setup({
    net: { transformResponses: (rule) => rules.push(rule) },
    enabled: () => on,
    diagnostics: { add: (label, read) => rows.push([label, read]), changed: () => {} },
  });
  const ctx = { transport: 'json-parse' };
  const run = (doc) => {
    const line = JSON.stringify(doc);
    return JSON.parse(transformDocumentLine(line, rulesFor(line, rules).filter((rule) => rule.enabled() && rule.match(ctx)), ctx));
  };
  return { rule: rules[0], run, count: () => rows[0][1](), off: () => { on = false; } };
};
// The renderer's shape: a Relay match with its code by name (Facebook's code, 2026-10-22).
const typingLine = () => ({
  __typename: 'XFBFeedbackInlineTypingIndicatorRenderer',
  __module_operation_useCometUFITopLevelCommentListComponents_feedback: { __dr: 'CometUFIInlineTypingIndicator_renderer$normalization.graphql' },
  __module_component_useCometUFITopLevelCommentListComponents_feedback: { __dr: 'CometUFIInlineTypingIndicator.react' },
});
const comment = { node: { __typename: 'Comment', id: 'c1', body: { text: 'Nice one' } }, cursor: 'x' };
// Where it sat in a post's answer seen live (empty then).
const post = (renderer) => ({ data: { node: { story: { feedback_context: { feedback_target_with_context: { comment_list_renderer: { feedback: {
  __typename: 'Feedback', id: 'f1', comment_rendering_instance_for_feed_location: { comments: { edges: [comment] } }, typing_indicator_renderer: renderer,
} } } } } } } });

test("someone writing a comment never reaches the comment list, and the comments do", () => {
  const { rule, run, count } = incoming();
  assert.equal(rule.id, 'hideIncomingCommentTyping');
  assert.equal(rule.match({ transport: 'xhr' }), false, 'only what JSON.parse hands the page');
  const out = run(post(typingLine()));
  const feedback = out.data.node.story.feedback_context.feedback_target_with_context.comment_list_renderer.feedback;
  assert.equal(feedback.typing_indicator_renderer, null);
  assert.deepEqual(feedback.comment_rendering_instance_for_feed_location.comments.edges, [comment]);
  assert.equal(count(), '1');

  // A new comment comes with its post's feedback, and the line goes from that too.
  const created = run({ data: { comment_create_subscribe: { feedback_comment_edge: comment, feedback: { id: 'f1', typing_indicator_renderer: typingLine() } } } });
  assert.equal(created.data.comment_create_subscribe.feedback.typing_indicator_renderer, null);
  assert.deepEqual(created.data.comment_create_subscribe.feedback_comment_edge, comment);
  assert.equal(count(), '2');

  // An empty one, as both busy posts had, is left as it came.
  const empty = JSON.stringify(post(null));
  assert.equal(rulesFor(empty, [rule]).length, 0, 'nothing to look at');
  assert.deepEqual(run(post(null)), post(null));
  // Someone's words can't look like one, since quotes inside them come escaped.
  const said = JSON.stringify(post(null)).replace('"Nice one"', JSON.stringify('"typing_indicator_renderer":{'));
  assert.equal(rulesFor(said, [rule]).length, 0);
  assert.equal(count(), '2');
});

test('with the switch off the typing line stays, and it starts off with Comments', () => {
  const { run, off, count } = incoming();
  off();
  const out = run(post(typingLine()));
  assert.deepEqual(out.data.node.story.feedback_context.feedback_target_with_context.comment_list_renderer.feedback.typing_indicator_renderer, typingLine());
  assert.equal(count(), '0');
  assert.deepEqual(dropTypingLines({ a: [post(typingLine()), post(typingLine())], b: { typing_indicator_renderer: 'x' } }), 2, 'only a renderer object is one');
  assert.equal(hideIncomingCommentTyping.default, false);
  assert.equal(hideIncomingCommentTyping.section, 'comments');
  assert.equal(hideIncomingCommentTyping.needsPage, true);
  assert.ok(features.includes(hideIncomingCommentTyping));
});
