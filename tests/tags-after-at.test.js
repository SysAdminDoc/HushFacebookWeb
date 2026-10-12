// Tag suggestions only after @, against answers built in the shapes the comment box got live
// (2026-10-11, captures/2026-10-11-run31, values blanked there). The people are made up, since
// the harness never writes a friend's name down.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import tagsAfterAt, { BOOTLOAD, MARKERS, emptyTagLists } from '../src/features/comments/tags-after-at.js';
import { transformDocumentLine } from '../src/core/net/payload.js';

const person = (id, name) => ({
  __typename: 'CometComposerTypeaheadResultEntry', score: 0.9, icon_shape: 'CIRCLE',
  node: { id, __typename: 'User', name, mentions_subtext: null, is_verified: false, photo: { uri: 'https://cdn.example.invalid/p.jpg' }, __isEntity: 'User', work_foreign_entity_info: null, __isContextualProfile: 'User' },
});
const suggestion = (id, name) => ({
  __typename: 'XFBTagSuggestion', eligibility: { is_eligible: true, description: null }, is_close_friend: null, subtext: 'Friend',
  profile: { __typename: 'User', id, name, profile_picture: { uri: 'https://cdn.example.invalid/p.jpg' } },
});
const extensions = { server_metadata: { request_start_time_ms: 1, time_at_flush_ms: 2 }, is_final: true };

const bootload = () => ({ data: { comet_composer_typeahead_bootload: [person('1', 'Robin Example'), person('2', 'Casey Sample')] }, extensions });
const transparency = () => ({ data: { xfb_tag_suggestion_search: { suggestions: [suggestion('1', 'Robin Example'), suggestion('2', 'Casey Sample'), suggestion('3', 'Jamie Placeholder')] } }, extensions });

// The rules the network hooks would run for a request: switched on and matching it.
function rule() {
  const all = [];
  let changed = 0;
  tagsAfterAt.setup({ net: { transformResponses: (r) => all.push(r) }, enabled: () => true, diagnostics: { add() {}, changed: () => changed++ } });
  return { rulesFor: (ctx) => all.filter((r) => r.enabled() && r.match(ctx)), changed: () => changed };
}

test('the two lists the comment box loads up front are emptied, and nothing else in them changes', () => {
  const first = bootload();
  assert.equal(emptyTagLists(first), 2);
  assert.deepEqual(first, { data: { comet_composer_typeahead_bootload: [] }, extensions });
  const second = transparency();
  assert.equal(emptyTagLists(second), 3);
  assert.deepEqual(second, { data: { xfb_tag_suggestion_search: { suggestions: [] } }, extensions });
  assert.equal(emptyTagLists({ data: null }), 0);
  assert.equal(emptyTagLists({ data: { xfb_tag_suggestion_search: null } }), 0);
});

test('only the up-front answers are touched, by name: what an @ asks for still finds everyone', () => {
  const { rulesFor, changed } = rule();
  const ctx = (friendlyName) => ({ transport: 'xhr', method: 'POST', path: '/api/graphql/', friendlyName });
  for (const [name, doc] of [['useFeedComposerCometMentionsBootloadDataSourceQuery', bootload()], ['useFeedComposerCometMentionsBootloadDataSourceWithTaggingTransparencyQuery', transparency()]]) {
    assert.ok(BOOTLOAD.test(name));
    const line = JSON.stringify(doc);
    assert.ok(MARKERS.some((marker) => line.includes(marker)));
    const out = JSON.parse(transformDocumentLine(line, rulesFor(ctx(name)), ctx(name)));
    assert.equal(JSON.stringify(out).includes('Robin'), false, name);
  }
  assert.equal(changed(), 2);
  // The search after @ and the list for a bare @ have the same shape and are left alone.
  const search = JSON.stringify(transparency());
  for (const name of ['useFeedComposerCometMentionsNetworkDataSourceWithTaggingTransparencyQuery', 'useFeedComposerCometMentionsNullstateDataSourceWithTaggingTransparencyQuery']) {
    assert.equal(BOOTLOAD.test(name), false);
    assert.equal(transformDocumentLine(search, rulesFor(ctx(name)), ctx(name)), search, name);
  }
  // Without a name to go by, nothing is touched.
  const inline = { transport: 'json-parse', friendlyName: '' };
  assert.equal(transformDocumentLine(search, rulesFor(inline), inline), search);
});

test('the switch starts off, sits with comments and needs the page', () => {
  assert.equal(tagsAfterAt.default, false);
  assert.equal(tagsAfterAt.section, 'comments');
  assert.equal(tagsAfterAt.needsPage, true);
});
