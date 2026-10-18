// Hide posts by words: the phrase engine, the fields read from Facebook's data and from the
// page, and the feature's two layers.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { fixtureLines, parseLine } from './helpers/fixtures.js';
import { createDiagnostics } from '../src/core/diagnostics.js';
import { createHider, MARK, NOTE } from '../src/core/dom/hide.js';
import { createPostTracker } from '../src/core/dom/posts.js';
import { compileFilters, filterCache, firstMatch, matchingRules } from '../src/core/filters/engine.js';
import { postFields } from '../src/core/filters/page.js';
import { storyFields } from '../src/core/filters/story.js';
import { parseRoute } from '../src/core/route.js';
import { transformDocumentLine } from '../src/core/net/payload.js';
import hidePostsByWords, { createPreviewTally, filterMatches, filterVerdict, previewReport, pruneFiltered, skipNotice } from '../src/features/feed/filters.js';
import { createSettings, EXPORT_SCHEMA } from '../src/core/settings.js';
import { createMemoryStorage } from '../src/core/storage.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const matchOf = (text, values) => firstMatch(compileFilters(text).rules, values)?.phrase ?? null;

test('plain phrases match whole words and ignore case', () => {
  assert.equal(matchOf('cat', ['My Cat is here']), 'cat');
  assert.equal(matchOf('cat', ['concatenate', 'cats']), null);
  assert.equal(matchOf('new york', ['Back in New   York today']), 'new york');
  assert.equal(matchOf('café', ['Le Café du coin']), 'café');
  assert.equal(matchOf('c++', ['learning c++ today']), 'c++');
  assert.equal(matchOf('#news', ['breaking #news now']), '#news');
  assert.equal(matchOf('example.com', ['www.example.com']), 'example.com');
  assert.equal(matchOf('spoiler', [`spoi${String.fromCharCode(0x200b)}ler alert`]), 'spoiler', 'zero-width marks are ignored');
});

test('re: lines are case-insensitive patterns, bad ones are reported and skipped', () => {
  assert.equal(matchOf('re:\\bgiveaway(s)?\\b', ['HUGE GIVEAWAYS here']), 're:\\bgiveaway(s)?\\b');
  const { rules, errors } = compileFilters('# a comment\n\nre:(unclosed\nre:\nkeep');
  assert.deepEqual(rules.map((rule) => rule.phrase), ['keep']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
});

// re: lines used to run on the browser's RegExp with i and u (and plain i when u refused the
// pattern). RE2JS has to give the same answer on every line here, so lists people already
// have keep hiding the same posts.
const LEGACY_CORPUS = [
  ['café', ['CAFÉ au lait', 'cafe']],
  ['école', ['ÉCOLE', 'ecole']],
  ['σοφία', ['ΣΟΦΊΑ', 'Σοφία', 'sofia']],
  ['straße', ['STRASSE', 'Straße']],
  ['привет', ['ПРИВЕТ мир', 'привт']],
  ['\\bgiveaway(s)?\\b', ['HUGE GIVEAWAYS here', 'giveawayss']],
  ['\\bnaïve\\b', ['so naïve really', 'naive']],
  ['\\p{L}+ \\d{3}', ['abc 123', '123 456']],
  ['not( ?sponsored)', ['Not Sponsored', 'nothing']],
  ['\\-', ['a-b', 'ab']],
  ['[\\-x]', ['-', 'y']],
  ['a\\/b', ['a/b', 'ab']],
  ['\\u00e9', ['É', 'e']],
  ['\\u{1F600}', [String.fromCodePoint(0x1f600), ':)']],
  ['^free', ['Free stuff', 'not free']],
  ['stuff$', ['Free stuff', 'stuff here']],
  ['(?<!not )sponsored', ['sponsored', 'not sponsored']],
  ['(?<=buy )now', ['Buy now', 'now']],
  ['(?<word>cat)s?', ['Cats', 'dog']],
  ['x*?y', ['xxy', 'xx']],
  ['[^a]', [String.fromCodePoint(0x1f600), 'a']],
  ['k', ['K', 'x']],
];

const legacyRegex = (source) => {
  try {
    return new RegExp(source, 'iu');
  } catch {
    return new RegExp(source, 'i');
  }
};

test('re: lines give the answers the browser RegExp gave, Unicode and case included', () => {
  for (const [source, values] of LEGACY_CORPUS) {
    const { rules, errors } = compileFilters(`re:${source}`);
    assert.deepEqual(errors, [], source);
    const before = legacyRegex(source);
    for (const value of values) assert.equal(rules[0].re.test(value), before.test(value), `${source} on ${value}`);
    assert.ok(values.some((value) => before.test(value)) && values.some((value) => !before.test(value)), `${source} has a hit and a miss`);
  }
});

// Lines RE2 can't run, in a list that also has lines it can.
const LEGACY_LIST = [
  're:foo(?!bar)',
  're:(\\w)\\1',
  're:(?<word>cat) \\k<word>',
  're:(?<!(not) )sponsored',
  're:\\p{Script=Greek}',
  're:a{1001}',
  're:(unclosed',
  're:(?<!not )sponsored',
  'keep',
].join('\n');

test('a pattern RE2 cannot run is skipped with a reason, and the other lines still work', () => {
  const { rules, errors } = compileFilters(LEGACY_LIST);
  assert.deepEqual(errors.map(({ line, reason }) => [line, reason]), [
    [1, 'looks ahead'],
    [2, 'refers back to a group'],
    [3, 'refers back to a group'],
    [4, 'has a group inside a look-behind'],
    [5, 'uses an unknown \\p{...} name'],
    [6, 'repeats more than 1000 times'],
    [7, "isn't a valid pattern"],
  ]);
  assert.ok(errors.every((error) => error.message.length > 0));
  assert.deepEqual(rules.map((rule) => rule.phrase), ['re:(?<!not )sponsored', 'keep']);
  assert.equal(firstMatch(rules, ['Sponsored post'])?.phrase, 're:(?<!not )sponsored');
  assert.equal(firstMatch(rules, ['not sponsored']), null);
  assert.equal(firstMatch(rules, ['keep this'])?.phrase, 'keep');
  // translateRegExp alone would have read \k<word> as the letters "k<word>".
  assert.equal(firstMatch(rules, ['cat k<word>']), null);
});

test('saved settings and backups keep skipped lines as written, and the feature names them', async () => {
  const features = [hidePostsByWords];
  const saved = createSettings({ storage: createMemoryStorage({ settings: { hidePostsByWords: true, 'hidePostsByWords.words': LEGACY_LIST } }), features, migrations: [] });
  assert.equal(saved.get('hidePostsByWords.words'), LEGACY_LIST);
  const exported = JSON.parse(saved.exportJson());
  assert.equal(exported.settings['hidePostsByWords.words'], LEGACY_LIST);

  const restored = createSettings({ storage: createMemoryStorage(), features, migrations: [] });
  const backup = JSON.stringify({ app: 'HushFacebook Web', schema: EXPORT_SCHEMA, version: '0.0.1', settings: exported.settings });
  const { applied } = await restored.importJson(backup);
  assert.deepEqual(applied.sort(), ['hidePostsByWords', 'hidePostsByWords.words']);
  assert.equal(restored.get('hidePostsByWords.words'), LEGACY_LIST);
  assert.equal(JSON.parse(restored.exportJson()).settings['hidePostsByWords.words'], LEGACY_LIST);

  const win = page(post(1, { text: 'Sponsored' }) + post(2, { text: 'foobaz' }));
  const toasts = [];
  const { doc, diagnostics, warnings, set, posts } = setupFeature(win, {
    words: restored.get('hidePostsByWords.words'), toast: (...shown) => toasts.push(shown), storage: createMemoryStorage(),
  });
  const rows = Object.fromEntries(diagnostics.rows().map(({ label, value }) => [label, value]));
  assert.equal(rows["Filter lines that aren't valid"], "line 1 (looks ahead), line 2 (refers back to a group), line 3 (refers back to a group), line 4 (has a group inside a look-behind), line 5 (uses an unknown \\p{...} name), line 6 (repeats more than 1000 times), line 7 (isn't a valid pattern)");
  assert.equal(warnings.length, 7);
  assert.equal(warnings[0], 'Filter line 1 is skipped because it looks ahead. It stays in your list as you wrote it');
  assert.deepEqual(toasts, [['Filter lines 1, 2, 3 and 4 more are skipped. Diagnostics says why.', { tone: 'error' }]]);
  assert.equal(doc.querySelectorAll(`[${MARK}]`).length, 1, 'the look-behind line still hides the Sponsored post');
  set('words', `${LEGACY_LIST}\n`);
  assert.equal(toasts.length, 2, 'a changed list is told again');
  set('words', 'cats');
  assert.equal(toasts.length, 2, 'a list with nothing skipped is not');
  posts.stop();
});

test('one skipped line is named in the toast with its reason', () => {
  assert.equal(skipNotice([{ line: 4, reason: 'looks ahead' }]), 'Filter line 4 is skipped because it looks ahead.');
  assert.equal(skipNotice([{ line: 2, reason: 'x' }, { line: 9, reason: 'y' }]), 'Filter lines 2 and 9 are skipped. Diagnostics says why.');
});

test('no rule keeps state between tests, so the same text always gets the same answer', () => {
  const { rules } = compileFilters('cat\nre:dog');
  for (let i = 0; i < 4; i++) {
    assert.equal(firstMatch(rules, ['a cat'])?.phrase, 'cat');
    assert.equal(firstMatch(rules, ['a dog'])?.phrase, 're:dog');
  }
  assert.ok(rules.every((rule) => !rule.re.global && !rule.re.sticky));
});

test('each rule knows its line in the list, and matchingRules finds every line that matches', () => {
  const { rules } = compileFilters('# a note\ncat\n\nre:do+g\nbird');
  assert.deepEqual(rules.map((rule) => [rule.line, rule.phrase]), [[2, 'cat'], [4, 're:do+g'], [5, 'bird']]);
  assert.deepEqual(matchingRules(rules, ['A cat and a doooog', null]).map((rule) => rule.line), [2, 4]);
  assert.deepEqual(matchingRules(rules, ['nothing']), []);
  assert.deepEqual(matchingRules([], ['cat']), []);
});

test('filterCache compiles once per distinct text', () => {
  const cache = filterCache();
  const a = cache('cat');
  assert.equal(cache('cat'), a);
  assert.notEqual(cache('dog'), a);
});

// A story shaped like the live ones: text in message_container, author in actors, alt text on
// the media, a link through l.facebook.com, comments under feedback.
const story = (extra = {}) => ({
  __typename: 'Story',
  __isFeedUnit: 'Story',
  id: 's1',
  comet_sections: {
    content: { story: {
      actors: [{ __typename: 'User', name: 'Pat Example' }],
      to: { __typename: 'Group', name: 'Garden Swap Group' },
      comet_sections: { message_container: { story: { message: { text: 'Fresh bread at the market' } } } },
      attachments: [{ styles: { __typename: 'StoryAttachmentPhotoStyleRenderer', attachment: { media: { __typename: 'Photo', accessibility_caption: 'May be an image of bread' } } } }],
      ...extra,
    } },
    feedback: { story: { story_ufi_container: { story: { message: { text: 'a comment about kittens' } } } } },
  },
});

test('story fields: text, authors, alt text, linked sites and kind, without the comments', () => {
  const linked = story({ message: { ranges: [{ entity: { external_url: `https://l.facebook.com/l.php?u=${encodeURIComponent('https://www.news.example/a')}` } }] } });
  const fields = storyFields(linked);
  assert.deepEqual(fields.text, ['Fresh bread at the market']);
  assert.deepEqual(fields.authors, ['Pat Example', 'Garden Swap Group']);
  assert.deepEqual(fields.alt, ['May be an image of bread']);
  assert.deepEqual(fields.sites, ['news.example']);
  assert.deepEqual([...fields.kinds], ['photo']);
  const colored = storyFields(story({ text_format_metadata: { background_color: 'FF1B74E4' } }));
  assert.ok(colored.kinds.has('colored'));
  assert.ok(!storyFields(story({ text_format_metadata: null })).kinds.has('colored'));
});

test('a verdict names the phrase or the kind of post', () => {
  const filter = (text, kinds = []) => ({ ...compileFilters(text), kinds: new Set(kinds) });
  const fields = storyFields(story());
  assert.equal(filterVerdict(filter('bread'), fields), 'bread');
  assert.equal(filterVerdict(filter('Pat Example'), fields), 'Pat Example');
  assert.equal(filterVerdict(filter('kittens'), fields), null, 'comments never count');
  assert.equal(filterVerdict(filter('', ['photo']), fields), 'photo posts');
  assert.equal(filterVerdict(filter('', ['video']), fields), null);
});

test('the captured Home page: a story goes by its author, its cursor stays, the rest stay whole', async () => {
  const lines = await fixtureLines('CometNewsFeedPaginationQuery.jsonl');
  const first = parseLine(lines[0]);
  const fields = storyFields(first.data.viewer.news_feed.edges[0].node);
  assert.ok(fields.authors.length > 0 && fields.text.length > 0, 'the capture has authors and text where the reader looks');
  const author = fields.authors[0];
  const filter = { ...compileFilters(author), kinds: new Set() };
  const doc = parseLine(lines[0]);
  assert.deepEqual(pruneFiltered(doc, filter), [author]);
  const [edge] = doc.data.viewer.news_feed.edges;
  assert.equal('node' in edge, false);
  assert.equal(edge.cursor, first.data.viewer.news_feed.edges[0].cursor);
  const none = { ...compileFilters('zzzz-not-there'), kinds: new Set() };
  for (const line of lines) {
    const untouched = parseLine(line);
    const before = structuredClone(untouched);
    assert.deepEqual(pruneFiltered(untouched, none), []);
    assert.deepEqual(untouched, before);
  }
});

function page(html, href = 'https://www.facebook.com/') {
  const win = testWindow(href);
  windows.push(win);
  win.document.body.innerHTML = `<div role="main"><div class="feed">${html}</div></div>`;
  return win;
}

const post = (n, { author = 'Friend', text = 'Hello', extra = '' } = {}) => `
  <div><div aria-posinset="${n}">
    <h4><a href="/p${n}">${author}</a></h4><a href="/p${n}/posts/pfbid0P${n}">2h</a>
    <div data-ad-rendering-role="story_message"><div>${text}</div></div>${extra}
  </div></div>`;

test('page fields: text, author, alt, sites and kind, without the comments', () => {
  const extra = `<a href="/photo/?fbid=1"><img alt="May be an image of a dog" src="x.jpg"></a>
    <a href="https://l.facebook.com/l.php?u=${encodeURIComponent('https://shop.example/x')}">shop</a>
    <div role="article" aria-label="Comment by Someone"><h4><a href="/c">Commenter</a></h4><div data-ad-rendering-role="story_message">kittens</div></div>`;
  const win = page(post(1, { author: 'Pat Example', text: 'Our new puppy', extra }));
  const fields = postFields(win.document.querySelector('[aria-posinset]'));
  assert.deepEqual(fields.text, ['Our new puppy']);
  assert.deepEqual(fields.authors, ['Pat Example']);
  assert.deepEqual(fields.alt, ['May be an image of a dog']);
  assert.deepEqual(fields.sites, ['shop.example']);
  assert.deepEqual([...fields.kinds].sort(), ['link', 'photo']);
});

function setupFeature(win, { words = '', kinds = {}, preview = false, net = null, href, toast, storage } = {}) {
  const doc = win.document;
  const values = { words, preview, ...kinds };
  const subscribers = [];
  const posts = createPostTracker({ doc });
  const hider = createHider({ doc, posts });
  const diagnostics = createDiagnostics();
  const warnings = [];
  hidePostsByWords.setup({
    net, router: { current: () => parseRoute(href ?? win.location.href) }, posts, hider, diagnostics, toast, storage,
    log: { warn: (message) => warnings.push(message), error() {}, info() {} },
    settings: { subscribe: (fn) => subscribers.push(fn) }, enabled: () => true, option: (key) => values[key],
  });
  const set = (key, value) => {
    values[key] = value;
    for (const fn of subscribers) fn({});
  };
  return { doc, posts, hider, diagnostics, warnings, set };
}

test('on the page, a matching post is hidden with the phrase in its note, and a new list applies at once', () => {
  const win = page(post(1, { text: 'Big football game tonight' }) + post(2, { text: 'Garden photos' }) + post(3, { author: 'Loud Page' }));
  const { doc, posts, diagnostics, warnings, set } = setupFeature(win, { words: 'football\nloud page\nre:(' });
  const notes = () => [...doc.querySelectorAll('[aria-posinset]')].map((p) => p.querySelector(`[${MARK}]`)?.getAttribute(NOTE) ?? null);
  assert.deepEqual(notes(), ['Hidden: Filter: football. Show', null, 'Hidden: Filter: loud page. Show']);
  const rows = Object.fromEntries(diagnostics.rows().map(({ label, value }) => [label, value]));
  assert.equal(rows['Posts hidden by your filters'], 'football 1, loud page 1');
  assert.equal(rows["Filter lines that aren't valid"], "line 3 (isn't a valid pattern)");
  assert.equal(warnings.length, 1);
  set('words', 'garden');
  assert.deepEqual(notes(), [null, 'Hidden: Filter: garden. Show', null]);
  posts.stop();
});

test('a post opened by its link, a profile and an empty list are left alone', () => {
  for (const href of ['https://www.facebook.com/p1/posts/pfbid0P1', 'https://www.facebook.com/someone']) {
    const win = page(post(1, { text: 'football' }), href);
    const { doc, posts } = setupFeature(win, { words: 'football', href });
    assert.equal(doc.querySelector(`[${MARK}]`), null, href);
    posts.stop();
  }
  const win = page(post(1, { text: 'football' }));
  const { doc, posts } = setupFeature(win, { words: '\n# nothing\n' });
  assert.equal(doc.querySelector(`[${MARK}]`), null);
  posts.stop();
});

test('in page mode the data rule drops matching feed stories on Home and leaves search alone', async () => {
  const rules = [];
  const win = page('');
  const { posts } = setupFeature(win, { words: 'bread', net: { transformResponses: (rule) => rules.push(rule) } });
  const rule = rules.find((candidate) => candidate.id === 'hidePostsByWords');
  assert.deepEqual(rule.markers, ['"__isFeedUnit"']);
  const answer = { data: { viewer: { news_feed: { edges: [{ node: story(), cursor: 'c1' }, { node: { ...story(), id: 's2', comet_sections: {} }, cursor: 'c2' }] } } } };
  const line = JSON.stringify(answer);
  const feed = { transport: 'xhr', path: '/api/graphql/', friendlyName: 'CometNewsFeedPaginationQuery' };
  const out = JSON.parse(transformDocumentLine(line, [rule], feed));
  assert.deepEqual(out.data.viewer.news_feed.edges.map((edge) => edge.node?.id ?? null), [null, 's2']);
  const search = { ...feed, friendlyName: 'SearchCometResultsPaginatedResultsQuery' };
  assert.equal(transformDocumentLine(line, [rule], search), line);
  posts.stop();
});

test('a story in an answer another rule fails on is not counted or reported as filtered', () => {
  const rules = [];
  const win = page('');
  const { posts, diagnostics } = setupFeature(win, { words: 'bread', net: { transformResponses: (rule) => rules.push(rule) } });
  const broken = { id: 'broken', transform() { throw new Error('boom'); } };
  const line = JSON.stringify({ data: { viewer: { news_feed: { edges: [{ node: story(), cursor: 'c1' }] } } } });
  const feed = { transport: 'xhr', path: '/api/graphql/', friendlyName: 'CometNewsFeedPaginationQuery' };
  const hidden = () => diagnostics.rows().find((row) => row.label === 'Posts hidden by your filters').value;
  assert.equal(transformDocumentLine(line, [rules[0], broken], feed, () => {}), line);
  assert.equal(hidden(), 'None yet');
  assert.equal(diagnostics.decisions().length, 0);
  transformDocumentLine(line, rules, feed);
  assert.equal(hidden(), 'bread 1');
  assert.equal(diagnostics.decisions().length, 1);
  posts.stop();
});

test('a filter decision keeps the matched words for the panel, out of what Copy report reads', () => {
  const rules = [];
  const win = page('');
  const { posts, diagnostics } = setupFeature(win, { words: 'bread', net: { transformResponses: (rule) => rules.push(rule) } });
  const line = JSON.stringify({ data: { viewer: { news_feed: { edges: [{ node: story(), cursor: 'c1' }] } } } });
  transformDocumentLine(line, rules, { transport: 'xhr', path: '/api/graphql/', friendlyName: 'CometNewsFeedPaginationQuery' });
  const [decision] = diagnostics.decisions();
  assert.equal(decision.rule, 'Filter');
  assert.equal(decision.detail, 'bread');
  assert.equal(decision.signal, '');
  posts.stop();
});

const FEED = { transport: 'xhr', path: '/api/graphql/', friendlyName: 'CometNewsFeedPaginationQuery' };
const feedLine = (...nodes) => JSON.stringify({ data: { viewer: { news_feed: { edges: nodes.map((node, n) => ({ node, cursor: `c${n}` })) } } } });

test("preview finds the same lines and kinds in a story's data as in the post Facebook draws from it", () => {
  const extra = `<a href="/photo/?fbid=1"><img alt="May be an image of bread" src="x.jpg"></a>
    <div role="article" aria-label="Comment by Someone"><h4><a href="/c">Commenter</a></h4><div data-ad-rendering-role="story_message">kittens</div></div>`;
  const win = page(post(1, { author: 'Pat Example', text: 'Fresh bread at the market', extra }));
  const filter = { ...compileFilters('market\nkittens\nPat Example\nre:image of\nnot there'), kinds: new Set(['photo', 'video']) };
  const fromData = filterMatches(filter, storyFields(story()));
  assert.deepEqual(fromData, ['photo posts', 'line 1', 'line 3', 'line 4']);
  assert.deepEqual(filterMatches(filter, postFields(win.document.querySelector('[aria-posinset]'))), fromData);
  const none = { ...compileFilters('kittens'), kinds: new Set(['video']) };
  assert.deepEqual(filterMatches(none, storyFields(story())), []);
  assert.equal(filterVerdict(none, storyFields(story())), null, 'no match in preview is no verdict when hiding');
});

test('preview hides nothing on the page or in the data, then Preview off hides what it counted', () => {
  const rules = [];
  const writes = [];
  const win = page(post(1, { text: 'Big football game tonight' }) + post(2, { text: 'Garden photos' }) + post(3, { author: 'Loud Page', text: 'football again' }));
  const { doc, posts, diagnostics, set } = setupFeature(win, {
    words: 'football\nloud page\nbread', preview: true,
    net: { transformResponses: (rule) => rules.push(rule) },
    storage: { get: () => null, set: (key) => writes.push(key) },
  });
  assert.equal(doc.querySelector(`[${MARK}]`), null, 'no post is hidden');
  const line = feedLine(story(), { ...story(), id: 's2', comet_sections: {} });
  assert.equal(transformDocumentLine(line, rules, FEED), line, 'the answer reaches the page as Facebook sent it');
  assert.equal(transformDocumentLine(line, rules, FEED), line, 'and a story seen twice counts once');
  assert.equal(diagnostics.decisions().length, 0, 'preview records no decisions');
  assert.deepEqual(writes, [], 'and keeps nothing in storage');
  const rows = Object.fromEntries(diagnostics.rows().map(({ label, value, shareable }) => [label, { value, shareable }]));
  assert.equal(rows['Posts hidden by your filters'].value, 'None yet');
  assert.deepEqual(rows['Filter preview'], { value: 'data: 1 of 2 stories matches (line 3 1), page: 2 of 3 posts match (line 1 2, line 2 1)', shareable: true });
  assert.equal(diagnostics.statusOf('hidePostsByWords'), "Preview is on, so nothing is hidden. In Facebook's data, 1 of 2 stories matches (line 3 \"bread\" 1). On the page, 2 of 3 posts match (line 1 \"football\" 2, line 2 \"loud page\" 1). Turn Preview off to hide them.");
  set('preview', false);
  assert.equal(doc.querySelectorAll(`[${MARK}]`).length, 2, 'the posts it counted are hidden now');
  assert.equal(diagnostics.statusOf('hidePostsByWords'), null);
  assert.equal(diagnostics.rows().find((row) => row.label === 'Filter preview').value, 'Off');
  assert.deepEqual(JSON.parse(transformDocumentLine(line, rules, FEED)).data.viewer.news_feed.edges.map((edge) => edge.node?.id ?? null), [null, 's2']);
  posts.stop();
});

test('preview tells nothing checked yet apart from nothing matching, and an empty list apart from both', () => {
  const rules = [];
  const status = (diagnostics) => diagnostics.statusOf('hidePostsByWords');
  const empty = setupFeature(page(''), { words: 'zebra', preview: true, net: { transformResponses: (rule) => rules.push(rule) } });
  assert.equal(status(empty.diagnostics), "Preview is on, so nothing is hidden. In Facebook's data, no stories checked yet. On the page, no posts checked yet. Open Home or a group and scroll a little.");
  empty.posts.stop();
  rules.length = 0;
  const quiet = setupFeature(page(post(1)), { words: 'zebra', preview: true, net: { transformResponses: (rule) => rules.push(rule) } });
  transformDocumentLine(feedLine(story()), rules, FEED);
  assert.equal(status(quiet.diagnostics), "Preview is on, so nothing is hidden. In Facebook's data, no matches in 1 story. On the page, no matches in 1 post.");
  quiet.set('words', 'bread');
  assert.equal(status(quiet.diagnostics), "Preview is on, so nothing is hidden. In Facebook's data, no stories checked yet. On the page, no matches in 1 post.", 'a new list starts counting again, and the post on the page is looked at again');
  quiet.posts.stop();
  const blank = setupFeature(page(post(1)), { words: '', preview: true });
  assert.equal(status(blank.diagnostics), 'Preview is on. Add a word or turn on a kind of post to see what it would hide.');
  blank.posts.stop();
});

test('preview counts stop at their limit and say so', () => {
  const tally = createPreviewTally(3);
  for (let n = 0; n < 5; n += 1) tally.see(`p${n}`, n % 2 ? [] : ['line 1']);
  tally.see('p0', ['line 2']);
  const summary = tally.summary();
  assert.equal(summary.checked, 3);
  assert.equal(summary.full, true);
  assert.deepEqual(summary.counts, [['line 1', 2], ['line 2', 1]]);
  assert.equal(previewReport({ data: summary, page: null }), 'data: 2 of 3+ stories match (line 1 2, line 2 1)');
});
