// The fixture scrubber: keeps the shape Facebook's code depends on, replaces what points at
// a person, and does it the same way every run.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractDataSjs, fakeDigits, fakeHex, fakeToken, findLeftovers, scrubLine, scrubNumber, scrubString, scrubUrl, scrubValue, trimArrays,
} from '../scripts/lib/scrub.mjs';

const sample = () => ({
  data: {
    viewer: {
      news_feed: {
        edges: [{
          cat_sensitive: { enc: 'd41d8cd98f00b204e9800998ecf8427ed41d8cd98f00b204e9800998ecf8427e', cat: null },
          node: {
            __typename: 'Story', id: 'UzpfSVNDOjEwMDAwMDAwMDAwMDAwNDI=', th_dat_spo: null,
            actors: [{ __typename: 'User', id: '61500000000017', name: 'Pat Example', short_name: 'Pat', url: 'https://www.facebook.com/pat.example.9', gender: 'FEMALE' }],
            message: { text: 'Having a great day at the lake with Pat! Call 937-555-0100.' },
            wwwURL: 'https://www.facebook.com/pat.example.9/posts/pfbid02AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghijklmnopqrstuvwxyz',
            photo: { uri: 'https://scontent-xyz1-1.xx.fbcdn.net/v/t39.30808-6/700000001_1000000000000101_n.jpg?stp=dst-jpg&oh=00_AYB&oe=68E9' },
            link: 'https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fsale%3Ffbclid%3DIwZXh0bgNhZW0&h=AT1abc',
            tracking: '{"qid":"-6000000000000000099","mf_story_key":"1000000000000102"}',
            comet_sections: { sponsored_label: { __typename: 'CometStorySponsoredLabelStrategy', label: 'Ad', ghl_label: { styles: [{ name: 'display', val: 'flex' }, { name: 'order', val: '3' }] } } },
            feedback: { i18n_reaction_count: '293', reaction_count: { count: 293 } },
            creation_time: 1791675413,
            top_story_cache_score: 3135.4904785156,
            post_id: 1000000000000102,
            session: '00000000-1111-4222-8333-444444444444',
            logging_unit_id: 'browse_rl:00000000-1111-4222-8333-444444444444',
            email: 'pat@example.com',
          },
          cursor: 'AQHRtestxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx==',
        }],
      },
    },
  },
  extensions: { is_final: true },
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
  for (const leak of ['Pat', 'lake', '61500000000017', 'pfbid', 'scontent', 'fbcdn', 'example.com', 'IwZXh0', 'AT1abc', 'd41d8cd98f00b204', 'UzpfSVNDOj', 'AQHRtest', '1000000000000102', '6000000000000000099', '00000000-1111', '937-555-0100', 'pat@']) {
    assert.ok(!text.includes(leak), `${leak} is still in the output`);
  }
  assert.deepEqual(findLeftovers(text), []);
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
  assert.equal(edge.cursor.length, 'AQHRtestxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=='.length);
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

test('the same input always gives the same stand-in, and different inputs differ', () => {
  assert.equal(JSON.stringify(scrubValue(sample())), JSON.stringify(scrubValue(sample())));
  assert.equal(fakeDigits('61500000000017'), fakeDigits('61500000000017'));
  assert.notEqual(fakeDigits('61500000000017'), fakeDigits('61500000000018'));
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
  assert.notEqual(scrubString('Pat Example', 'name'), 'Pat Example');
  assert.notEqual(scrubString('Pat', 'short_name'), 'Pat');
  assert.equal(scrubString('CometStorySponsoredLabelStrategy', '__typename'), 'CometStorySponsoredLabelStrategy');
});

test('URLs keep the host and grammar of facebook.com and lose everything else', () => {
  const groupPost = scrubUrl('https://www.facebook.com/groups/700000000000045/posts/2000000000000077/?__cft__[0]=AZXabc&__tn__=%2CO');
  assert.match(groupPost, new RegExp(`^https://www\\.facebook\\.com/groups/${fakeDigits('700000000000045')}/posts/${fakeDigits('2000000000000077')}/\\?__cft__\\[0\\]=[A-Za-z0-9_-]{6}&__tn__=[A-Za-z0-9_-]{2}$`));
  assert.ok(!groupPost.includes('AZXabc'), 'tracking tokens are replaced however short');
  assert.match(scrubUrl('https://www.grubhub.com/food/marcos_pizza?utm_source=meta'), /^https:\/\/example\.invalid\/u[a-z0-9]{7}\?utm_source=meta$/);
  assert.match(scrubUrl('https://static.xx.fbcdn.net/rsrc.php/v4/y0/r/Ir9HCCvvJW9.js'), /^https:\/\/cdn\.example\.invalid\/[A-Za-z0-9_-]{12}\.js$/);
  assert.equal(scrubString('/photo/?fbid=1000000000000101&set=a.500000001', 'url'), `/photo/?fbid=${fakeDigits('1000000000000101')}&set=a.500000001`);
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
