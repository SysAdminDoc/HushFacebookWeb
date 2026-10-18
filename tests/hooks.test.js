// Network hooks against a stand-in window built from Node's own fetch classes. XHR needs a
// browser and is covered by the live checks in CONTRIBUTING.md.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DROP } from '../src/core/net/payload.js';
import { createHandledLines, installNetworkHooks, lineKey } from '../src/core/net/hooks.js';

function fakeWindow({ chunks = ['{}'], status = 200 } = {}) {
  const calls = [];
  const beacons = [];
  const win = {
    Request, Response, Headers, ReadableStream, Promise, Event, setTimeout,
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
    location: { href: 'https://www.facebook.com/' },
    navigator: { sendBeacon: (url) => { beacons.push(url); return true; } },
    fetch(input, init) {
      calls.push({ input, init });
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return Promise.resolve(new Response(body, { status, headers: { 'content-length': '999' } }));
    },
  };
  return { win, calls, beacons };
}

const quietLog = () => {
  const errors = [];
  return { errors, error: (message) => errors.push(message), warn() {}, info() {}, debug() {} };
};

const graphqlBody = (name) => new URLSearchParams({ fb_api_req_friendly_name: name, doc_id: '1' }).toString();

test('response rules rewrite streamed GraphQL lines, however the body is chunked', async () => {
  const { win } = fakeWindow({ chunks: ['{"n":1}\n{"n"', ':2}\n{"keep":true}'] });
  const net = installNetworkHooks({ win, log: quietLog() });
  net.transformResponses({
    id: 'drop-even', enabled: () => true, match: (ctx) => ctx.path === '/api/graphql/',
    transform: (doc) => (doc.n === 2 ? DROP : undefined),
  });
  const response = await win.fetch('/api/graphql/', { method: 'POST', body: graphqlBody('Q') });
  assert.equal(await response.text(), '{"n":1}\n{"keep":true}');
  assert.equal(response.headers.get('content-length'), null);
});

test('a long line split over chunks with no newline still comes through whole', async () => {
  const { win } = fakeWindow({ chunks: ['{"a":', '1,"b":', '"x"', '}'] });
  const net = installNetworkHooks({ win, log: quietLog() });
  net.transformResponses({ id: 'touch', enabled: () => true, match: () => true, transform: () => undefined });
  assert.equal(await (await win.fetch('/api/graphql/')).text(), '{"a":1,"b":"x"}');
});

test("a streamed line is rewritten even when the page's JSON.parse is the hooked one", async () => {
  // In Facebook's page the script shares JSON with the page, so a line parsed through the
  // hooked JSON.parse would come back already pruned and look unchanged.
  const { win } = fakeWindow({ chunks: ['{"category":"SPONSORED","ad":1}\n{"n":1}'] });
  win.JSON = JSON;
  const parse = JSON.parse;
  try {
    const net = installNetworkHooks({ win, log: quietLog() });
    net.transformResponses({
      id: 'ads', enabled: () => true, markers: ['"SPONSORED"'], match: () => true,
      transform: (doc) => ('ad' in doc ? delete doc.ad : undefined),
    });
    assert.equal(await (await win.fetch('/api/graphql/')).text(), '{"category":"SPONSORED"}\n{"n":1}');
  } finally {
    JSON.parse = parse;
  }
});

test('requests a rule blocks never leave, and get a fake success', async () => {
  const { win, calls } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog() });
  net.blockRequests({
    id: 'seen', enabled: () => true, match: (ctx) => ctx.friendlyName === 'storiesUpdateSeenStateMutation',
    fakeResponse: () => '{"data":{},"errors":[]}',
  });
  const blocked = await win.fetch('/api/graphql/', { method: 'POST', body: graphqlBody('storiesUpdateSeenStateMutation') });
  assert.equal(blocked.status, 200);
  assert.equal(await blocked.text(), '{"data":{},"errors":[]}');
  assert.equal(calls.length, 0);
  await win.fetch('/api/graphql/', { method: 'POST', body: graphqlBody('SomethingElse') });
  assert.equal(calls.length, 1);
});

test('switched-off rules leave traffic alone', async () => {
  const { win, calls } = fakeWindow({ chunks: ['{"n":2}'] });
  const net = installNetworkHooks({ win, log: quietLog() });
  net.blockRequests({ id: 'off', enabled: () => false, match: () => true });
  net.transformResponses({ id: 'off', enabled: () => false, match: () => true, transform: () => DROP });
  const response = await win.fetch('/api/graphql/');
  assert.equal(await response.text(), '{"n":2}');
  assert.equal(calls.length, 1);
});

test('a broken rule is logged once and Facebook still gets its data', async () => {
  const { win } = fakeWindow({ chunks: ['{"n":1}'] });
  const log = quietLog();
  const net = installNetworkHooks({ win, log });
  net.transformResponses({ id: 'broken', enabled: () => true, match: () => { throw new Error('bad'); }, transform: () => DROP });
  assert.equal(await (await win.fetch('/x')).text(), '{"n":1}');
  await win.fetch('/x');
  assert.equal(log.errors.length, 1);
});

test('inline JSON is pruned through JSON.parse, and only when a marker is present', () => {
  const { win } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog() });
  let calls = 0;
  net.transformResponses({
    id: 'mark', enabled: () => true, markers: ['"SPONSORED"'], match: (ctx) => ctx.transport === 'json-parse',
    transform: (doc) => { calls++; delete doc.ad; return true; },
  });
  assert.deepEqual(win.JSON.parse('{"category":"ORGANIC","ad":1}'), { category: 'ORGANIC', ad: 1 });
  assert.equal(calls, 0);
  assert.deepEqual(win.JSON.parse('{"category":"SPONSORED","ad":1,"keep":2}'), { category: 'SPONSORED', keep: 2 });
  assert.equal(calls, 1);
  assert.equal(win.JSON.parse('7'), 7);
});

test('inline data a rule fails on comes back unedited, and nothing the other rules queued happens', () => {
  const { win } = fakeWindow();
  const log = quietLog();
  const net = installNetworkHooks({ win, log });
  const effects = [];
  const read = [];
  let after = 0;
  net.transformResponses({
    id: 'cut', enabled: () => true, markers: ['"ad"'], match: () => true,
    transform: (doc, ctx, stage) => { delete doc.ad; stage.defer(() => effects.push('cut')); return true; },
  });
  net.transformResponses({ id: 'index', enabled: () => true, match: () => true, observe: true, transform: (doc) => { read.push(Object.keys(doc).join()); } });
  net.transformResponses({
    id: 'half', enabled: () => true, markers: ['"broken"'], match: () => true,
    transform: (doc) => { delete doc.keep; throw new Error('boom'); },
  });
  net.transformResponses({ id: 'after', enabled: () => true, match: () => true, transform: () => { after++; } });
  assert.deepEqual(win.JSON.parse('{"ad":1,"keep":2,"broken":true}'), { ad: 1, keep: 2, broken: true });
  assert.deepEqual(effects, []);
  assert.equal(after, 0, 'the rules after the broken one never ran');
  assert.deepEqual(read, ['ad,keep,broken'], 'the index read what the page got');
  assert.equal(log.errors.length, 1);
  assert.deepEqual(win.JSON.parse('{"ad":1,"keep":2}'), { keep: 2 });
  assert.deepEqual(effects, ['cut']);
  assert.equal(after, 1);
  assert.deepEqual(read, ['ad,keep,broken', 'keep']);
});

test('a streamed line a rule fails on goes out as it came, and the lines around it are still edited', async () => {
  const { win } = fakeWindow({ chunks: ['{"ad":1,"n":1}\n{"ad":2,"keep":3,"broken":true}\n', '{"ad":3}'] });
  const net = installNetworkHooks({ win, log: quietLog() });
  net.transformResponses({ id: 'cut', enabled: () => true, markers: ['"ad"'], match: () => true, transform: (doc) => { delete doc.ad; return true; } });
  net.transformResponses({
    id: 'half', enabled: () => true, markers: ['"broken"'], match: () => true,
    transform: (doc) => { delete doc.keep; throw new Error('boom'); },
  });
  assert.equal(await (await win.fetch('/api/graphql/')).text(), '{"n":1}\n{"ad":2,"keep":3,"broken":true}\n{}');
});

test('JSON.parse with a reviver is left alone, so the reviver sees each value once and gets what it built', () => {
  const { win } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog() });
  let calls = 0;
  net.transformResponses({
    id: 'mark', enabled: () => true, markers: ['"SPONSORED"'], match: () => true,
    transform: (doc) => { calls++; delete doc.ad; return true; },
  });
  const keys = [];
  const out = win.JSON.parse('{"category":"SPONSORED","ad":1}', (key, value) => { keys.push(key); return key === 'ad' ? value + 1 : value; });
  assert.deepEqual(out, { category: 'SPONSORED', ad: 2 });
  assert.deepEqual(keys, ['category', 'ad', '']);
  assert.equal(calls, 0);
  assert.equal(win.JSON.parse.length, JSON.parse.length);
});

test('a GraphQL line Facebook parses again with JSON.parse is judged by its query, not as page data', async () => {
  const line = '{"node":{"__typename":"Story","id":"s1"}}';
  const { win } = fakeWindow({ chunks: [line] });
  const net = installNetworkHooks({ win, log: quietLog() });
  const seen = [];
  net.transformResponses({
    id: 'scoped', enabled: () => true, markers: ['"Story"'], match: () => true,
    // Stands in for a rule scoped to Home: it can't tell a query's answer from page data by route.
    transform: (doc, ctx) => {
      seen.push(ctx.transport);
      if (ctx.transport !== 'json-parse') return false;
      delete doc.node;
      return true;
    },
  });
  const text = await (await win.fetch('/api/graphql/', { method: 'POST', body: graphqlBody('ProfileCometTimelineFeedRefetchQuery') })).text();
  assert.equal(text, line);
  assert.deepEqual(win.JSON.parse(text), { node: { __typename: 'Story', id: 's1' } });
  assert.deepEqual(seen, ['fetch']);
  assert.deepEqual(win.JSON.parse('{"node":{"__typename":"Story","id":"inline"}}'), {}, 'page data still goes through');
  assert.deepEqual(seen, ['fetch', 'json-parse']);
});

test('a line is remembered by a short key that ignores the guard and whitespace around it', () => {
  const big = `{"data":{"node":{"__typename":"Story","text":"${'x'.repeat(5000)}"}}}`;
  const handled = createHandledLines(2);
  handled.add(`for (;;);${big}\r`);
  assert.equal(handled.has(big), true);
  assert.equal(handled.has(big.replace('Story', 'Stori')), false, 'a different line of the same length');
  assert.ok(lineKey(big).length < 600, 'a long line is not kept whole');
  handled.add('{"a":1}');
  handled.add('{"b":2}');
  assert.equal(handled.has(big), false, 'only the newest lines are kept');
});

test('a line answered while a rule was off still gets the JSON.parse pass', async () => {
  const line = '{"node":{"__typename":"Story","id":"s1"}}';
  const { win } = fakeWindow({ chunks: [line] });
  const net = installNetworkHooks({ win, log: quietLog() });
  let on = false;
  const seen = [];
  net.transformResponses({ id: 'other', enabled: () => true, markers: ['"node"'], match: () => true, transform: () => false });
  net.transformResponses({
    id: 'late', enabled: () => on, markers: ['"Story"'], match: () => true,
    transform: (doc, ctx) => seen.push(ctx.transport),
  });
  const text = await (await win.fetch('/api/graphql/', { method: 'POST', body: graphqlBody('Q') })).text();
  on = true;
  win.JSON.parse(text);
  assert.deepEqual(seen, ['json-parse'], 'the rule that was off at fetch time still sees the line');
});

test('blocked beacons report success without sending', () => {
  const { win, beacons } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog() });
  net.blockRequests({ id: 'bz', enabled: () => true, match: (ctx) => ctx.path === '/ajax/bz' });
  assert.equal(win.navigator.sendBeacon('/ajax/bz', 'x'), true);
  assert.equal(win.navigator.sendBeacon('/other', 'x'), true);
  assert.deepEqual(beacons, ['/other']);
});

test('a held-back request stays held when its rule fails to make an answer, beacons included', async () => {
  const { win, calls, beacons } = fakeWindow();
  const log = quietLog();
  const net = installNetworkHooks({ win, log });
  const asked = [];
  net.blockRequests({
    id: 'broken', enabled: () => true, match: (ctx) => ctx.path === '/ajax/bz',
    fakeResponse: (ctx) => { asked.push(ctx.transport); throw new Error('nope'); },
  });
  const answer = await win.fetch('/ajax/bz', { method: 'POST', body: 'x' });
  assert.equal(answer.status, 200);
  assert.equal(await answer.text(), '{}');
  assert.equal(win.navigator.sendBeacon('/ajax/bz', 'x'), true);
  assert.deepEqual(calls, []);
  assert.deepEqual(beacons, []);
  assert.deepEqual(asked, ['fetch', 'beacon'], 'the rule hears about the beacon too');
  assert.equal(log.errors.length, 1, 'logged once');
});

test('installing twice returns the same hooks', () => {
  const { win } = fakeWindow();
  const log = quietLog();
  assert.equal(installNetworkHooks({ win, log }), installNetworkHooks({ win, log }));
});
