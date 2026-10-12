import assert from 'node:assert/strict';
import { test } from 'node:test';
import holdBackLogs, { EMPTY_ANSWER, isUsageLog } from '../src/features/privacy/usage-logs.js';
import { describeRequest, installNetworkHooks } from '../src/core/net/hooks.js';

function fakeWindow() {
  const calls = [];
  const beacons = [];
  const win = {
    Request, Response, Headers, ReadableStream, Promise, Event, setTimeout,
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
    location: { href: 'https://www.facebook.com/' },
    navigator: { sendBeacon: (url) => { beacons.push(url); return true; } },
    fetch(input, init) {
      calls.push({ input, init });
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
  };
  return { win, calls, beacons };
}

const quietLog = { error() {}, warn() {}, info() {}, debug() {} };

function setUp(on = true) {
  const { win, calls, beacons } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog });
  const rows = new Map();
  holdBackLogs.setup({ net, enabled: () => on, diagnostics: { add: (name, read) => rows.set(name, read), changed() {} } });
  return { win, calls, beacons, held: () => rows.get('Usage log batches held back')() };
}

// The batch as it went live (run 46): a multipart POST with Facebook's usual query.
const BATCH = 'https://www.facebook.com/ajax/bnzai?__a=1&__comet_req=15&dpr=1&ph=C3';

test('a usage log batch never leaves, and the page gets the empty answer Facebook gives', async () => {
  const { win, calls, held } = setUp();
  const form = new FormData();
  form.append('q', '[]');
  const answer = await win.fetch(BATCH, { method: 'POST', body: form });
  assert.equal(calls.length, 0);
  assert.equal(answer.status, 200);
  const text = await answer.text();
  assert.equal(text, EMPTY_ANSWER);
  assert.deepEqual(JSON.parse(text.slice('for (;;);'.length)), { __ar: 1, payload: null });
  assert.equal(held(), '1');
});

test('a batch sent with sendBeacon as the page closes is held back and counted too', () => {
  const { win, beacons, held } = setUp();
  assert.equal(win.navigator.sendBeacon('/ajax/bnzai?__a=1', 'q=[]'), true);
  assert.deepEqual(beacons, []);
  assert.equal(held(), '1');
  win.navigator.sendBeacon('/ajax/qm/?__a=1', 'x');
  assert.deepEqual(beacons, ['/ajax/qm/?__a=1'], 'only the usage log is held back');
});

test('everything else goes through, and so does the log with the switch off', async () => {
  const { win, calls } = setUp();
  await win.fetch('/api/graphql/', { method: 'POST', body: 'fb_api_req_friendly_name=CometNewsFeedPaginationQuery' });
  await win.fetch('/ajax/webstorage/process_keys/', { method: 'POST', body: 'state=x' });
  assert.equal(calls.length, 2);
  const off = setUp(false);
  await off.win.fetch(BATCH, { method: 'POST', body: 'q=[]' });
  assert.equal(off.calls.length, 1);
  assert.equal(off.held(), '0');
});

test('only facebook.com addresses count', () => {
  const ctx = (url) => describeRequest({ url, transport: 'fetch', base: 'https://www.facebook.com/' });
  assert.equal(isUsageLog(ctx('/ajax/bnzai')), true);
  assert.equal(isUsageLog(ctx('https://web.facebook.com/ajax/bnzai?__a=1')), true);
  assert.equal(isUsageLog(ctx('https://facebook.com.example.invalid/ajax/bnzai')), false);
  assert.equal(isUsageLog(ctx('https://www.facebook.com/ajax/bnzai/extra')), false);
});

test('the switch starts off, sits under Privacy and needs the page', () => {
  assert.equal(holdBackLogs.default, false);
  assert.equal(holdBackLogs.section, 'privacy');
  assert.equal(holdBackLogs.needsPage, true);
  assert.equal(holdBackLogs.android, 'Hold back analytics uploads');
});
