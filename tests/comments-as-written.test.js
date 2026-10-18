// Show comments as written, against comments shaped the way Facebook sent them to an account
// with automatic translation on (live 2026-10-11, captures/2026-10-11-run30): a comment's body
// (what was written) and preferred_body (what the page shows, MACHINE_TRANSLATION), and a post's
// translation, which is left alone. Names and words are made up.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import commentsAsWritten, { ASKED, AUTO_TRANSLATED, CommentBook, forgetAsked, MARKERS, originalRanges, POST_MARKERS, RESTORED, restoreComment, restorePost, untranslate, untranslatePosts } from '../src/features/comments/comments-as-written.js';
import { FAILED, applyRules, rulesFor, transformDocumentLine } from '../src/core/net/payload.js';
import { fixtureLines, parseLine } from './helpers/fixtures.js';

const mention = (offset, length, id = '100') => ({ __typename: 'EntityAtRange', entity: { __typename: 'User', __isNode: 'User', id }, entity_is_weak_reference: false, offset, length });
const richMention = (offset, length, id = '100') => ({ entity: { __typename: 'User', __isEntity: 'User', __isActor: 'User', id, url: `https://www.facebook.com/u${id}`, profile_url: `https://www.facebook.com/u${id}`, short_name: 'Jean', work_info: null }, entity_is_weak_reference: false, offset, length });

const comment = () => ({
  __typename: 'Comment',
  id: 'Y29tbWVudDox',
  body: { text: 'Merci Jean pour cet article', ranges: [mention(6, 4)] },
  preferred_body: {
    __typename: 'TextWithEntities', delight_ranges: [], image_ranges: [], inline_style_ranges: [], aggregated_ranges: [],
    ranges: [richMention(7, 4)], color_ranges: [], text: 'Thanks Jean for this article', translation_type: 'MACHINE_TRANSLATION',
  },
  translated_body_for_target_dialect: null,
  body_renderer: {
    __typename: 'TextWithEntities', delight_ranges: [], image_ranges: [], inline_style_ranges: [], aggregated_ranges: [],
    ranges: [richMention(7, 4)], color_ranges: [], text: 'Thanks Jean for this article',
    __module_operation_CometUFICommentTextBodyRenderer_comment: { __dr: 'CometUFICommentTextBodyRenderer_comment$normalization.graphql' },
  },
  translatability_for_viewer: { source_dialect: 'fr_XX' },
  translation_available_for_viewer: true,
});

const post = () => ({
  is_text_only_story: true,
  translatability_for_viewer: { source_dialect: 'es_XX' },
  post_level_music_info: null,
  translation: { message: { text: 'The minister spoke about the budget today' } },
  message_truncation_line_limit: 3,
  id: 'UzpfSTEwMDA6MjAwMA==',
});

test("a translated comment shows the person's own words, marked as the original, with its mention moved", () => {
  const item = comment();
  assert.equal(restoreComment(item), true);
  assert.equal(item.preferred_body.text, 'Merci Jean pour cet article');
  assert.equal(item.preferred_body.translation_type, 'ORIGINAL');
  assert.deepEqual(item.preferred_body.ranges, [richMention(6, 4)], "the link keeps what the page needs and sits on the name in the person's words");
  assert.equal(item.body_renderer.text, 'Merci Jean pour cet article', 'the text the page draws too');
  assert.deepEqual(item.body_renderer.ranges, [richMention(6, 4)]);
  assert.ok(item.body_renderer.__module_operation_CometUFICommentTextBodyRenderer_comment, "the renderer's module stays");
  assert.equal(item.body.text, 'Merci Jean pour cet article', 'what was written is left as it came');
  assert.deepEqual(item.translatability_for_viewer, { source_dialect: 'fr_XX' }, 'See translation stays');
  // Done once, it's an original like any other and is left alone.
  assert.equal(restoreComment(item), false);
});

test('comments Facebook left alone, or without their own words, are untouched', () => {
  const original = comment();
  original.preferred_body.translation_type = 'ORIGINAL';
  original.preferred_body.text = original.body.text;
  const before = structuredClone(original);
  assert.equal(restoreComment(original), false);
  assert.deepEqual(original, before);
  const bodiless = comment();
  bodiless.body = null;
  assert.equal(restoreComment(bodiless), false);
  assert.equal(bodiless.preferred_body.translation_type, 'MACHINE_TRANSLATION');
});

test('mentions are matched by who they are and in order, highlights into the translation go', () => {
  // Two mentions of one person and one of another, with the translation's order changed.
  const own = [mention(0, 4, '100'), mention(10, 5, '200'), mention(20, 4, '100')];
  const shown = [richMention(3, 5, '200'), richMention(12, 4, '100'), richMention(30, 4, '100')];
  assert.deepEqual(originalRanges(shown, own), [richMention(0, 4, '100'), richMention(10, 5, '200'), richMention(20, 4, '100')]);
  // A mention only the original has stays plain text rather than a link missing its parts.
  assert.deepEqual(originalRanges([], [mention(0, 4)]), []);
  assert.deepEqual(originalRanges(shown, undefined), []);
  const styled = comment();
  styled.preferred_body.inline_style_ranges = [{ offset: 0, length: 6, style: 'BOLD' }];
  restoreComment(styled);
  assert.deepEqual(styled.preferred_body.inline_style_ranges, []);
});

test("an answer's comments are put back and its post's translation is left as Facebook sent it", () => {
  const answer = { data: { node: { comet_sections: { content: { story: post() } }, comments: { edges: [{ node: comment() }, { node: comment() }] } } } };
  assert.deepEqual(untranslate(answer), { comments: 2, copies: 0 });
  assert.deepEqual(answer.data.node.comet_sections.content.story, post());
  assert.ok(answer.data.node.comments.edges.every(({ node }) => node.preferred_body.translation_type === 'ORIGINAL'));
});

// Real answers, scrubbed (captures/2026-10-11-run32, El País): a post's comment dialog with four
// machine-translated comments, each with its "See original" link's partial copy, and a Page
// timeline post in Facebook's auto-translated layout.
const findAll = (value, test, out = []) => {
  if (value && typeof value === 'object') {
    if (!Array.isArray(value) && test(value)) out.push(value);
    for (const child of Object.values(value)) findAll(child, test, out);
  }
  return out;
};

test("a real comment dialog: each comment's own words are what the page draws, and every copy says so", async () => {
  const [doc] = (await fixtureLines('translated-comments.jsonl')).map(parseLine);
  const before = findAll(doc, (v) => v.preferred_body?.translation_type === 'MACHINE_TRANSLATION' && typeof v.body?.text === 'string');
  assert.equal(before.length, 4);
  assert.ok(before.every((c) => c.body_renderer.text === c.preferred_body.text && c.body.text !== c.preferred_body.text), 'the page draws the translation');
  assert.deepEqual(untranslate(doc), { comments: 4, copies: 4 });
  assert.equal(JSON.stringify(doc).includes('MACHINE_TRANSLATION'), false);
  for (const comment of before) {
    assert.equal(comment.preferred_body.text, comment.body.text);
    assert.equal(comment.body_renderer.text, comment.body.text);
    assert.equal(comment.preferred_body.translation_type, 'ORIGINAL');
    assert.ok(comment.translatability_for_viewer?.source_dialect, 'See translation stays');
    const link = comment.comment_action_links.find((l) => l.__typename === 'XFBCommentTranslationActionLink');
    assert.equal(link.comment.id, comment.id);
    assert.equal(link.comment.preferred_body.translation_type, 'ORIGINAL');
  }
});

// Switching a post's layout left it a loading placeholder live (runs 37 and 40), and dropping its
// translation makes Facebook's layout throw, so the comment rule leaves posts alone.
test('a real Page timeline post in the auto-translated layout is left exactly as it came by the comment rule', async () => {
  const [doc] = (await fixtureLines('translated-post.jsonl')).map(parseLine);
  const [container] = findAll(doc, (v) => v.__typename === AUTO_TRANSLATED);
  assert.ok(container.story.translation.message.text);
  const before = JSON.stringify(doc);
  assert.deepEqual(untranslate(doc), { comments: 0, copies: 0 });
  assert.equal(JSON.stringify(doc), before);
});

// The post rule keeps the layout and its code, and gives the translation the post's own words.
test("a real auto-translated post draws the words as written, with nothing else changed", async () => {
  const [line] = await fixtureLines('translated-post.jsonl');
  const doc = parseLine(line);
  const [sections] = findAll(doc, (v) => v.message_container?.__typename === AUTO_TRANSLATED);
  const own = sections.message.story.message.text;
  assert.notEqual(sections.message_container.story.translation.message.text, own);
  const expected = parseLine(line);
  const [target] = findAll(expected, (v) => v.message_container?.__typename === AUTO_TRANSLATED);
  target.message_container.story.translation.message.text = own;
  assert.equal(untranslatePosts(doc), 1);
  assert.deepEqual(doc, expected, 'only the translated text changes: layout, modules and See original stay');
  assert.equal(untranslatePosts(doc), 0, 'done once, it is left alone');
});

test("a post's words go back only from its own plain message, and mentions move like a comment's", () => {
  const sections = (overrides = {}) => ({
    message: { __typename: 'CometFeedStoryDefaultMessageRenderingStrategy', story: { id: 'UzpfSTE=', message: { text: 'Merci Jean pour cet article', ranges: [{ entity: { id: '100' }, offset: 6, length: 4 }] } } },
    message_container: {
      __typename: AUTO_TRANSLATED,
      story: { id: 'UzpfSTE=', translation: { message: { text: 'Thanks Jean for this article', ranges: [richMention(7, 4)], delight_ranges: [{ offset: 0, length: 6 }] } } },
    },
    ...overrides,
  });
  const one = sections();
  assert.equal(restorePost(one), true);
  const shown = one.message_container.story.translation.message;
  assert.equal(shown.text, 'Merci Jean pour cet article');
  assert.deepEqual(shown.ranges, [richMention(6, 4)]);
  assert.deepEqual(shown.delight_ranges, [], "highlights pointing into the translation's words go");
  const other = sections();
  other.message.story.id = 'UzpfSTI=';
  assert.equal(restorePost(other), false, "another story's words never go in");
  const plainLayout = sections();
  plainLayout.message_container.__typename = 'CometFeedStoryDefaultMessageRenderingStrategy';
  assert.equal(restorePost(plainLayout), false);
  assert.equal(restorePost(sections({ message: null })), false);
  assert.equal(restorePost(null), false);
});

test('the post rule works through JSON.parse only, and finds a post by its layout name', async () => {
  const [line] = await fixtureLines('translated-post.jsonl');
  const rules = [];
  let changed = 0;
  commentsAsWritten.setup({ net: { transformResponses: (rule) => rules.push(rule) }, enabled: () => true, diagnostics: { add() {}, changed: () => changed++ } });
  const rule = rules.find((r) => r.id === 'noAutoTranslate-posts');
  assert.equal(rule.match({ transport: 'json-parse' }), true);
  assert.equal(rule.match({ transport: 'xhr' }), false);
  assert.ok(!line.includes('MACHINE_TRANSLATION') && POST_MARKERS.every((marker) => line.includes(marker)), 'the comment marker misses a post, the layout name finds it');
  const ctx = { transport: 'json-parse' };
  const out = transformDocumentLine(line, rulesFor(line, rules).filter((r) => r.match(ctx)), ctx);
  assert.notEqual(out, line);
  assert.equal(changed, 1);
});

test("a partial copy in a later answer is marked too, but only for a comment that was put back", () => {
  const remembered = new Map();
  untranslate({ data: { comment: comment() } }, remembered);
  const later = () => ({ data: { link: { __typename: 'XFBCommentTranslationActionLink', comment: { id: 'Y29tbWVudDox', preferred_body: { __typename: 'TextWithEntities', translation_type: 'MACHINE_TRANSLATION' } } } } });
  const seen = later();
  assert.deepEqual(untranslate(seen, remembered), { comments: 0, copies: 1 });
  assert.equal(seen.data.link.comment.preferred_body.translation_type, 'ORIGINAL');
  const unknown = later();
  assert.deepEqual(untranslate(unknown, new Map()), { comments: 0, copies: 0 });
  assert.equal(unknown.data.link.comment.preferred_body.translation_type, 'MACHINE_TRANSLATION');
});

// A real answer to See translation on a comment (captures/2026-10-11-run34, El País), scrubbed:
// the comment again, translated, without its own words, and its link's copy.
test('a comment the reader asked to translate stays translated, and its link offers See original', async () => {
  const [doc] = (await fixtureLines('translated-comment-asked.jsonl')).map(parseLine);
  const node = doc.data.node;
  assert.equal('body' in node, false, 'the answer has no original to put back');
  const link = node.comment_action_links.find((l) => l.__typename === 'XFBCommentTranslationActionLink');
  assert.equal(link.comment.id, node.id);
  // The same comment was put back before the reader clicked.
  const remembered = new Map();
  untranslate({ data: { comment: { ...comment(), id: node.id } } }, remembered);
  assert.equal(remembered.get(node.id), RESTORED);
  const before = JSON.stringify(doc);
  assert.deepEqual(untranslate(doc, remembered), { comments: 0, copies: 0 });
  assert.equal(JSON.stringify(doc), before, 'nothing in the answer changes');
  assert.equal(link.comment.preferred_body.translation_type, 'MACHINE_TRANSLATION');
  assert.equal(remembered.get(node.id), ASKED);
  // A later answer with the comment and its own words leaves the translation the reader chose.
  const again = { data: { comment: { ...comment(), id: node.id } } };
  assert.deepEqual(untranslate(again, remembered), { comments: 0, copies: 0 });
  assert.equal(again.data.comment.preferred_body.translation_type, 'MACHINE_TRANSLATION');
  // See original sends the comment back untranslated, and it's put back as usual after that.
  untranslate({ data: { node: { id: node.id, preferred_body: { text: 'x', translation_type: 'ORIGINAL' } } } }, remembered);
  assert.equal(remembered.has(node.id), false);
  const after = { data: { comment: { ...comment(), id: node.id } } };
  assert.deepEqual(untranslate(after, remembered), { comments: 1, copies: 0 });
});

test('See original after See translation is followed, so the comment shows as written when it comes again', async () => {
  // Live 2026-10-11, run 47: the answers to both clicks on one comment, scrubbed.
  const [askedLine, originalLine] = await fixtureLines('translated-comment-original.jsonl');
  const id = parseLine(askedLine).data.node.id;
  assert.equal(parseLine(originalLine).data.node.id, id);
  assert.ok(!originalLine.includes('MACHINE_TRANSLATION'), "See original's answer has no translation in it");
  const rules = [];
  commentsAsWritten.setup({ net: { transformResponses: (rule) => rules.push(rule) }, enabled: () => true, diagnostics: { add() {}, changed() {} } });
  const ctx = { transport: 'json-parse' };
  // The way the page picks rules for a parse: markers in the text first, then on and matching.
  const run = (line) => transformDocumentLine(line, rulesFor(line, rules).filter((rule) => rule.enabled() && rule.match(ctx)), ctx);
  const reopened = () => JSON.parse(run(JSON.stringify({ data: { comment: { ...comment(), id } } }))).data.comment.preferred_body.translation_type;
  assert.equal(reopened(), 'ORIGINAL', 'put back before the reader clicked');
  assert.equal(run(askedLine), askedLine, "See translation's answer goes through as Facebook sent it");
  assert.equal(reopened(), 'MACHINE_TRANSLATION', 'the translation the reader asked for stays');
  assert.equal(run(originalLine), originalLine);
  assert.equal(reopened(), 'ORIGINAL', 'after See original it shows as written again');
});

test('the rule waiting for See original only runs while a translated comment waits for it', () => {
  const rules = [];
  commentsAsWritten.setup({ net: { transformResponses: (rule) => rules.push(rule) }, enabled: () => true, diagnostics: { add() {}, changed() {} } });
  const waiting = rules.find((rule) => rule.id === 'noAutoTranslate-original');
  assert.equal(waiting.enabled(), false);
  const book = new CommentBook();
  book.set('a', ASKED);
  book.set('b', RESTORED);
  book.set('a', ASKED);
  assert.equal(book.asked, 1);
  book.set('a', RESTORED);
  assert.equal(book.asked, 0);
  book.set('c', ASKED);
  book.delete('c');
  book.delete('missing');
  assert.equal(book.asked, 0);
  assert.equal(forgetAsked({ data: { node: { id: 'b', preferred_body: { text: 'x', translation_type: 'ORIGINAL' } } } }, book), 0, 'only asked comments are forgotten');
  book.set('d', ASKED);
  const whole = { data: { node: { id: 'd', body: { text: 'Bonjour' }, preferred_body: { text: 'Bonjour', translation_type: 'ORIGINAL' } } } };
  assert.equal(forgetAsked(whole, book), 1, 'a See original answer that brings the whole comment counts too');
  assert.equal(book.has('d'), false);
  assert.equal(book.asked, 0);
});

test('an answer another rule fails on takes back what it taught the book, and counts nothing', () => {
  const rules = [];
  let changed = 0;
  commentsAsWritten.setup({ net: { transformResponses: (rule) => rules.push(rule) }, enabled: () => true, diagnostics: { add() {}, changed: () => changed++ } });
  const [rule] = rules;
  const broken = { id: 'broken', transform() { throw new Error('boom'); } };
  assert.equal(applyRules({ data: { comment: comment() } }, [rule, broken], { transport: 'json-parse' }, () => {}), FAILED);
  assert.equal(changed, 0);
  // The page got the comment translated, so its link's copy in a later answer stays translated.
  const copy = { data: { link: { __typename: 'XFBCommentTranslationActionLink', comment: { id: 'Y29tbWVudDox', preferred_body: { __typename: 'TextWithEntities', translation_type: 'MACHINE_TRANSLATION' } } } } };
  assert.equal(rule.transform(copy), false);
  assert.equal(copy.data.link.comment.preferred_body.translation_type, 'MACHINE_TRANSLATION');
  const book = new CommentBook();
  book.set('a', ASKED);
  book.set('b', RESTORED);
  const restore = book.checkpoint();
  book.delete('a');
  book.set('c', ASKED);
  book.set('d', ASKED);
  restore();
  assert.deepEqual([...book], [['a', ASKED], ['b', RESTORED]]);
  assert.equal(book.asked, 1);
});

test('the comments it remembers are capped, oldest first', () => {
  const remembered = new Map();
  for (let i = 0; i < 5001; i++) untranslate({ data: { comment: { ...comment(), id: `c${i}` } } }, remembered);
  assert.equal(remembered.size, 5000);
  assert.equal(remembered.has('c0'), false);
  assert.equal(remembered.has('c1'), true);
  assert.equal(remembered.has('c5000'), true);
});

test('the feature works through JSON.parse only, and its marker finds a translated comment', () => {
  const rules = [];
  let changed = 0;
  commentsAsWritten.setup({ net: { transformResponses: (rule) => rules.push(rule) }, enabled: () => true, diagnostics: { add() {}, changed: () => changed++ } });
  const [rule] = rules;
  assert.equal(rule.match({ transport: 'json-parse' }), true);
  assert.equal(rule.match({ transport: 'xhr', friendlyName: 'CometSinglePostDialogContentQuery' }), false);
  const doc = { data: { comment: comment() } };
  const line = JSON.stringify(doc);
  assert.ok(MARKERS.some((marker) => line.includes(marker)));
  assert.notDeepEqual(JSON.parse(transformDocumentLine(line, rules, { transport: 'json-parse' })), doc);
  assert.equal(changed, 1);
  // A translated post, or an answer with nothing translated, is left as it came.
  for (const untouched of [{ data: { story: post() } }, { data: { comment: { ...comment(), preferred_body: { text: 'x', translation_type: 'ORIGINAL' } } } }]) {
    const text = JSON.stringify(untouched);
    assert.equal(transformDocumentLine(text, rules, { transport: 'json-parse' }), text);
  }
});
