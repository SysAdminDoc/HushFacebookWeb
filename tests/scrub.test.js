// The fixture scrubber: keeps the shape Facebook's code depends on, replaces what points at
// a person, and does it the same way every run. Every id and token below is made up.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractDataSjs, fakeDigits, fakeHex, fakeToken, findLeftovers, findRealText, scrubDomText, scrubDomTree, scrubLine, scrubNumber, scrubString, scrubUrl, scrubValue, setScrubKey, trimArrays,
} from '../scripts/lib/scrub.mjs';
import { categoryHash, feedCategory } from '../src/features/feed/feed-category.js';

const KEY = 'test-key-for-the-scrubber-tests';
setScrubKey(KEY);

const USER_ID = '61500000000017';
const STORY_ID = '1000000000000102';
const PHOTO_ID = '1000000000000101';
const SESSION = '00000000-1111-4222-8333-444444444444';
const CURSOR = `AQHRtest${'x'.repeat(38)}==`;

const sample = () => ({
  data: {
    viewer: {
      news_feed: {
        edges: [{
          cat_sensitive: { enc: 'd41d8cd98f00b204e9800998ecf8427ed41d8cd98f00b204e9800998ecf8427e', cat: null },
          node: {
            // base64 of "S:_ISC:1000000000000042"
            __typename: 'Story', id: 'UzpfSVNDOjEwMDAwMDAwMDAwMDAwNDI=', th_dat_spo: null,
            actors: [{ __typename: 'User', id: USER_ID, name: 'Pat Example', short_name: 'Pat', url: 'https://www.facebook.com/pat.example.9', gender: 'FEMALE' }],
            message: { text: 'Having a great day at the lake with Pat! Call 937-555-0100.' },
            wwwURL: 'https://www.facebook.com/pat.example.9/posts/pfbid02AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghijklmnopqrstuvwxyz',
            photo: { uri: `https://scontent-xyz1-1.xx.fbcdn.net/v/t39.30808-6/700000001_${PHOTO_ID}_n.jpg?stp=dst-jpg&oh=00_AYB&oe=68E9` },
            link: 'https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fsale%3Ffbclid%3DIwZXh0bgNhZW0&h=AT1abc',
            tracking: `{"qid":"-6000000000000000099","mf_story_key":"${STORY_ID}"}`,
            comet_sections: { sponsored_label: { __typename: 'CometStorySponsoredLabelStrategy', label: 'Ad', ghl_label: { styles: [{ name: 'display', val: 'flex' }, { name: 'order', val: '3' }] } } },
            feedback: { i18n_reaction_count: '293', reaction_count: { count: 293 } },
            creation_time: 1791675413,
            top_story_cache_score: 3135.4904785156,
            post_id: Number(STORY_ID),
            session: SESSION,
            logging_unit_id: `browse_rl:${SESSION}`,
            email: 'pat@example.com',
          },
          cursor: CURSOR,
        }],
      },
    },
  },
  extensions: { is_final: true },
});

test('the key is required to be long, and a different key gives different stand-ins', () => {
  assert.throws(() => setScrubKey('short'), /at least 16 characters/);
  const before = fakeDigits(USER_ID);
  setScrubKey('another-key-for-the-scrubber-tests');
  try {
    assert.notEqual(fakeDigits(USER_ID), before, 'without the key, a guess can\'t be checked');
  } finally {
    setScrubKey(KEY);
  }
  assert.equal(fakeDigits(USER_ID), before);
});

test('keys, typenames, enums and small numbers survive, and the shape is the same', () => {
  const out = scrubValue(sample());
  const edge = out.data.viewer.news_feed.edges[0];
  assert.deepEqual(Object.keys(edge), ['cat_sensitive', 'node', 'cursor']);
  assert.deepEqual(Object.keys(edge.node), Object.keys(sample().data.viewer.news_feed.edges[0].node));
  assert.equal(edge.node.__typename, 'Story');
  assert.equal(edge.node.actors[0].__typename, 'User');
  assert.equal(edge.node.actors[0].gender, 'FEMALE');
  assert.equal(edge.node.comet_sections.sponsored_label.__typename, 'CometStorySponsoredLabelStrategy');
  assert.equal(edge.node.comet_sections.sponsored_label.label, 'Ad');
  assert.deepEqual(edge.node.comet_sections.sponsored_label.ghl_label.styles, [{ name: 'display', val: 'flex' }, { name: 'order', val: '3' }]);
  assert.equal(edge.node.th_dat_spo, null);
  assert.equal(edge.cat_sensitive.cat, null);
  assert.equal(edge.node.feedback.i18n_reaction_count, '293');
  assert.equal(edge.node.feedback.reaction_count.count, 293);
  // Ten-digit timestamps read as ids to the leftover check, so they get a stand-in too.
  assert.match(String(edge.node.creation_time), /^[1-9]\d{8}$/);
  assert.equal(out.extensions.is_final, true);
});

test('people, text, ids, tokens, hashes and media URLs are gone', () => {
  const out = scrubValue(sample());
  const text = JSON.stringify(out);
  for (const leak of ['Pat', 'lake', USER_ID, 'pfbid', 'scontent', 'fbcdn', 'example.com', 'IwZXh0', 'AT1abc', 'd41d8cd98f00b204', 'UzpfSVNDOj', 'AQHRtest', STORY_ID, PHOTO_ID, '6000000000000000099', '00000000-1111', '937-555-0100', 'pat@']) {
    assert.ok(!text.includes(leak), `${leak} is still in the output`);
  }
  assert.deepEqual(findLeftovers(text), []);
});

test('places and coordinates are replaced', () => {
  const out = scrubValue({
    reverse_geocode: { city: 'Springfield', state: 'OR', zip_code: '97477', latitude: 44.0462, longitude: '-123.0220' },
    location: { lat: 44.0462, lng: -123.022, street: '100 Main St', current_city: 'Springfield, Oregon' },
  });
  const text = JSON.stringify(out);
  for (const leak of ['Springfield', '"OR"', '97477', '44.0462', '123.02', 'Main St', 'Oregon']) assert.ok(!text.includes(leak), `${leak} is still in the output`);
  assert.equal(out.reverse_geocode.latitude, 0);
  assert.equal(out.reverse_geocode.longitude, '0');
  assert.equal(out.location.lat, 0);
});

test('text in any script and lowercase names are replaced', () => {
  for (const [value, key] of [['Иван Петров', 'label'], ['مرحبا بالعالم', 'x'], ['山田太郎', 'title_text'], ['Café', 'x'], ['jenny', 'short_name'], ['jenny', 'first_name']]) {
    const out = scrubString(value, key);
    assert.notEqual(out, value, `${key}: ${value}`);
    assert.match(out, /^[A-Z][a-z]+( [a-z]+)*$/);
  }
});

test('ids of six digits or more are replaced inside strings and in object keys', () => {
  assert.equal(scrubString('/photo/?fbid=1&set=a.500000001', 'url'), `/photo/?fbid=1&set=a.${fakeDigits('500000001')}`);
  assert.equal(scrubString('x.123456', 'k'), `x.${fakeDigits('123456', 6)}`);
  assert.equal(fakeDigits('123456', 6).length, 6);
  const out = scrubValue({ [USER_ID]: { seen: true }, 12345: 'kept' });
  assert.deepEqual(Object.keys(out).sort(), ['12345', fakeDigits(USER_ID)].sort());
});

test('stand-ins keep the kind of value they replace', () => {
  const edge = scrubValue(sample()).data.viewer.news_feed.edges[0];
  const node = edge.node;
  assert.match(node.actors[0].id, /^[1-9]\d{8}$/);
  assert.match(node.actors[0].url, /^https:\/\/www\.facebook\.com\/u[a-z0-9]{7}$/);
  assert.match(node.wwwURL, /^https:\/\/www\.facebook\.com\/u[a-z0-9]{7}\/posts\/[1-9]\d{8}$/);
  assert.match(node.photo.uri, /^https:\/\/cdn\.example\.invalid\/[A-Za-z0-9_-]{12}\.jpg$/);
  assert.match(node.link, /^https:\/\/l\.facebook\.com\/l\.php\?u=https%3A%2F%2Fexample\.invalid%2Fu[a-z0-9]{7}%3Ffbclid%3D[A-Za-z0-9_-]{13}&h=[A-Za-z0-9_-]{6}$/);
  assert.ok(!node.link.includes('AT1abc'), 'short tokens under token keys are replaced too');
  assert.equal(edge.cursor.length, CURSOR.length);
  assert.match(edge.cursor, /==$/);
  assert.equal(edge.cat_sensitive.enc.length, 64);
  assert.match(edge.cat_sensitive.enc, /^[0-9a-f]{64}$/);
  assert.equal(node.id.length, 'UzpfSVNDOjEwMDAwMDAwMDAwMDAwNDI='.length);
  assert.match(node.logging_unit_id, /^browse_rl:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.match(node.email, /@example\.invalid$/);
  assert.match(node.message.text, /^[A-Z][a-z]+( [a-z]+){10}$/, 'one placeholder word per word of the original');
  const tracking = JSON.parse(node.tracking);
  assert.deepEqual(Object.keys(tracking), ['qid', 'mf_story_key']);
  assert.match(tracking.mf_story_key, /^\d{9}$/);
  assert.equal(typeof node.post_id, 'number');
  assert.ok(node.post_id < 1e9);
  assert.equal(String(node.top_story_cache_score).replace(/\D/g, '').length <= 9, true);
});

test("a feed edge's hashed category is hashed again from the stand-in post id, so the fixture keeps it", () => {
  for (const [postId, category] of [[STORY_ID, 'ENGAGEMENT'], [Number(STORY_ID), 'SPONSORED']]) {
    const edge = sample().data.viewer.news_feed.edges[0];
    edge.node.post_id = postId;
    edge.cat_sensitive.enc = categoryHash(postId, category);
    const out = scrubValue(edge);
    assert.notEqual(String(out.node.post_id), String(postId));
    assert.notEqual(out.cat_sensitive.enc, edge.cat_sensitive.enc, 'the real id can\'t be checked against it');
    assert.equal(out.cat_sensitive.enc, categoryHash(out.node.post_id, category));
    assert.equal(feedCategory(out), category);
  }
  const unread = scrubValue(sample().data.viewer.news_feed.edges[0]);
  assert.equal(feedCategory(unread), null, 'one that never read back stays a stand-in');
  assert.equal(unread.cat_sensitive.enc, fakeHex('d41d8cd98f00b204e9800998ecf8427ed41d8cd98f00b204e9800998ecf8427e', 64));
});

test('the same input always gives the same stand-in, and different inputs differ', () => {
  assert.equal(JSON.stringify(scrubValue(sample())), JSON.stringify(scrubValue(sample())));
  assert.equal(fakeDigits(USER_ID), fakeDigits(USER_ID));
  assert.notEqual(fakeDigits(USER_ID), fakeDigits('61500000000018'));
  const doc = scrubValue({ a: { id: '100000000000123' }, b: { owner_id: '100000000000123' } });
  assert.equal(doc.a.id, doc.b.owner_id);
});

test('stand-ins never carry ten digits in a row', () => {
  for (let i = 0; i < 200; i++) {
    assert.doesNotMatch(fakeHex(`h${i}`, 64), /\d{10,}/);
    assert.doesNotMatch(fakeToken(`t${i}`.padEnd(120, 'x')), /\d{10,}/);
    assert.doesNotMatch(String(scrubNumber(1e15 + i)), /\d{10,}/);
    assert.doesNotMatch(String(scrubNumber(123.456789012345 + i)), /\d{10,}/);
  }
  assert.equal(scrubNumber(600.5), 600.5);
  assert.equal(scrubNumber(-7), -7);
});

test('relay labels, GraphQL roles and CSS values are kept as they are', () => {
  for (const kept of ['CometNewsFeed_viewerConnection$stream$CometNewsFeed_viewer_news_feed', 'SEARCH_ADS', 'MarketplaceFeedAdStory', 'RANKED_THREADED', 'flex', '0 -51px', 'globe-americas', 'cr:17197', 'Ad']) {
    assert.equal(scrubString(kept, 'x'), kept);
  }
  assert.equal(scrubString('display', 'name'), 'display');
  assert.equal(scrubString('comet_home', 'name'), 'comet_home');
  assert.notEqual(scrubString('Pat Example', 'name'), 'Pat Example');
  assert.notEqual(scrubString('Pat', 'short_name'), 'Pat');
  assert.equal(scrubString('CometStorySponsoredLabelStrategy', '__typename'), 'CometStorySponsoredLabelStrategy');
  // Module names Relay loads read like domains, and stay under __dr only.
  for (const kept of ['CometFeedStoryTranslatedMessageContainerRenderingStrategy.react', 'CometFeedStoryTranslatedMessageContainerRenderingStrategy_messageContainer$normalization.graphql']) {
    assert.equal(scrubString(kept, '__dr'), kept);
  }
  assert.notEqual(scrubString('shop.example.react', '__dr'), 'shop.example.react');
  assert.notEqual(scrubString('patsbakery.com', '__dr'), 'patsbakery.com');
  assert.notEqual(scrubString('Strategy.react', 'url'), 'Strategy.react');
});

test('URLs keep the host and grammar of facebook.com and lose everything else', () => {
  const groupPost = scrubUrl('https://www.facebook.com/groups/700000000000045/posts/2000000000000077/?__cft__[0]=AZXabc&__tn__=%2CO');
  assert.match(groupPost, new RegExp(`^https://www\\.facebook\\.com/groups/${fakeDigits('700000000000045')}/posts/${fakeDigits('2000000000000077')}/\\?__cft__\\[0\\]=[A-Za-z0-9_-]{6}&__tn__=[A-Za-z0-9_-]{2}$`));
  assert.ok(!groupPost.includes('AZXabc'), 'tracking tokens are replaced however short');
  assert.match(scrubUrl('https://www.grubhub.com/food/marcos_pizza?utm_source=meta'), /^https:\/\/example\.invalid\/u[a-z0-9]{7}\?utm_source=meta$/);
  assert.match(scrubUrl('https://static.xx.fbcdn.net/rsrc.php/v4/y0/r/Ir9HCCvvJW9.js'), /^https:\/\/cdn\.example\.invalid\/[A-Za-z0-9_-]{12}\.js$/);
  assert.equal(scrubString(`/photo/?fbid=${PHOTO_ID}&set=a.5`, 'url'), `/photo/?fbid=${fakeDigits(PHOTO_ID)}&set=a.5`);
});

test('a captured line keeps the for (;;); guard and trims arrays on request', () => {
  const line = 'for (;;);{"data":{"edges":[{"id":"1"},{"id":"2"},{"id":"3"}]},"extensions":{"uris":["a","b"]}}';
  const out = scrubLine(line, { trims: [{ path: 'data.edges', keep: [0, 2] }, { path: 'extensions.uris', keep: [] }] });
  assert.equal(out, 'for (;;);{"data":{"edges":[{"id":"1"},{"id":"3"}]},"extensions":{"uris":[]}}');
  assert.throws(() => trimArrays({ a: 1 }, [{ path: 'a', keep: [0] }]), /not an array/);
  assert.throws(() => trimArrays({ a: [1] }, [{ path: 'a', keep: [4] }]), /no index 4/);
});

test('data-sjs blocks come out of a captured page by the text they mention', () => {
  const html = '<html><script type="application/json" data-content-len="9" data-sjs>{"a":"x"}</script><script type="application/json" data-sjs>{"b":"feed"}</script><script>var x = 1</script>';
  assert.deepEqual(extractDataSjs(html, 'feed'), ['{"b":"feed"}']);
  assert.equal(extractDataSjs(html).length, 2);
});

test('page markup keeps the shape the ad check reads and loses what a person wrote', () => {
  const tree = ['div', { 'aria-posinset': '3', 'data-hfw-hide': 'Seen', onclick: 'x()' }, 'display:block', '0,0,680,812', [
    ['h4', {}, 'display:block', '16,12,200,20', [['a', { href: `/groups/${USER_ID}/user/${STORY_ID}/?__cft__[0]=AZWtokentokentoken` }, 'display:inline', '16,12,90,20', ['Jordan Example']]]],
    ['span', { 'aria-labelledby': ':r5c: :r5d:', id: ':r5c:' }, 'display:flex', '16,36,80,16', [
      ['span', {}, 'display:block;order:2', '20,36,6,16', ['o']],
      ['span', {}, 'display:block;position:absolute', '0,0,6,16', ['Q']],
    ]],
    ['div', { 'data-ad-rendering-role': 'story_message', 'aria-label': 'Comment by Jordan Example' }, 'display:block', '16,60,640,40', ['Our trip to the lake was lovely this year']],
    ['img', { src: 'https://scontent-mia5-1.xx.fbcdn.net/v/t39/1.jpg', alt: 'Jordan' }, 'display:block', '0,110,680,400', []],
    ['span', {}, 'display:inline', '16,520,40,16', [' Like ']],
  ]];
  const html = scrubDomTree(tree);
  assert.match(html, /^<div aria-posinset="3" style="display:block" data-hfw-rect="0,0,680,812">/);
  assert.ok(!html.includes('data-hfw-hide') && !html.includes('onclick'), 'the hide mark and anything else are dropped');
  assert.ok(html.includes('aria-labelledby=":r5c: :r5d:"') && html.includes('id=":r5c:"'), 'React ids stay so references still match');
  assert.ok(html.includes('style="display:block;order:2"') && html.includes('style="display:block;position:absolute"'));
  assert.ok(html.includes('>o</span>') && html.includes('>Q</span>'), 'one-letter spans stay');
  assert.ok(html.includes('> Like </span>'), "Facebook's own words stay");
  assert.ok(html.includes('data-ad-rendering-role="story_message"'));
  assert.match(html, /<a href="\/groups\/\d{1,9}\/user\/\d{1,9}\/\?__cft__/);
  assert.ok(html.includes('src="https://cdn.example.invalid/x.jpg"') && !html.includes('alt='), 'alt text is never kept');
  assert.ok(!/Jordan|Example|lake|lovely|fbcdn|scontent|AZWtoken/.test(html), html);
  assert.ok(!html.includes('</img>'));
  assert.deepEqual(findLeftovers(html), []);
  // The same input always gives the same output.
  assert.equal(scrubDomTree(tree), html);
});

test('page text: short runs stay, other scripts are blanked, numbers and spacing are kept', () => {
  assert.equal(scrubDomText('Ad'), 'Ad');
  assert.equal(scrubDomText(' · '), ' · ');
  assert.equal(scrubDomText('日本'), 'xx');
  assert.equal(scrubDomText('1.2K'), '1.2K');
  assert.equal(scrubDomText('  '), '  ');
  const words = scrubDomText(' Happy birthday Sam! ');
  assert.match(words, /^ [A-Z][a-z]+(?: [a-z]+)* $/);
  assert.ok(!words.includes('Sam'));
  assert.equal(scrubDomTree('<&>'), '&lt;&amp;&gt;', 'short text is escaped, not rewritten');
  // A phone number or a long id in a post is a number too, and isn't kept.
  // Numbers written in pairs, the way some countries write them, count too.
  for (const number of ['555-201-4477', '(555) 201 4477', '2014477', '1234567890', '12 34 56 78', '123 45 67']) {
    const scrubbed = scrubDomText(` ${number} `);
    assert.ok(!scrubbed.includes(number), number);
    // Stand-ins never carry ten digits in a row, so only the shorter ones keep their shape.
    if (number.length <= 12 && !/\d{10}/.test(number)) assert.equal(scrubbed.replace(/\d/g, '0'), ` ${number.replace(/\d/g, '0')} `, 'same shape');
    const kept = number.match(/\d+/g).filter((run) => scrubbed.includes(` ${run} `) || scrubbed.startsWith(` ${run}`)).length;
    assert.ok(kept < number.match(/\d+/g).length, `${number}: no number keeps all its own digit groups`);
    assert.notEqual(scrubString(number, 'value'), number, `${number} in data`);
  }
  assert.equal(scrubDomText('1,234'), '1,234');
  assert.equal(scrubDomText('12:45'), '12:45');
});

// A three-letter name used to stay as it was, because every short run of text did.
const canary = () => ['div', {}, 'display:block', '0,0,680,200', [
  ['a', { href: '/profile.php?id=123456789012345', 'aria-label': 'Amy' }, 'display:inline', '16,12,40,20', [['span', {}, 'display:inline', '16,12,40,20', ['Amy']]]],
  ['span', { title: 'Al' }, 'display:inline', '60,12,20,20', [' 2h ']],
  ['span', {}, 'display:inline', '90,12,20,20', ['Ad']],
  ['span', {}, 'display:block;order:1', '100,12,6,16', ['S͏']],
  ['span', {}, 'display:inline', '110,12,20,20', [' · ']],
]];

test('short names in page text and labels are replaced, and the checker sees them when they are not', () => {
  const html = scrubDomTree(canary());
  assert.ok(!/Amy|"Al"/.test(html), html);
  assert.ok(!html.includes('123456789012345'));
  assert.match(html, /<a href="\/profile\.php\?id=\d{9}" aria-label="[A-Z][a-z]+"[^>]*><span[^>]*>[A-Z][a-z]+<\/span><\/a>/);
  assert.ok(html.includes('> 2h </span>') && html.includes('>Ad</span>') && html.includes('>S͏</span>') && html.includes('> · </span>'), 'times, the ad label and its letters stay');
  assert.equal(scrubDomTree(canary()), html, 'the same name gets the same stand-in every time');
  assert.deepEqual(findLeftovers(html), []);
  assert.deepEqual(findRealText(html), []);
  // The same markup without the scrub: a name the leftover check alone would miss.
  const raw = '<div><a href="/profile.php?id=1" aria-label="Amy"><span>Amy</span></a><span title="Al"> 2h </span><span>Ad</span><span>S͏</span></div>';
  assert.deepEqual(findLeftovers(raw), []);
  assert.deepEqual(findRealText(raw).sort(), ['aria-label A**', 'text A**', 'title A*']);
});

test('the checker reads a word at a time and keeps what the scrub leaves', () => {
  assert.deepEqual(findRealText('<span>Maple river…</span><span>Like·Share</span><span>MapleRiver</span>'), []);
  assert.deepEqual(findRealText('<span>1.2K</span><span>12:45</span><span>xx</span><span>Sponsored</span>'), []);
  assert.deepEqual(findRealText('<span>Maple Ada</span>'), ['text M********'], "short words don't run together into a name");
  assert.deepEqual(findRealText('<span>&lt;Amy&gt;</span>'), ['text <****'], 'escaped text is read as text');
});

test('short names in captured data are replaced wherever a name or text goes', () => {
  const out = scrubValue({ actors: [{ name: 'Amy', short_name: 'Amy', first_name: 'Al' }], message: { text: 'Amy' }, title: { text: 'Al' } });
  assert.ok(!/Amy|"Al"/.test(JSON.stringify(out)), JSON.stringify(out));
  assert.equal(out.actors[0].name, out.actors[0].short_name, 'one name, one stand-in');
  assert.equal(out.actors[0].name, out.message.text);
});

test('any key named as a token holds one, whatever it looks like', () => {
  for (const key of ['intent_token', 'after_cursor', 'clientNonce', 'image_hash', 'requestSignature', 'csrf']) {
    const out = scrubString('AQHRxAbCdEfgHiJK', key);
    assert.notEqual(out, 'AQHRxAbCdEfgHiJK', key);
    assert.equal(out.length, 16, key);
    assert.equal(scrubString('AQHRxAbCdEfgHiJK', key), out, `${key} is deterministic`);
  }
  // A digit run inside a cursor goes with the rest of it, not just the digits.
  const cursor = 'MTo1234567890:AbCdEf';
  const scrubbed = scrubString(cursor, 'cursor');
  assert.equal(scrubbed.length, cursor.length);
  assert.ok(!scrubbed.includes('AbCdEf') && !scrubbed.startsWith('MTo'), scrubbed);
  assert.equal(scrubString(cursor, 'page_cursor'), scrubString(cursor, 'page_cursor'));
  // Hex stays hex, enums are words of Facebook's own, and a set id keeps its grammar.
  assert.match(scrubString('ab'.repeat(16), 'image_hash'), /^[0-9a-f]{32}$/);
  assert.equal(scrubString('RANKED_FILTERED_INTENT_V1', 'intent_token'), 'RANKED_FILTERED_INTENT_V1');
  assert.equal(scrubString('pcb.500000001', 'mediaset_token'), `pcb.${fakeDigits('500000001')}`);
  assert.equal(scrubString('Ad', 'label'), 'Ad');
  assert.equal(scrubString('display', 'name'), 'display');
});
