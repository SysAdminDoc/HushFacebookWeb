// Network hooks against a stand-in window built from Node's own fetch classes. XHR needs a
// browser and is covered by the live checks in CONTRIBUTING.md.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DROP, LINE_LIMIT } from '../src/core/net/payload.js';
import { createHandledLines, installNetworkHooks, lineKey } from '../src/core/net/hooks.js';

// respond(input, init) stands in for the network when a test needs a particular Response.
function fakeWindow({ chunks = ['{}'], status = 200, respond = null } = {}) {
  const calls = [];
  const beacons = [];
  const win = {
    Request, Response, Headers, ReadableStream, Promise, Event, setTimeout, clearTimeout,
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
    location: { href: 'https://www.facebook.com/' },
    navigator: { sendBeacon: (url) => { beacons.push(url); return true; } },
    fetch(input, init) {
      calls.push({ input, init });
      if (respond) return Promise.resolve(respond(input, init));
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

test('a fetched line past LINE_LIMIT goes through as sent, unparsed and counted, and the next line is still edited', async () => {
  const piece = 'x'.repeat(64 * 1024);
  const chunks = ['{"ad":1}\n{"ad":1,"pad":"', ...Array(Math.ceil(LINE_LIMIT / piece.length) + 2).fill(piece), '"}\r\n{"ad":1,"n":1}'];
  const sent = chunks.join('');
  const { win } = fakeWindow({ chunks });
  const warnings = [];
  const net = installNetworkHooks({ win, log: { ...quietLog(), warn: (message) => warnings.push(message) } });
  const parsed = [];
  net.transformResponses({
    id: 'ads', enabled: () => true, match: () => true,
    transform: (doc) => { parsed.push(Object.keys(doc).join()); return 'ad' in doc ? delete doc.ad : undefined; },
  });
  const text = await (await win.fetch('/api/graphql/', { method: 'POST', body: graphqlBody('Feed') })).text();
  const expected = `{}\n${sent.slice('{"ad":1}\n'.length, -'{"ad":1,"n":1}'.length)}{"n":1}`;
  assert.equal(text.length, expected.length);
  assert.ok(text === expected, 'the long line is byte for byte what Facebook sent');
  assert.deepEqual(parsed, ['ad', 'ad,n'], 'the long line never reached a rule');
  assert.equal(net.lineStats.oversized, 1);
  assert.equal(warnings.length, 1);
  await (await win.fetch('/api/graphql/', { method: 'POST', body: graphqlBody('Feed') })).text();
  assert.equal(net.lineStats.oversized, 2);
  assert.equal(warnings.length, 1, 'the log says so once per tab');
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

const seenRule = (calls) => ({
  id: 'seen', enabled: () => true, fakeResponse: () => '{"held":true}',
  match: (ctx) => { calls?.push(ctx); return ctx.path === '/api/graphql/' && ctx.friendlyName === 'storiesUpdateSeenStateMutation'; },
});
const GRAPHQL = 'https://www.facebook.com/api/graphql/';

test('a Request that carries its form alone is judged by the operation in it, and goes out unread', async () => {
  const { win, calls } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog() });
  net.blockRequests(seenRule());
  const held = await win.fetch(new Request(GRAPHQL, { method: 'POST', body: new URLSearchParams(graphqlBody('storiesUpdateSeenStateMutation')) }));
  assert.equal(await held.text(), '{"held":true}');
  const form = new FormData();
  form.append('fb_api_req_friendly_name', 'storiesUpdateSeenStateMutation');
  form.append('doc_id', '1');
  assert.equal(await (await win.fetch(new Request(GRAPHQL, { method: 'POST', body: form }))).text(), '{"held":true}', 'multipart too');
  assert.equal(calls.length, 0);

  const other = new Request(GRAPHQL, { method: 'POST', body: new URLSearchParams(graphqlBody('SomethingElse')) });
  await win.fetch(other);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, other, 'the page\'s own Request is sent');
  assert.equal(other.bodyUsed, false, 'reading the form left it unread');
  assert.equal(await other.text(), graphqlBody('SomethingElse'));
});

test('a form-only Request is read in a browser with no Request.body, as Firefox has none', async () => {
  const { win, calls } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog() });
  net.blockRequests(seenRule());
  const noBody = (request) => {
    Object.defineProperty(request, 'body', { value: undefined });
    const clone = request.clone.bind(request);
    Object.defineProperty(request, 'clone', { value: () => noBody(clone()) });
    return request;
  };
  const held = await win.fetch(noBody(new Request(GRAPHQL, { method: 'POST', body: new URLSearchParams(graphqlBody('storiesUpdateSeenStateMutation')) })));
  assert.equal(await held.text(), '{"held":true}');
  const big = noBody(new Request(GRAPHQL, { method: 'POST', body: new URLSearchParams(`${graphqlBody('storiesUpdateSeenStateMutation')}&pad=${'x'.repeat(70 * 1024)}`) }));
  await win.fetch(big);
  assert.equal(calls.length, 1, 'too big to read there too, so it goes out');
  assert.equal(calls[0].input, big);
});

test('a Request named in its header is judged at once, before any body is read', () => {
  const { win, calls } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog() });
  const seen = [];
  net.blockRequests(seenRule(seen));
  win.fetch(new Request(GRAPHQL, { method: 'POST', headers: { 'x-fb-friendly-name': 'Other', 'content-type': 'application/x-www-form-urlencoded' }, body: graphqlBody('storiesUpdateSeenStateMutation') }));
  assert.equal(calls.length, 1, 'sent in the same turn');
  assert.equal(seen[0].friendlyName, 'Other', 'the header names it, as for any fetch');
});

test('a Request made in another window is read by its URL and form', async () => {
  const { win, calls } = fakeWindow();
  // Another window's Request isn't an instance of this one's.
  win.Request = class PageRequest extends Request {};
  const net = installNetworkHooks({ win, log: quietLog() });
  const seen = [];
  net.blockRequests(seenRule(seen));
  const held = await win.fetch(new Request(GRAPHQL, { method: 'POST', body: new URLSearchParams(graphqlBody('storiesUpdateSeenStateMutation')) }));
  assert.equal(await held.text(), '{"held":true}');
  assert.equal(seen[0].url, GRAPHQL);
  assert.equal(seen[0].method, 'POST');
  assert.equal(calls.length, 0);
});

test('a form too big to read, of another type, never finished or aborted goes out as it came', async () => {
  const { win, calls } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog() });
  const seen = [];
  net.blockRequests(seenRule(seen));
  const big = `${graphqlBody('storiesUpdateSeenStateMutation')}&pad=${'x'.repeat(70 * 1024)}`;
  const tooBig = new Request(GRAPHQL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: big });
  await win.fetch(tooBig);
  assert.equal(calls.at(-1).input, tooBig);
  assert.equal(await tooBig.text(), big, 'nothing of it was used up');

  const json = new Request(GRAPHQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"fb_api_req_friendly_name":"storiesUpdateSeenStateMutation"}' });
  win.fetch(json);
  assert.equal(calls.at(-1).input, json, 'another type is sent in the same turn');

  const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };
  const endless = new Request(GRAPHQL, { method: 'POST', headers: formHeaders, duplex: 'half', body: new ReadableStream({ start() {} }) });
  const started = Date.now();
  await win.fetch(endless);
  assert.equal(calls.at(-1).input, endless);
  assert.ok(Date.now() - started < 2000, 'a stalled body is given up on');

  const controller = new AbortController();
  const aborted = new Request(GRAPHQL, { method: 'POST', headers: formHeaders, duplex: 'half', signal: controller.signal, body: new ReadableStream({ start() {} }) });
  const pending = win.fetch(aborted);
  controller.abort();
  await pending;
  assert.equal(calls.at(-1).input, aborted, 'an abort hands it straight to the browser, which rejects it');
  assert.equal(calls.length, 4);
  assert.ok(seen.every((ctx) => ctx.friendlyName === ''), 'no operation was claimed for any of them');
});

test('a rewritten response keeps where it came from, on its clones too', async () => {
  const source = () => {
    const response = new Response('{"n":1}\n{"n":2}', { status: 200, statusText: 'OK', headers: { 'x-kept': 'yes' } });
    for (const [key, value] of Object.entries({ url: 'https://www.facebook.com/api/graphql/?moved=1', redirected: true, type: 'basic' })) {
      Object.defineProperty(response, key, { value });
    }
    return response;
  };
  const { win } = fakeWindow({ respond: source });
  const net = installNetworkHooks({ win, log: quietLog() });
  net.transformResponses({ id: 'drop-2', enabled: () => true, match: () => true, transform: (doc) => (doc.n === 2 ? DROP : undefined) });
  const response = await win.fetch('/api/graphql/');
  const copy = response.clone();
  for (const each of [response, copy]) {
    assert.equal(each.url, 'https://www.facebook.com/api/graphql/?moved=1');
    assert.equal(each.redirected, true);
    assert.equal(each.type, 'basic');
    assert.equal(each.statusText, 'OK');
    assert.equal(each.headers.get('x-kept'), 'yes');
    assert.ok(each instanceof win.Response);
  }
  assert.equal(copy.clone().url, 'https://www.facebook.com/api/graphql/?moved=1', 'a clone of a clone too');
  assert.equal(await copy.text(), '{"n":1}\n');
  assert.equal(await response.text(), '{"n":1}\n');
});

test('cancelling a rewritten body cancels the source, and an abort mid-body reaches the reader', async () => {
  let cancelled = null;
  const cancellable = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"n":1}\n')); },
    cancel(reason) { cancelled = reason; },
  }));
  const { win } = fakeWindow({ respond: cancellable });
  const net = installNetworkHooks({ win, log: quietLog() });
  net.transformResponses({ id: 'touch', enabled: () => true, match: () => true, transform: () => undefined });
  const response = await win.fetch('/api/graphql/');
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), '{"n":1}\n');
  await reader.cancel('page left');
  assert.equal(cancelled, 'page left');

  const aborting = () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"n":1}\n'));
      setTimeout(() => controller.error(new DOMException('The operation was aborted.', 'AbortError')), 5);
    },
  }));
  const second = fakeWindow({ respond: aborting });
  installNetworkHooks({ win: second.win, log: quietLog() }).transformResponses({ id: 'touch', enabled: () => true, match: () => true, transform: () => undefined });
  await assert.rejects((await second.win.fetch('/api/graphql/')).text(), { name: 'AbortError' });
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
