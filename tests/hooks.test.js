// Network hooks against a stand-in window built from Node's own fetch classes. XHR needs a
// browser and is covered by the live checks in CONTRIBUTING.md.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DROP } from '../src/core/net/payload.js';
import { installNetworkHooks } from '../src/core/net/hooks.js';

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

test('blocked beacons report success without sending', () => {
  const { win, beacons } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog() });
  net.blockRequests({ id: 'bz', enabled: () => true, match: (ctx) => ctx.path === '/ajax/bz' });
  assert.equal(win.navigator.sendBeacon('/ajax/bz', 'x'), true);
  assert.equal(win.navigator.sendBeacon('/other', 'x'), true);
  assert.deepEqual(beacons, ['/other']);
});

test('installing twice returns the same hooks', () => {
  const { win } = fakeWindow();
  const log = quietLog();
  assert.equal(installNetworkHooks({ win, log }), installNetworkHooks({ win, log }));
});
