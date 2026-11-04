// Hide posts by words: the phrase engine, the fields read from Facebook's data and from the
// page, and the feature's two layers.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { fixtureLines, parseLine } from './helpers/fixtures.js';
import { createActions } from '../src/core/actions.js';
import { createDiagnostics } from '../src/core/diagnostics.js';
import { createHider, MARK, NOTE } from '../src/core/dom/hide.js';
import { createPostTracker } from '../src/core/dom/posts.js';
import { compileFilters, filterCache, firstMatch, matchingRules } from '../src/core/filters/engine.js';
import { compileNames, compileSites, matchingNames, matchingSites } from '../src/core/filters/lists.js';
import { commentFields, postFields } from '../src/core/filters/page.js';
import { storyFields } from '../src/core/filters/story.js';
import { parseRoute } from '../src/core/route.js';
import { transformDocumentLine } from '../src/core/net/payload.js';
import { adRule } from '../src/features/feed/ad-markers.js';
import hidePostsByWords, { createFilterFuse, createPreviewTally, filterMatches, filterVerdict, fuseReport, previewFiltered, previewReport, pruneFiltered, siteNotice, skipNotice } from '../src/features/feed/filters.js';
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

// The media of a video post, as the attachment renderer carries it.
const videoStory = (media) => story({ attachments: [{ styles: { __typename: 'StoryAttachmentVideoStyleRenderer', attachment: { media: { __typename: 'Video', id: '901', ...media } } } }] });
const sharedStory = () => story({ attached_story: { __typename: 'Story', id: 's0', comet_sections: { message: { story: { message: { text: 'The post that was shared' } } } } } });

test('story fields: a share carries the post it shared, and live is a video Facebook broadcast', () => {
  assert.ok(storyFields(sharedStory()).kinds.has('shared'));
  const beside = story();
  beside.comet_sections.attached_story = { __typename: 'CometStoryAttachedStoryStrategy', story: { id: 's0' } };
  assert.ok(storyFields(beside).kinds.has('shared'), 'the copy Facebook keeps beside the content counts too');
  assert.ok(!storyFields(story()).kinds.has('shared'));
  assert.ok(!storyFields(story({ attached_story: null })).kinds.has('shared'), 'an empty slot is no share');
  const commented = story();
  commented.comet_sections.feedback.story.attached_story = { __typename: 'Story', id: 'c1' };
  assert.ok(!storyFields(commented).kinds.has('shared'), 'a share inside the comments is not this post');
  const live = (media) => storyFields(videoStory(media)).kinds.has('live');
  assert.ok(live({ broadcast_status: 'LIVE', is_live_streaming: true, is_video_broadcast: true }), 'on the air');
  assert.ok(live({ broadcast_status: 'VOD_READY', is_live_streaming: false, is_video_broadcast: true }), 'over, and kept as a recording');
  assert.ok(live({ broadcast_status: 'LIVE' }));
  assert.ok(live({ is_live_streaming: true }));
  assert.ok(!live({ broadcast_status: null, is_live_streaming: false, is_video_broadcast: false }), 'a video that was never live');
  assert.ok(!live({}));
  assert.ok(!storyFields(story({ actors: [{ __typename: 'Page', name: 'News Page', is_live_streaming: true }] })).kinds.has('live'), 'only a video can be live');
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

// A shared post as Facebook draws it on Home: the sharer's header in an h4, then the original
// post's own header in an h5 (live 2026-10-22).
const header = (name, href = `/${name}`, tag = 'h4') => `<div data-ad-rendering-role="profile_name"><${tag}><a href="${href}">${name}</a></${tag}></div>`;
const sharedPost = (n, text = 'Look at this') => `
  <div><div aria-posinset="${n}">
    ${header('Sharer')}<a href="/p${n}/posts/pfbid0P${n}">2h</a>
    <div data-ad-rendering-role="story_message"><div>${text}</div></div>
    <div>${header('Original Poster', '/original', 'h5')}<div data-ad-rendering-role="story_message"><div>The post that was shared</div></div></div>
  </div></div>`;
const livePost = (n, text = 'Come watch') => post(n, { text, extra: '<video></video><div><span>LIVE</span></div>' });

test('page fields: a share draws a second author header, and live shows the badge or links a past live video', () => {
  const win = page(sharedPost(1)
    + `<div><div aria-posinset="2">${header('Garden Swap Group', '/groups/garden')}<div data-ad-rendering-role="story_message"><div>Group post</div></div></div></div>`
    + post(3, { extra: `<div role="article" aria-label="Comment by Someone">${header('Commenter')}</div>${header('Friend')}` })
    + livePost(4)
    + post(5, { extra: '<a href="/watch/live/?v=901">Watch again</a>' })
    + post(6, { text: 'LIVE', extra: '<video></video>' })
    + post(7, { extra: '<div><span>LIVE</span></div>' })
    + post(8, { extra: '<video></video><div><span>Live</span></div><div role="article" aria-label="Comment by Someone"><span>LIVE</span></div>' }));
  const kinds = [...win.document.querySelectorAll('[aria-posinset]')].map((p) => [...postFields(p).kinds].filter((kind) => kind === 'shared' || kind === 'live'));
  assert.deepEqual(kinds, [['shared'], [], [], ['live'], ['live'], [], [], []]);
});

// Colored posts as the groups feed drew them signed in on 2026-11-03: the text on a box whose
// own style sets the background, a picture or a plain gradient.
const coloredText = (style, text = 'Who else is up this early?') => `<div><div style="${style}"><div><div>${text}</div></div></div></div>`;
const PICTURE = 'background-color: rgb(180, 94, 115); background-image: url(&quot;https://scontent.example/v/t39.10873-6/1_n.jpg&quot;); background-position: center center; background-size: cover;';
const GRADIENT = 'background-color: rgb(216, 58, 78); background-image: linear-gradient(45deg, rgb(216, 58, 78), rgb(255, 120, 80));';

test('page fields: a colored background post is told apart by the box its text sits on', () => {
  const win = page(post(1, { text: coloredText(PICTURE) })
    + post(2, { text: coloredText(GRADIENT) })
    + post(3, { text: 'Plain words' })
    // A picture drawn with an inline background outside the text, and a colored comment.
    + post(4, { extra: `<div style="${PICTURE}"></div><div role="article" aria-label="Comment by Someone"><div data-ad-rendering-role="story_message">${coloredText(GRADIENT)}</div></div>` })
    + post(5, { text: '<span style="color: rgb(5, 5, 5)">Styled but not colored</span>' }));
  const colored = [...win.document.querySelectorAll('[aria-posinset]')].map((p) => postFields(p).kinds.has('colored'));
  assert.deepEqual(colored, [true, true, false, false, false]);
  const fields = postFields(win.document.querySelector('[aria-posinset="1"]'));
  assert.deepEqual(fields.text, ['Who else is up this early?'], 'its words still count');
  assert.equal(filterVerdict({ rules: [], kinds: new Set(['colored']) }, fields), 'colored background posts');
  assert.equal(filterVerdict({ rules: [], kinds: new Set(['photo']) }, fields), null);
});

function setupFeature(win, { words = '', lists = {}, kinds = {}, preview = false, net = null, href, toast, storage, actions = createActions() } = {}) {
  const doc = win.document;
  const values = { words, preview, ...lists, ...kinds };
  const subscribers = [];
  const posts = createPostTracker({ doc });
  const hider = createHider({ doc, posts });
  const diagnostics = createDiagnostics();
  const warnings = [];
  hidePostsByWords.setup({
    doc, net, router: { current: () => parseRoute((typeof href === 'function' ? href() : href) ?? win.location.href) }, posts, hider, diagnostics, toast, storage, actions: actions.for('hidePostsByWords'),
    log: { warn: (message) => warnings.push(message), error() {}, info() {} },
    settings: { subscribe: (fn) => subscribers.push(fn) }, enabled: () => true, option: (key) => values[key],
  });
  const set = (key, value) => {
    values[key] = value;
    for (const fn of subscribers) fn({});
  };
  const buttons = () => actions.list('hidePostsByWords');
  return { doc, posts, hider, diagnostics, warnings, set, buttons };
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

// The page's own inline answer ({data, extensions}, no path) holds the stories the server drew.
// Taking one out made React throw #418 (live 2026-11-03, Home and the groups feed with re:.).
test('a story the server drew stays in the data, and its post goes on the page by what the data says', () => {
  const rules = [];
  let href = 'https://www.facebook.com/';
  // Post 3 is a unit that isn't a story, so its own markup still decides.
  const win = page(post(1, { author: 'Pat Example', text: 'Hello' }) + post(2, { text: 'Hello' }) + post(3, { text: 'bread rolls' }));
  const { doc, posts, set, diagnostics } = setupFeature(win, { words: 'bread', href: () => href, net: { transformResponses: (rule) => rules.push(rule) } });
  const [rule] = rules;
  const notes = () => [...doc.querySelectorAll('[aria-posinset]')].map((p) => p.querySelector(`[${MARK}]`)?.getAttribute(NOTE) ?? null);
  const HIDDEN = 'Hidden: Filter: bread. Show';
  assert.deepEqual(notes(), [null, null, HIDDEN], "the page's own words match only post 3");
  const unit = { __typename: 'GroupsYouShouldJoinFeedUnit', id: 'u3' };
  const inline = { data: { viewer: { news_feed: { edges: [{ node: story(), cursor: 'c1' }, { node: { ...story(), id: 's2', comet_sections: {} }, cursor: 'c2' }, { node: unit, cursor: 'c3' }] } } }, extensions: { is_final: false } };
  const INLINE = { transport: 'json-parse', method: '', url: '', host: '', path: '', friendlyName: '' };
  const line = JSON.stringify(inline);
  assert.equal(transformDocumentLine(line, [rule], INLINE), line, 'the drawn stories keep their data');
  assert.deepEqual(notes(), [HIDDEN, null, HIDDEN]);
  assert.equal(diagnostics.rows().find((row) => row.label === 'Posts hidden by your filters').value, 'bread 2');

  set('words', 'zzz');
  assert.deepEqual(notes(), [null, null, null], 'a new list applies to the drawn post too');
  set('words', 'bread');
  assert.deepEqual(notes(), [HIDDEN, null, HIDDEN]);
  assert.equal(diagnostics.rows().find((row) => row.label === 'Posts hidden by your filters').value, 'bread 2', 'hidden again, counted once');

  // Streamed in after the first answer (with a path), or fetched, a story isn't drawn, so it goes.
  // A blob can carry both, and only the story that went counts as hidden in the data.
  const streamedBlob = { data: { node: story(), cursor: 'c4' }, extensions: {}, path: ['viewer', 'news_feed', 'edges', 3] };
  const both = JSON.parse(transformDocumentLine(JSON.stringify({ first: inline, next: streamedBlob }), [rule], INLINE));
  assert.equal(both.next.data.node, undefined);
  assert.deepEqual(both.first, inline);
  assert.equal(diagnostics.decisions().filter((decision) => decision.layer === 'data').length, 1);
  const fetched = JSON.parse(transformDocumentLine(line, [rule], { transport: 'xhr', path: '/api/graphql/', friendlyName: 'CometNewsFeedPaginationQuery' }));
  assert.equal(fetched.data.viewer.news_feed.edges[0].node, undefined);

  // Another feed numbers its posts from 1 too, and the drawn data isn't about them.
  href = 'https://www.facebook.com/groups/feed/';
  set('words', 'bread ');
  assert.deepEqual(notes(), [null, null, HIDDEN]);
  posts.stop();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const INLINE_CTX = { transport: 'json-parse', method: '', url: '', host: '', path: '', friendlyName: '' };
const inlineFeed = (...nodes) => JSON.stringify({ data: { viewer: { news_feed: { edges: nodes.map((node, i) => ({ node, cursor: `c${i + 1}` })) } } }, extensions: { is_final: false } });
const memberPost = (n, member, text) => `
  <div><div aria-posinset="${n}">
    <h4><a href="/groups/garden/">Garden Swap Group</a></h4><a href="/groups/garden/user/${n}/">${member}</a>
    <div data-ad-rendering-role="story_message"><div>${text}</div></div>
  </div></div>`;

// Home fetches its feed again on the same page (the Home button, coming back after a while, Back
// from a post: keep-feed-place.js), and a group sorts its posts another way, so new posts take the
// drawn places. The data only speaks for the post whose poster it names.
test("drawn data only goes for the post it drew, so a new feed on the same page goes by its own words", async () => {
  const rules = [];
  const win = page(post(1, { author: 'Pat Example' }) + post(2) + post(3));
  const { doc, posts } = setupFeature(win, { words: 'bread', net: { transformResponses: (rule) => rules.push(rule) } });
  const notes = () => [...doc.querySelectorAll('[aria-posinset]')].map((p) => p.querySelector(`[${MARK}]`)?.getAttribute(NOTE) ?? null);
  const HIDDEN = 'Hidden: Filter: bread. Show';
  const hello = { __typename: 'Story', id: 's2', comet_sections: { content: { story: { actors: [{ __typename: 'User', name: 'Friend' }], message: { text: 'Hello' } } } } };
  transformDocumentLine(inlineFeed(story(), hello), rules, INLINE_CTX);
  assert.deepEqual(notes(), [HIDDEN, null, null]);

  doc.querySelector('.feed').innerHTML = post(1, { text: 'Weather today' }) + post(2, { author: 'Lee Example', text: 'bread rolls for sale' }) + post(3);
  await settle();
  assert.deepEqual(notes(), [null, HIDDEN, null], 'the new post at place 1 has its own author and words');

  // In a group, the member who posted decides, not the group every post there shares.
  doc.querySelector('.feed').innerHTML = memberPost(1, 'Sam Other', 'Lost cat') + memberPost(2, 'Pat Example', 'Hello');
  await settle();
  assert.deepEqual(notes(), [null, null]);
  doc.querySelector('.feed').innerHTML = memberPost(1, 'Pat Example', 'Hello');
  await settle();
  assert.deepEqual(notes(), [HIDDEN], 'the post the data drew, its member named');
  doc.querySelector('.feed').innerHTML = `<div><div aria-posinset="1"><h4><a href="/groups/garden/">Garden Swap Group</a></h4><span>Anonymous participant</span>
    <div data-ad-rendering-role="story_message"><div>Lost cat</div></div></div></div>`;
  await settle();
  assert.deepEqual(notes(), [null], "an anonymous post from the same group isn't Pat's, though the data names the group too");

  // Until its header is in, a post goes by its markup.
  doc.querySelector('.feed').innerHTML = '<div><div aria-posinset="1"><div data-ad-rendering-role="story_message"><div>Hello</div></div></div></div>';
  await settle();
  assert.deepEqual(notes(), [null]);
  posts.stop();
});

test('a post its markup hid comes back when the data drawn for it says to show it', async () => {
  const rules = [];
  // On the page the group isn't named, and the data names it.
  const win = page(post(1, { author: 'Pat Example', text: 'Fresh bread' }));
  const { doc, posts } = setupFeature(win, { words: 'bread', lists: { showPeople: 'Garden Swap Group' }, net: { transformResponses: (rule) => rules.push(rule) } });
  const notes = () => [...doc.querySelectorAll('[aria-posinset]')].map((p) => p.querySelector(`[${MARK}]`)?.getAttribute(NOTE) ?? null);
  assert.deepEqual(notes(), ['Hidden: Filter: bread. Show']);
  transformDocumentLine(inlineFeed(story()), rules, INLINE_CTX);
  assert.deepEqual(notes(), [null]);
  posts.stop();
});

test('a post hidden by one line, then another, then the first again counts once for each', () => {
  const win = page(post(1, { text: 'bread rolls' }));
  const { posts, diagnostics, set } = setupFeature(win, { words: 'bread' });
  set('words', 'rolls');
  set('words', 'bread');
  assert.equal(diagnostics.rows().find((row) => row.label === 'Posts hidden by your filters').value, 'bread 1, rolls 1');
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

// A search result as /search/posts/ gets it: the story sits beside the node, in rendering_strategy,
// and a search ad's under view_model.story (the 2026-10-10 capture).
const SEARCH_CTX = { transport: 'xhr', path: '/api/graphql/', friendlyName: 'SearchCometResultsPaginatedResultsQuery' };
const searchResult = (node, role = 'PUBLIC_POSTS', model = { click_model: { story: node } }) => ({
  cursor: `r-${node?.id ?? role}`, node: { __typename: 'SearchRenderable', role }, rendering_strategy: { __typename: 'SearchRichPostRenderingStrategy', view_model: model },
});
const searchLine = (edges, extra = {}) => JSON.stringify({ data: { serpResponse: { results: { edges } } }, ...extra });
const resultIds = (line) => JSON.parse(line).data.serpResponse.results.edges.map((edge) => edge.rendering_strategy?.view_model?.click_model?.story?.id ?? null).filter(Boolean);

test('with the search option on, matching search results go from the data, and a person result stays', () => {
  const rules = [];
  const href = 'https://www.facebook.com/search/posts/?q=market';
  const win = page('', href);
  const { posts, set } = setupFeature(win, { words: 'bread', href, net: { transformResponses: (rule) => rules.push(rule) } });
  const rule = rules.find((candidate) => candidate.id === 'hidePostsByWords');
  const ad = searchResult(null, 'SEARCH_ADS', { story: { ...story(), id: 'ad' } });
  const person = searchResult(null, 'ENTITY_USER', { profile: { __typename: 'User', name: 'Bread Baker' } });
  const line = searchLine([searchResult(story()), searchResult({ ...story(), id: 's2', comet_sections: {} }), ad, person]);
  assert.equal(transformDocumentLine(line, [rule], SEARCH_CTX), line, 'off, search is left alone');
  set('search', true);
  const shape = (out) => JSON.parse(out).data.serpResponse.results.edges.map((edge) => [edge.cursor, 'node' in edge, 'rendering_strategy' in edge]);
  const expected = [['r-s1', false, false], ['r-s2', true, true], ['r-SEARCH_ADS', false, false], ['r-ENTITY_USER', true, true]];
  assert.deepEqual(shape(transformDocumentLine(line, [rule], SEARCH_CTX)), expected, 'each edge keeps its cursor, so paging goes on');
  // Search results in the page's own answer aren't drawn on the server, so they go there too.
  assert.deepEqual(shape(transformDocumentLine(searchLine(JSON.parse(line).data.serpResponse.results.edges, { extensions: { is_final: false } }), [rule], INLINE_CTX)), expected);
  posts.stop();
});

test('the captured search answer: a result goes by its story, and a filter that matches nothing changes nothing', async () => {
  const [line] = await fixtureLines('SearchCometResultsPaginatedResultsQuery.jsonl');
  const storyIn = (edge) => edge.rendering_strategy?.view_model?.click_model?.story ?? edge.rendering_strategy?.view_model?.story ?? null;
  const edges = parseLine(line).data.serpResponse.results.edges;
  const author = storyFields(storyIn(edges[1])).authors[0];
  assert.ok(author, 'the capture names who posted where the reader looks');
  const matching = edges.filter((edge) => storyFields(storyIn(edge)).authors.includes(author)).length;
  const doc = parseLine(line);
  const filter = { ...compileFilters(author), kinds: new Set() };
  assert.deepEqual(pruneFiltered(doc, filter, undefined, undefined, true), Array(matching).fill(author));
  assert.equal('node' in doc.data.serpResponse.results.edges[1], false);
  assert.equal(doc.data.serpResponse.results.edges[1].cursor, edges[1].cursor);
  const seen = [];
  previewFiltered(parseLine(line), filter, (id, matches) => seen.push([id, matches.length > 0]), true);
  assert.equal(seen.length, edges.length, 'preview looks at every result, the ad included');
  assert.equal(seen.filter(([, matched]) => matched).length, matching);
  const untouched = parseLine(line);
  assert.deepEqual(pruneFiltered(untouched, { ...compileFilters('zzzz-not-there'), kinds: new Set() }, undefined, undefined, true), []);
  assert.deepEqual(untouched, parseLine(line));
  // Read as a feed's answer, a result is no story, so it stays.
  const asFeed = parseLine(line);
  assert.deepEqual(pruneFiltered(asFeed, filter), []);
  assert.deepEqual(asFeed, parseLine(line));
});

test("a feed's answer reads each edge's node alone, so an edge shaped like a search result stays with the search option on or off", () => {
  const rules = [];
  const win = page('');
  const { posts, set } = setupFeature(win, { words: 'bread', net: { transformResponses: (rule) => rules.push(rule) } });
  const rule = rules.find((candidate) => candidate.id === 'hidePostsByWords');
  const line = JSON.stringify({ data: { viewer: { news_feed: { edges: [searchResult(story())] } } } });
  const feed = { transport: 'xhr', path: '/api/graphql/', friendlyName: 'CometNewsFeedPaginationQuery' };
  assert.equal(transformDocumentLine(line, [rule], feed), line, 'search off');
  set('search', true);
  assert.equal(transformDocumentLine(line, [rule], feed), line, 'search on');
  assert.deepEqual(resultIds(transformDocumentLine(searchLine([searchResult(story())]), [rule], SEARCH_CTX)), [], 'a search answer still loses it');
  posts.stop();
});

test('with the search option on, the page check hides matching search results too', () => {
  const href = 'https://www.facebook.com/search/top/?q=market';
  const win = page(post(1, { text: 'Fresh bread' }) + post(2, { text: 'Fresh fish' }), href);
  const { doc, posts, set } = setupFeature(win, { words: 'bread', href });
  const notes = () => [...doc.querySelectorAll('[aria-posinset]')].map((p) => p.querySelector(`[${MARK}]`)?.getAttribute(NOTE) ?? null);
  assert.deepEqual(notes(), [null, null], 'off, search is left alone');
  set('search', true);
  assert.deepEqual(notes(), ['Hidden: Filter: bread. Show', null]);
  set('search', false);
  assert.deepEqual(notes(), [null, null]);
  posts.stop();
});

// A comment as three Page post permalinks drew them on 2026-11-04: avatar, name and timestamp
// links carrying comment_id, then the words in a [dir=auto][lang] box.
const comment = (n, name, words, extra = '') => `
  <div role="article" aria-label="Comment by ${name}"><div>
    <a role="link" href="/u${n}?comment_id=${n}"><svg><image href="a.jpg"></image></svg></a>
    <div><a role="link" href="/u${n}?comment_id=${n}"><span><span dir="auto">${name}</span></span></a>
      <div><span dir="auto" lang="en-US">${words}</span></div>${extra}
      <a role="link" href="/page/posts/pfbid0P1?comment_id=${n}"><span dir="auto">2d</span></a></div>
  </div></div>`;
const PERMALINK = 'https://www.facebook.com/p1/posts/pfbid0P1';

test('comment fields: its words, who wrote it, alt text and sites, and no kinds', () => {
  const emoji = '<img src="https://static.xx.fbcdn.net/images/emoji.php/v9/t50/1/16/2728.png" alt="✨">';
  const extra = `<a href="/photo/?fbid=9"><img alt="May be an image of a cat" src="x.jpg"></a>
    <a href="https://l.facebook.com/l.php?u=${encodeURIComponent('https://shop.example/x')}">shop.example</a>`;
  const win = page(post(1, { text: 'Our puppy', extra: comment(1, `Sam ${emoji} Writer`, `Love it <a href="/pat">Pat Example</a> ${emoji}`, extra) }), PERMALINK);
  const fields = commentFields(win.document.querySelector('[role="article"]'));
  assert.deepEqual(fields.text, ['Love it Pat Example ']);
  assert.deepEqual(fields.authors, ['Sam ✨ Writer'], 'the name link, emoji kept, never the avatar, a mention or the time');
  assert.deepEqual(fields.alt, ['May be an image of a cat'], "an emoji's alt is too short to count");
  assert.deepEqual(fields.sites, ['shop.example']);
  assert.equal(fields.kinds.size, 0);
  assert.deepEqual(postFields(win.document.querySelector('[aria-posinset]')).text, ['Our puppy'], "the post's fields still leave its comments out");
  // A writer whose name isn't a link names nobody, never someone mentioned in the words.
  const unnamed = page(`<div role="article" aria-label="Comment by Anonymous participant"><div><span>Anonymous participant</span>
    <div><span dir="auto" lang="en-US">Ask <a href="/pat">Pat Example</a></span></div></div></div>`, PERMALINK);
  assert.deepEqual(commentFields(unnamed.document.querySelector('[role="article"]')).authors, []);
});

test('with the comments option on, matching comments are hidden anywhere, the post they are on included', async () => {
  const comments = comment(1, 'Sam Writer', 'So many kittens here') + comment(2, 'Loud Page', 'Hello there')
    + comment(3, 'Best Friend', 'kittens again') + comment(4, 'Pat Example', 'Nice photo', '<a href="/photo/?fbid=9"><img alt="photo" src="x.jpg"></a>');
  const win = page(post(1, { text: 'kittens everywhere', extra: comments }), PERMALINK);
  const { doc, posts, set, diagnostics, hider } = setupFeature(win, { words: 'kittens', href: PERMALINK, lists: { people: 'Loud Page', showPeople: 'Best Friend' }, kinds: { photo: true } });
  const notes = () => [...doc.querySelectorAll('[role="article"]')].map((c) => c.querySelector(`[${MARK}]`)?.getAttribute(NOTE) ?? null);
  const row = () => diagnostics.rows().find((r) => r.label === 'Comments hidden by your filters').value;
  assert.deepEqual(notes(), [null, null, null, null], 'off, comments are left alone');
  set('comments', true);
  // Best Friend is on the always-show list, and the photo switch names posts, not comments.
  assert.deepEqual(notes(), ['Hidden: Filter: kittens. Show', 'Hidden: Filter: Loud Page. Show', null, null]);
  assert.equal(doc.querySelector(`[aria-posinset] > [${MARK}]`) === null, true, 'the post opened by its link stays');
  assert.equal(row(), 'kittens 1, Loud Page 1');
  assert.deepEqual(hider.counts(), { Filter: 2 }, 'each comment counts, though their links name the same post');
  assert.equal(hider.hiddenPosts(), 0, 'comments stay out of the post count');

  // A comment drawn later inside a box of its own, and one whose words change after See more.
  doc.querySelector('[aria-posinset]').insertAdjacentHTML('beforeend', `<div><div>${comment(5, 'New Person', 'kittens too')}</div></div>`);
  doc.querySelectorAll('[role="article"]')[3].querySelector('[lang]').firstChild.nodeValue = 'Nice photo and kittens';
  await settle();
  assert.deepEqual(notes(), ['Hidden: Filter: kittens. Show', 'Hidden: Filter: Loud Page. Show', null, 'Hidden: Filter: kittens. Show', 'Hidden: Filter: kittens. Show']);

  set('words', 'hello');
  assert.deepEqual(notes(), [null, 'Hidden: Filter: Loud Page. Show', null, null, null], 'a new list applies at once');
  set('words', 'kittens');
  assert.equal(row(), 'kittens 3, Loud Page 1', 'hidden again, counted once');
  set('preview', true);
  assert.deepEqual(notes(), [null, null, null, null, null], 'preview hides nothing');
  set('preview', false);
  set('comments', false);
  assert.deepEqual(notes(), [null, null, null, null, null]);
  doc.querySelector('[aria-posinset]').insertAdjacentHTML('beforeend', comment(6, 'Other Person', 'kittens'));
  await settle();
  assert.equal(doc.querySelector(`[${MARK}]`) === null, true, 'off, a new comment stays');
  // Switched off after a comment came in and before it was looked at.
  set('comments', true);
  doc.querySelector('[aria-posinset]').insertAdjacentHTML('beforeend', comment(7, 'Late Person', 'kittens'));
  await Promise.resolve();
  set('comments', false);
  await settle();
  assert.equal(doc.querySelector(`[${MARK}]`) === null, true, 'switched off, it stays');
  posts.stop();
});

const commentNotes = (doc) => [...doc.querySelectorAll('[role="article"]')].map((c) => c.querySelector(`[${MARK}]`)?.getAttribute(NOTE) ?? null);

test('a comment shown from its note stays shown when it changes', async () => {
  const win = page(post(1, { text: 'Hello', extra: comment(1, 'Sam Writer', 'kittens') + comment(2, 'Pat Example', 'more kittens') }), PERMALINK);
  const { doc, posts, set } = setupFeature(win, { words: 'kittens', href: PERMALINK });
  set('comments', true);
  assert.deepEqual(commentNotes(doc), ['Hidden: Filter: kittens. Show', 'Hidden: Filter: kittens. Show']);
  doc.querySelector(`[role="article"] [${MARK}]`).click();
  assert.deepEqual(commentNotes(doc), [null, 'Hidden: Filter: kittens. Show']);
  doc.querySelector('[role="article"] [lang]').append('!');
  await settle();
  assert.deepEqual(commentNotes(doc), [null, 'Hidden: Filter: kittens. Show']);
  posts.stop();
});

test('a line the fuse paused on Home leaves the comments there alone too', async () => {
  const extra = comment(1, 'Sam Writer', 'kittens') + comment(2, 'Pat Example', 'puppies');
  const win = page([1, 2, 3, 4, 5, 6].map((n) => post(n, { text: 'kittens', extra: n === 1 ? extra : '' })).join(''));
  const { doc, posts, set } = setupFeature(win, { words: 'kittens\npuppies' });
  set('comments', true);
  await settle();
  assert.deepEqual([...doc.querySelectorAll('[aria-posinset]')].map((p) => p.querySelector(`:scope > [${MARK}]`) !== null), [false, false, false, false, false, false], 'kittens matched six of six, so it paused');
  assert.deepEqual(commentNotes(doc), [null, 'Hidden: Filter: puppies. Show']);
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

test('preview counts shared posts and live videos in the data and on the page, then Preview off hides them', () => {
  const rules = [];
  const win = page(sharedPost(1) + livePost(2) + post(3, { text: 'Garden photos' }));
  const { doc, posts, diagnostics, set } = setupFeature(win, { preview: true, kinds: { shared: true, live: true }, net: { transformResponses: (rule) => rules.push(rule) } });
  const line = feedLine({ ...sharedStory(), id: 's1' }, { ...videoStory({ broadcast_status: 'LIVE', is_live_streaming: true }), id: 's2' }, { ...story(), id: 's3' });
  assert.equal(transformDocumentLine(line, rules, FEED), line);
  assert.equal(doc.querySelector(`[${MARK}]`), null);
  assert.equal(diagnostics.rows().find((row) => row.label === 'Filter preview').value, 'data: 2 of 3 stories match (shared posts 1, live videos 1), page: 2 of 3 posts match (shared posts 1, live videos 1)');
  set('preview', false);
  const notes = [...doc.querySelectorAll('[aria-posinset]')].map((p) => p.querySelector(`[${MARK}]`)?.getAttribute(NOTE) ?? null);
  assert.deepEqual(notes, ['Hidden: Filter: shared posts. Show', 'Hidden: Filter: live videos. Show', null]);
  assert.deepEqual(JSON.parse(transformDocumentLine(line, rules, FEED)).data.viewer.news_feed.edges.map((edge) => edge.node?.id ?? null), [null, null, 's3']);
  posts.stop();
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
  assert.equal(status(blank.diagnostics), 'Preview is on. Add a line to a list or turn on a kind of post to see what it would hide.');
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

const shim = (url) => `https://l.facebook.com/l.php?u=${encodeURIComponent(url)}`;
const linkTo = (url) => `<a href="${shim(url)}">link</a>`;
const linkedStory = (url, extra = {}) => story({ message: { ranges: [{ entity: { external_url: shim(url) } }] }, ...extra });

test('a name line matches a whole author name in any case or spacing, and nothing shorter or longer', () => {
  const people = compileNames('# people\nPat Example\n\n  garden   swap GROUP \nPat\nZoé Example');
  assert.deepEqual(people.map(({ line, phrase }) => [line, phrase]), [[2, 'Pat Example'], [4, 'garden swap GROUP'], [5, 'Pat'], [6, 'Zoé Example']]);
  const hit = (authors) => matchingNames(people, authors).map((entry) => entry.line);
  assert.deepEqual(hit(['PAT  EXAMPLE']), [2]);
  assert.deepEqual(hit(['Pat']), [5]);
  assert.deepEqual(hit(['Pat Examples', 'Example', 'Pat Example Jr']), []);
  assert.deepEqual(hit(['Garden Swap Group']), [4]);
  assert.deepEqual(hit(['Zoé Example']), [6], 'an accent typed either way');
  assert.deepEqual(hit([]), [], "a post whose author can't be read");
});

test('a site line matches that site and its subdomains on a dot, and a link is cut down to its site', () => {
  const { sites, errors } = compileSites('example.com\nhttps://www.News.Example.org/story?id=1\n*.shop.example\nnews\ntwo words\n127.0.0.1\nbücher.example\n# a note');
  assert.deepEqual(sites.map(({ line, key }) => [line, key]), [[1, 'example.com'], [2, 'news.example.org'], [3, 'shop.example'], [7, 'xn--bcher-kva.example']]);
  assert.deepEqual(errors.map(({ line, reason }) => [line, reason]), [[4, "isn't a site name"], [5, "isn't a site name"], [6, "isn't a site name"]]);
  const hit = (hosts) => matchingSites(sites, hosts).map((entry) => entry.line);
  assert.deepEqual(hit(['example.com']), [1]);
  assert.deepEqual(hit(['news.example.com']), [1]);
  assert.deepEqual(hit(['badexample.com', 'example.com.evil.net', 'example.co']), []);
  assert.deepEqual(hit(['NEWS.example.org']), [2]);
  assert.deepEqual(hit(['example.org']), [], "a subdomain line doesn't reach the site above it");
  assert.deepEqual(hit(['a.shop.example']), [3]);
  assert.deepEqual(storyFields(linkedStory('https://bücher.example/x')).sites, ['xn--bcher-kva.example'], 'the data reader gives other alphabets the same way');
  assert.deepEqual(hit(storyFields(linkedStory('https://bücher.example/x')).sites), [7]);
});

test('the people and site lists find the same lines in the data as on the page, each in its own field only', () => {
  const text = 'Bread from Nobody Here, see other.example';
  const data = linkedStory('https://www.news.example/a', { comet_sections: { message_container: { story: { message: { text } } } } });
  const win = page(`<div><div aria-posinset="1">
    <h4><a href="/p1">Pat Example</a> <a href="/groups/1">Garden Swap Group</a></h4><a href="/p1/posts/pfbid0P1">2h</a>
    <div data-ad-rendering-role="story_message"><div>${text}</div></div>${linkTo('https://www.news.example/a')}
  </div></div>`);
  const filter = {
    ...compileFilters(''), kinds: new Set(),
    people: compileNames('garden swap group\nNobody Here\nPat'),
    sites: compileSites('news.example\nother.example').sites,
  };
  const fromData = filterMatches(filter, storyFields(data));
  assert.deepEqual(fromData, ['people line 1', 'sites line 1'], 'a name or site in the text counts for neither list');
  assert.deepEqual(filterMatches(filter, postFields(win.document.querySelector('[aria-posinset]'))), fromData);
  assert.equal(filterVerdict(filter, storyFields(data)), 'garden swap group');
});

test('an always-show line keeps a post that every list and kind here would hide, and only that post', () => {
  const fields = storyFields(linkedStory('https://sub.news.example/a'));
  const base = { ...compileFilters('bread'), kinds: new Set(['photo']), people: compileNames('Pat Example'), sites: compileSites('news.example').sites };
  assert.equal(filterVerdict(base, fields), 'photo posts');
  for (const show of [{ showPeople: compileNames('garden swap group') }, { showSites: compileSites('news.example').sites }]) {
    assert.equal(filterVerdict({ ...base, ...show }, fields), null, JSON.stringify(show));
    assert.deepEqual(filterMatches({ ...base, ...show }, fields), []);
  }
  const elsewhere = { ...base, showPeople: compileNames('Someone Else'), showSites: compileSites('other.example').sites };
  assert.equal(filterVerdict(elsewhere, fields), 'photo posts');

  const win = page(post(1, { author: 'Pat Example', text: 'bread' }) + post(2, { text: 'bread' }));
  const { doc, posts } = setupFeature(win, { words: 'bread', lists: { showPeople: 'Pat Example' } });
  assert.deepEqual([...doc.querySelectorAll('[aria-posinset]')].map((p) => Boolean(p.querySelector(`[${MARK}]`))), [false, true]);
  posts.stop();
});

test("an always-show line doesn't keep a sponsored post, which the ad switch still removes", () => {
  const rules = [];
  const { posts } = setupFeature(page(''), { words: 'bread', lists: { showPeople: 'Pat Example' }, net: { transformResponses: (rule) => rules.push(rule) } });
  const friend = { content: { story: { actors: [{ __typename: 'User', name: 'Friend' }], comet_sections: { message_container: { story: { message: { text: 'bread again' } } } } } } };
  const line = feedLine(story(), { ...story(), id: 'ad', th_dat_spo: { is_demo_ad: false } }, { ...story(), id: 's3', comet_sections: friend });
  const out = JSON.parse(transformDocumentLine(line, [...rules, adRule('hideSponsoredPosts', () => true)], FEED));
  assert.deepEqual(out.data.viewer.news_feed.edges.map((edge) => edge.node?.id ?? null), ['s1', null, null]);
  posts.stop();
});

test('on the page the people and site lists go by who posted and where it links, and a bad site line is told once', () => {
  const win = page(
    post(1, { author: 'Loud Page' })
    + post(2, { extra: linkTo('https://www.shop.example/x') })
    + post(3, { text: 'Loud Page is great, shop.example too' })
    + post(4, { author: 'Loud Page', extra: linkTo('https://good.example/') })
    + '<div><div aria-posinset="5"><div data-ad-rendering-role="story_message"><div>Loud Page</div></div></div></div>',
  );
  const toasts = [];
  const storage = createMemoryStorage();
  const lists = { people: 'Loud Page', sites: 'shop.example\nnews', showSites: 'good.example\ntwo words' };
  const { doc, posts, diagnostics, warnings, set } = setupFeature(win, { lists, toast: (message) => toasts.push(message), storage });
  const notes = () => [...doc.querySelectorAll('[aria-posinset]')].map((p) => p.querySelector(`[${MARK}]`)?.getAttribute(NOTE) ?? null);
  assert.deepEqual(notes(), ['Hidden: Filter: Loud Page. Show', 'Hidden: Filter: shop.example. Show', null, null, null]);
  const row = () => diagnostics.rows().find(({ label }) => label === "Filter lines that aren't valid").value;
  assert.equal(row(), "sites line 2 (isn't a site name), always-show sites line 2 (isn't a site name)");
  assert.deepEqual(warnings, ["Line 2 of the sites list is skipped because it isn't a site name", "Line 2 of the always-show sites list is skipped because it isn't a site name"]);
  assert.deepEqual(toasts, ["2 lines in your site lists aren't site names, so they're skipped. Diagnostics names them."]);
  set('words', 'nothing here');
  assert.equal(toasts.length, 1, 'a change elsewhere tells nothing new');
  set('showSites', 'good.example');
  assert.deepEqual(toasts.slice(1), ["Line 2 of the sites list isn't a site name, so it's skipped."]);
  set('people', '');
  assert.deepEqual(notes(), [null, 'Hidden: Filter: shop.example. Show', null, null, null], 'a changed list applies at once');
  set('words', '');
  set('sites', '');
  set('people', 'Loud Page');
  assert.deepEqual(notes(), ['Hidden: Filter: Loud Page. Show', null, null, null, null], 'the people list works alone');
  set('people', '');
  set('sites', 'shop.example');
  assert.deepEqual(notes(), [null, 'Hidden: Filter: shop.example. Show', null, null, null], 'and so does the site list');
  posts.stop();
  const again = setupFeature(page(post(1)), { lists: { ...lists, showSites: 'good.example' }, toast: (message) => toasts.push(message), storage });
  assert.equal(toasts.length, 2, 'the next page load remembers it was told');
  again.posts.stop();
  assert.equal(siteNotice([{ line: 3, list: 'always-show sites' }]), "Line 3 of the always-show sites list isn't a site name, so it's skipped.");
});

test('preview names people and site lines by their list, with the line itself only on the card', () => {
  const win = page(post(1, { author: 'Loud Page' }) + post(2, { extra: linkTo('https://shop.example/x') }) + post(3, { text: 'Loud Page' }));
  const { doc, posts, diagnostics } = setupFeature(win, { preview: true, lists: { people: 'Loud Page', sites: 'shop.example' } });
  assert.equal(doc.querySelector(`[${MARK}]`), null);
  assert.equal(diagnostics.statusOf('hidePostsByWords'), 'Preview is on, so nothing is hidden. On the page, 2 of 3 posts match (people line 1 "Loud Page" 1, sites line 1 "shop.example" 1). Turn Preview off to hide them.');
  assert.equal(diagnostics.rows().find(({ label }) => label === 'Filter preview').value, 'page: 2 of 3 posts match (people line 1 1, sites line 1 1)');
  posts.stop();
});

test('a list saved before the new lists keeps matching as it did, and backups keep all five lists', async () => {
  const features = [hidePostsByWords];
  const mixed = 'Pat Example\nnews.example\nbread';
  const old = createSettings({ storage: createMemoryStorage({ settings: { hidePostsByWords: true, 'hidePostsByWords.words': mixed } }), features, migrations: [] });
  assert.equal(old.get('hidePostsByWords.words'), mixed);
  for (const key of ['people', 'sites', 'showPeople', 'showSites']) assert.equal(old.get(`hidePostsByWords.${key}`), '', key);
  const filter = { ...compileFilters(old.get('hidePostsByWords.words')), kinds: new Set() };
  const fields = (part) => ({ text: [], authors: [], alt: [], sites: [], kinds: new Set(), ...part });
  assert.equal(filterVerdict(filter, fields({ authors: ['Pat Example'] })), 'Pat Example');
  assert.equal(filterVerdict(filter, fields({ sites: ['news.example'] })), 'news.example');
  assert.equal(filterVerdict(filter, fields({ text: ['Pat Example sent bread'] })), 'Pat Example', 'the old list still reads every field at once');

  const lists = { words: mixed, people: 'Loud Page', sites: 'shop.example', showPeople: 'Garden Swap Group', showSites: 'good.example' };
  const settings = Object.fromEntries(Object.entries(lists).map(([key, value]) => [`hidePostsByWords.${key}`, value]));
  const saved = createSettings({ storage: createMemoryStorage({ settings: { hidePostsByWords: true, ...settings } }), features, migrations: [] });
  const exported = JSON.parse(saved.exportJson()).settings;
  const restored = createSettings({ storage: createMemoryStorage(), features, migrations: [] });
  const { applied } = await restored.importJson(JSON.stringify({ app: 'HushFacebook Web', schema: EXPORT_SCHEMA, version: '0.0.1', settings: exported }));
  for (const [key, value] of Object.entries(settings)) {
    assert.equal(restored.get(key), value, key);
    assert.ok(applied.includes(key), key);
  }
});

// The fuse: stories that all say one thing, each with its own id so each one counts.
let serial = 0;
const stories = (count, text) => Array.from({ length: count }, () => ({ ...story({ comet_sections: { message_container: { story: { message: { text } } } } }), id: `f${++serial}` }));
const keptIds = (line) => JSON.parse(line).data.viewer.news_feed.edges.map((edge) => edge.node?.id ?? null).filter(Boolean);
const toasted = (toasts) => (message, options) => toasts.push({ message, options });

test('the fuse pauses a line once a layer has seen six posts and four in five of them match', () => {
  const fuse = createFilterFuse();
  for (let n = 0; n < 5; n += 1) fuse.see('data', `s${n}`, ['line 1', 'people line 1', 'photo posts']);
  assert.deepEqual(fuse.trip(), [], 'five posts are too few to judge');
  fuse.see('data', 's5', []);
  assert.deepEqual(fuse.trip(), ['line 1'], 'five of six is enough, and only word and site lines count');
  assert.deepEqual(fuse.trip(), [], 'a paused line trips once');
  assert.equal(fuseReport(fuse.paused), 'line 1 (data: 5 of 6)');
  fuse.clear();
  assert.equal(fuseReport(fuse.paused), 'None');

  const share = createFilterFuse();
  for (let n = 0; n < 10; n += 1) share.see('page', n, n < 7 ? ['sites line 2'] : []);
  assert.deepEqual(share.trip(), [], 'seven of ten is under the share');
  share.see('page', 3, ['line 4']);
  assert.deepEqual(share.trip(), [], 'a post seen again counts once');
  share.see('page', 7, ['sites line 2']);
  assert.deepEqual(share.trip(), ['sites line 2'], 'a later look that matches counts, and eight of ten is at the share');

  const kept = createFilterFuse({ kept: (id) => id === 'line 1' });
  for (let n = 0; n < 6; n += 1) kept.see('page', n, ['line 1', 'line 2']);
  assert.deepEqual(kept.trip(), ['line 2'], 'a line kept on purpose is never paused');

  const window = createFilterFuse({ window: 6 });
  for (let n = 0; n < 6; n += 1) window.see('data', n, []);
  assert.equal(window.counting('data'), false, 'a layer stops counting at its window');
  assert.equal(window.counting('page'), true);
});

test('a word line that matches most stories on a page is paused there, and the answer that trips it keeps them', () => {
  const rules = [];
  const toasts = [];
  const { posts, diagnostics, warnings } = setupFeature(page(''), { words: 'tulip\nzzqx', net: { transformResponses: (rule) => rules.push(rule) }, toast: toasted(toasts) });
  assert.deepEqual(keptIds(transformDocumentLine(feedLine(...stories(2, 'tulip bulbs')), rules, FEED)), [], 'two stories are too few to judge, so both go');
  assert.equal(diagnostics.rows().find(({ label }) => label === 'Filter lines paused on this page').value, 'None');
  const tripping = feedLine(...stories(3, 'tulip bulbs'), ...stories(1, 'garden news'));
  assert.equal(keptIds(transformDocumentLine(tripping, rules, FEED)).length, 4, 'five of six tripped it, so this answer keeps all four');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].message, 'Filter line 1, "tulip", matched 5 of the 6 posts here, so it\'s paused on this page.');
  assert.equal(toasts[0].options.tone, 'error');
  assert.deepEqual(toasts[0].options.actions.map(({ label }) => label), ['Keep hiding']);
  const row = diagnostics.rows().find(({ label }) => label === 'Filter lines paused on this page');
  assert.deepEqual({ value: row.value, shareable: row.shareable }, { value: 'line 1 (data: 5 of 6)', shareable: true }, 'Copy report gets the line number and counts, never the line');
  assert.equal(diagnostics.statusOf('hidePostsByWords'), 'Paused on this page because it matched almost every post: line 1 "tulip". Choose Keep hiding to hide by it anyway, or edit the line. Posts it hid before the pause come back on a reload.');
  assert.equal(warnings.length, 1);
  assert.equal(keptIds(transformDocumentLine(feedLine(...stories(2, 'tulip bulbs')), rules, FEED)).length, 2, 'it stays paused on this page');
  assert.equal(toasts.length, 1, 'and the notice comes once');
  posts.stop();
});

test('a busy line under the fuse still hides: five of five, seven of ten, and the switches it never counts', () => {
  const run = ({ words = 'tulip', matching, plain = 0, lists = {}, kinds = {} }) => {
    const rules = [];
    const toasts = [];
    const { posts } = setupFeature(page(''), { words, lists, kinds, net: { transformResponses: (rule) => rules.push(rule) }, toast: toasted(toasts) });
    const kept = keptIds(transformDocumentLine(feedLine(...stories(matching, 'tulip bulbs'), ...stories(plain, 'garden news')), rules, FEED)).length;
    posts.stop();
    return { kept, toasts: toasts.length };
  };
  assert.deepEqual(run({ matching: 5 }), { kept: 0, toasts: 0 });
  assert.deepEqual(run({ matching: 7, plain: 3 }), { kept: 3, toasts: 0 });
  assert.deepEqual(run({ matching: 8, plain: 2 }), { kept: 10, toasts: 1 }, 'eight of ten is at the share');
  assert.deepEqual(run({ words: 'zzqx', matching: 6, lists: { people: 'Pat Example' } }), { kept: 0, toasts: 0 }, 'a people line only matches who it names, even beside a word line');
  assert.deepEqual(run({ words: 'zzqx', matching: 6, kinds: { photos: true } }), { kept: 0, toasts: 0 }, 'a kind of post is meant to hide them all');
  assert.deepEqual(run({ words: 're:.', matching: 6, lists: { showPeople: 'Pat Example' } }), { kept: 6, toasts: 0 }, 'posts an always-show line keeps never count as matched');
});

test('the captured feed answers carry about one story each, and re:. is paused by the sixth one counted', async () => {
  const files = ['CometNewsFeedPaginationQuery.jsonl', 'CometNewsFeedPaginationQuery-ai-label.jsonl', 'CometNewsFeedPaginationQuery-ad.jsonl', 'CometNewsFeedPaginationQuery-group-suggestions.jsonl', 'CometNewsFeedPaginationQuery-pymk.jsonl'];
  const lines = (await Promise.all(files.map((file) => fixtureLines(file)))).flat();
  const count = (line) => {
    let n = 0;
    previewFiltered(parseLine(line), { rules: [], kinds: new Set() }, () => (n += 1));
    return n;
  };
  const rules = [];
  const toasts = [];
  const { posts } = setupFeature(page(''), { words: 're:.', net: { transformResponses: (rule) => rules.push(rule) }, toast: toasted(toasts) });
  const seen = [];
  for (const line of lines) {
    const before = count(line);
    if (!before) continue;
    seen.push({ before, after: count(transformDocumentLine(line, rules, FEED)), toasts: toasts.length });
  }
  assert.ok(seen.every(({ before }) => before === 1), 'one story an answer');
  assert.equal(seen.length, 7);
  // The group suggestions unit (the sixth) has no id, so it goes without being counted, and the
  // seventh story is the sixth one counted.
  assert.deepEqual(seen.map(({ after }) => after), [0, 0, 0, 0, 0, 0, 1], 'six go before the sixth counted story trips it');
  assert.deepEqual(seen.map(({ toasts: n }) => n), [0, 0, 0, 0, 0, 0, 1]);
  assert.match(toasts[0].message, /^Filter line 1, "re:\.", matched 6 of the 6 posts here/);
  posts.stop();
});

test('on the page the fuse brings back what a paused line hid, and Keep hiding hides it again for good', async () => {
  const html = (count) => Array.from({ length: count }, (_, n) => post(n + 1, { text: 'Hello there' })).join('');
  const storage = createMemoryStorage();
  const toasts = [];
  const first = setupFeature(page(html(6)), { words: 're:.', storage, toast: toasted(toasts) });
  const hidden = (doc) => doc.querySelectorAll(`[${MARK}]`).length;
  assert.equal(hidden(first.doc), 5, 'the sixth post trips it');
  await Promise.resolve();
  assert.equal(hidden(first.doc), 0, 'and the five it hid come back');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].message, 'Filter line 1, "re:.", matched 6 of the 6 posts here, so it\'s paused on this page.');
  assert.equal(first.diagnostics.rows().find(({ label }) => label === 'Filter lines paused on this page').value, 'line 1 (page: 6 of 6)');
  toasts[0].options.actions[0].run();
  assert.equal(hidden(first.doc), 6, 'Keep hiding hides them again');
  assert.equal(first.diagnostics.rows().find(({ label }) => label === 'Filter lines paused on this page').value, 'None');
  assert.equal(first.diagnostics.statusOf('hidePostsByWords'), null);
  const prints = storage.get('hidePostsByWords.fuseKept', []);
  assert.equal(prints.length, 1);
  assert.ok(!JSON.stringify(prints).includes('re:'), 'storage keeps a fingerprint, not the line');
  first.posts.stop();

  const again = setupFeature(page(html(6)), { words: 're:.', storage, toast: toasted(toasts) });
  await Promise.resolve();
  assert.equal(hidden(again.doc), 6, 'a kept line stays kept on the next page load');
  assert.equal(toasts.length, 1);
  again.posts.stop();
  const edited = setupFeature(page(html(6)), { words: 're:..', storage, toast: toasted(toasts) });
  await Promise.resolve();
  assert.equal(hidden(edited.doc), 0, 'an edited line is a new line');
  assert.equal(toasts.length, 2);
  edited.posts.stop();
});

test('Keep hiding keeps the line that tripped, after an edit too, with any line that reads the same', async () => {
  const html = Array.from({ length: 6 }, (_, n) => post(n + 1, { text: 'Hello there' })).join('');
  const storage = createMemoryStorage();
  const toasts = [];
  const edited = setupFeature(page(html), { words: 're:.\nre:.\ncats', storage, toast: toasted(toasts) });
  await Promise.resolve();
  assert.equal(toasts.length, 2, 'both copies of the line trip');
  assert.equal(edited.diagnostics.rows().find(({ label }) => label === 'Filter lines paused on this page').value, 'line 1 (page: 6 of 6), line 2 (page: 6 of 6)');
  edited.set('words', 'cats');
  toasts[0].options.actions[0].run();
  const kept = storage.get('hidePostsByWords.fuseKept', []);
  assert.equal(kept.length, 1);
  edited.posts.stop();
  const cats = setupFeature(page(Array.from({ length: 6 }, (_, n) => post(n + 1, { text: 'cats' })).join('')), { words: 'cats', storage, toast: toasted(toasts) });
  await Promise.resolve();
  assert.equal(toasts.length, 3, 'cats moved up to line 1 but was never kept');
  cats.posts.stop();

  const card = setupFeature(page(html), { words: 're:.\nre:.', storage: createMemoryStorage(), toast: toasted(toasts) });
  await Promise.resolve();
  assert.deepEqual(card.buttons().map(({ label }) => label), ['Keep hiding the paused lines'], 'the card keeps the choice after the notice goes');
  toasts.at(-1).options.actions[0].run();
  assert.equal(card.diagnostics.rows().find(({ label }) => label === 'Filter lines paused on this page').value, 'None', 'keeping one keeps the line that reads the same');
  assert.deepEqual(card.buttons(), [], 'and the button goes with the pause');
  assert.equal(card.doc.querySelectorAll(`[${MARK}]`).length, 6);
  card.posts.stop();

  const button = setupFeature(page(html), { words: 're:.', storage: createMemoryStorage(), toast: toasted(toasts) });
  await Promise.resolve();
  await button.buttons()[0].run();
  assert.equal(button.doc.querySelectorAll(`[${MARK}]`).length, 6, "the card's button hides them again");
  button.posts.stop();
});

test('a site line is paused by its list, and an always-show post is shown either way', async () => {
  const linked = Array.from({ length: 6 }, (_, n) => post(n + 1, { author: n < 2 ? 'Garden Swap Group' : 'Friend', extra: linkTo('https://shop.example/x') })).join('');
  const toasts = [];
  const { doc, posts } = setupFeature(page(linked), { lists: { sites: 'shop.example', showPeople: 'Garden Swap Group' }, toast: toasted(toasts) });
  await Promise.resolve();
  assert.equal(doc.querySelectorAll(`[${MARK}]`).length, 4, 'the two always-show posts count as unmatched, so four of six stays under the share');
  assert.equal(toasts.length, 0);
  posts.stop();
  const all = Array.from({ length: 6 }, (_, n) => post(n + 1, { extra: linkTo('https://shop.example/x') })).join('');
  const sites = setupFeature(page(all), { lists: { sites: 'news.example\nshop.example' }, toast: toasted(toasts) });
  await Promise.resolve();
  assert.equal(sites.doc.querySelectorAll(`[${MARK}]`).length, 0);
  assert.equal(toasts[0].message, 'Line 2 of your site list, "shop.example", matched 6 of the 6 posts here, so it\'s paused on this page.');
  assert.equal(sites.diagnostics.rows().find(({ label }) => label === 'Filter lines paused on this page').value, 'sites line 2 (page: 6 of 6)');
  sites.posts.stop();
});

test('another feed or a new list starts the fuse over, and an answer that fails un-pauses the line it tripped', () => {
  let href = 'https://www.facebook.com/';
  const rules = [];
  const toasts = [];
  const { posts, set, diagnostics } = setupFeature(page(''), { words: 'tulip', href: () => href, net: { transformResponses: (rule) => rules.push(rule) }, toast: toasted(toasts) });
  assert.equal(keptIds(transformDocumentLine(feedLine(...stories(6, 'tulip bulbs')), rules, FEED)).length, 6);
  assert.equal(toasts.length, 1);
  href = 'https://www.facebook.com/photo/?fbid=1';
  assert.equal(keptIds(transformDocumentLine(feedLine(...stories(1, 'tulip bulbs')), rules, FEED)).length, 1, 'a photo open on top of Home keeps the pause');
  href = 'https://www.facebook.com/someone';
  assert.equal(diagnostics.rows().find(({ label }) => label === 'Filter lines paused on this page').value, 'None', "a profile doesn't list Home's pauses");
  assert.equal(diagnostics.statusOf('hidePostsByWords'), null);
  href = 'https://www.facebook.com/';
  assert.match(diagnostics.statusOf('hidePostsByWords'), /^Paused on this page/);
  href = 'https://www.facebook.com/groups/feed/';
  assert.equal(keptIds(transformDocumentLine(feedLine(...stories(2, 'tulip bulbs')), rules, FEED)).length, 0, 'the groups feed counts again from nothing');
  assert.equal(keptIds(transformDocumentLine(feedLine(...stories(4, 'tulip bulbs')), rules, FEED)).length, 4);
  assert.equal(toasts.length, 2);
  set('words', 'tulip\nzzqx');
  assert.equal(keptIds(transformDocumentLine(feedLine(...stories(2, 'tulip bulbs')), rules, FEED)).length, 0, 'a new list counts again from nothing');
  posts.stop();

  const failing = [];
  const later = setupFeature(page(''), { words: 'tulip', net: { transformResponses: (rule) => failing.push(rule) }, toast: toasted(toasts) });
  const broken = { id: 'broken', transform() { throw new Error('boom'); } };
  const line = feedLine(...stories(6, 'tulip bulbs'));
  assert.equal(transformDocumentLine(line, [failing[0], broken], FEED, () => {}), line);
  assert.equal(toasts.length, 2, 'no notice for an answer the page never got');
  assert.equal(later.diagnostics.rows().find(({ label }) => label === 'Filter lines paused on this page').value, 'None');
  assert.equal(keptIds(transformDocumentLine(feedLine(...stories(1, 'tulip bulbs')), failing, FEED)).length, 1, 'the next answer trips it again');
  assert.equal(toasts.length, 3);
  later.posts.stop();
});

test('with the search option, each search starts the fuse over', () => {
  let href = 'https://www.facebook.com/search/posts/?q=tulips';
  const rules = [];
  const toasts = [];
  const { posts } = setupFeature(page('', href), { words: 'tulip', lists: { search: true }, href: () => href, net: { transformResponses: (rule) => rules.push(rule) }, toast: toasted(toasts) });
  const results = (count) => searchLine(stories(count, 'tulip bulbs').map((node) => searchResult(node)));
  assert.equal(resultIds(transformDocumentLine(results(6), rules, SEARCH_CTX)).length, 6, 'six of six tripped it, so this answer keeps them');
  assert.equal(toasts.length, 1);
  assert.equal(resultIds(transformDocumentLine(results(1), rules, SEARCH_CTX)).length, 1, 'it stays paused for this search');
  href = 'https://www.facebook.com/search/posts/?q=roses';
  assert.equal(resultIds(transformDocumentLine(results(2), rules, SEARCH_CTX)).length, 0, 'another search counts again from nothing');
  posts.stop();
});
