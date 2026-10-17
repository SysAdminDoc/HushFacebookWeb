import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installNetworkHooks } from '../src/core/net/hooks.js';
import anonymousStories from '../src/features/stories/anonymous-stories.js';
import noWatchHistory from '../src/features/reels/no-watch-history.js';
import holdBackLogs from '../src/features/privacy/usage-logs.js';
import hideCommentTyping from '../src/features/comments/hide-comment-typing.js';
import sanitizeLinks from '../src/features/links/sanitize-links.js';

const quietLog = { error() {}, warn() {}, info() {}, debug() {} };
const graphqlBody = (name, extra = '') => new URLSearchParams({
  fb_api_req_friendly_name: name,
  doc_id: '1',
  variables: extra,
}).toString();
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function startupControl(options = {}) {
  let phase = options.state ?? 'loading';
  let accountMatches = true;
  const listeners = new Set();
  const startup = {
    waitMs: options.waitMs ?? 100,
    maxPending: options.maxPending ?? 16,
    maxBytes: options.maxBytes ?? 64 * 1024,
    status: () => phase,
    accountMatches: () => accountMatches,
    onStatus(listener) {
      listeners.add(listener);
      listener();
      return () => listeners.delete(listener);
    },
  };
  return {
    startup,
    set(next) {
      phase = next;
      for (const listener of listeners) listener();
    },
    changeAccount() {
      accountMatches = false;
    },
  };
}

function fakeWindow() {
  const calls = [];
  const beacons = [];
  const xhrCalls = [];
  const listeners = new Map();
  class FakeProgressEvent extends Event {}
  class FakeXhr extends EventTarget {
    constructor() {
      super();
      this.readyState = 0;
      this.status = 0;
      this.responseType = '';
      this._responseText = '';
      this.aborted = 0;
    }

    open(method, url, async = true) {
      this.method = method;
      this.url = url;
      this.async = async;
      this.readyState = 1;
    }

    setRequestHeader() {}

    send(body) {
      xhrCalls.push({ xhr: this, method: this.method, url: this.url, body });
      this._responseText = 'native';
      this.readyState = 4;
      this.status = 204;
    }

    abort() {
      this.aborted++;
      this.readyState = 0;
    }
  }
  Object.defineProperties(FakeXhr.prototype, {
    responseText: { configurable: true, get() { return this._responseText; } },
    response: { configurable: true, get() { return this._responseText; } },
  });
  const win = {
    Request, Response, Headers, ReadableStream, Promise, Event, DOMException,
    ProgressEvent: FakeProgressEvent,
    XMLHttpRequest: FakeXhr,
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
    location: { href: 'https://www.facebook.com/' },
    navigator: {
      clipboard: {},
      sendBeacon(url, data) {
        beacons.push({ url, data });
        return true;
      },
    },
    fetch(input, init) {
      calls.push({ input, init });
      return Promise.resolve(new Response('native', { status: 200 }));
    },
    setTimeout,
    clearTimeout,
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((found) => found !== listener));
    },
  };
  return { win, calls, beacons, xhrCalls };
}

function requestRule(net, enabled = () => true) {
  net.blockRequests({
    id: 'private-operation',
    startupPrivacy: true,
    enabled,
    match: (ctx) => ctx.friendlyName === 'PrivateMutation',
    fakeResponse: () => '{"held":true}',
  });
}

test('supported privacy fetches wait for saved choices while unknown traffic leaves immediately', async () => {
  const control = startupControl();
  const { win, calls } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog, startup: control.startup });
  const choices = new Map();
  const diagnostics = { add() {}, changed() {} };
  for (const feature of [anonymousStories, noWatchHistory, holdBackLogs, hideCommentTyping, sanitizeLinks]) {
    choices.set(feature.id, true);
    feature.setup({ win, net, diagnostics, enabled: () => choices.get(feature.id) });
  }

  const pending = [
    win.fetch('/api/graphql/', { method: 'POST', body: graphqlBody('storiesUpdateSeenStateMutation') }),
    win.fetch('/api/graphql/', { method: 'POST', body: graphqlBody('FBUnifiedVideoSeenStateMutation') }),
    win.fetch('/api/graphql/', { method: 'POST', body: graphqlBody('CometUFILiveTypingBroadcastMutation_StartMutation') }),
    win.fetch('/api/graphql/', { method: 'POST', body: graphqlBody('useLinkSharingCreateWrappedUrlMutation') }),
    win.fetch('/ajax/bnzai', { method: 'POST', body: new URLSearchParams({ q: '[]' }) }),
  ];
  const unknown = await win.fetch('/api/graphql/', { method: 'POST', body: graphqlBody('CometNewsFeedPaginationQuery') });
  assert.equal(await unknown.text(), 'native');
  assert.equal(calls.length, 1);
  assert.equal(net.startupPending(), 5);

  control.set('ready');
  const answers = await Promise.all(pending);
  assert.equal(calls.length, 1, 'every saved opt-out was applied before a request left');
  assert.equal(net.startupPending(), 0);
  assert.ok(answers.every((answer) => answer.status === 200));
});

test('a recognized fetch resumes when its saved switch is off', async () => {
  const control = startupControl();
  const { win, calls } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog, startup: control.startup });
  requestRule(net, () => false);
  const body = new URLSearchParams({ fb_api_req_friendly_name: 'PrivateMutation', value: 'before' });
  const response = win.fetch('/api/graphql/', { method: 'POST', body });
  body.set('value', 'after');
  assert.equal(calls.length, 0);
  control.set('ready');
  assert.equal(await (await response).text(), 'native');
  assert.equal(calls.length, 1);
  assert.match(await calls[0].input.text(), /value=before/);
});

test('failure, account change, teardown and timeout never flush deferred privacy fetches', async (t) => {
  const scenarios = {
    failure: ({ control }) => control.set('error'),
    'account change': ({ control }) => { control.changeAccount(); control.set('ready'); },
    teardown: ({ net }) => net.teardown(),
    timeout: async () => new Promise((resolve) => setTimeout(resolve, 20)),
  };
  for (const [name, stop] of Object.entries(scenarios)) {
    await t.test(name, async () => {
      const control = startupControl({ waitMs: 5 });
      const { win, calls } = fakeWindow();
      const net = installNetworkHooks({ win, log: quietLog, startup: control.startup });
      requestRule(net);
      const response = win.fetch('/api/graphql/', { method: 'POST', body: graphqlBody('PrivateMutation') });
      await stop({ control, net });
      assert.deepEqual(await (await response).json(), { held: true });
      assert.equal(calls.length, 0);
    });
  }
});

test('fetch startup holding is bounded and follows AbortSignal cancellation', async () => {
  const control = startupControl({ maxPending: 1, maxBytes: 300 });
  const { win, calls } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog, startup: control.startup });
  requestRule(net);

  const controller = new AbortController();
  const canceled = win.fetch('/api/graphql/', {
    method: 'POST', body: graphqlBody('PrivateMutation'), signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(canceled, (error) => error.name === 'AbortError');
  assert.equal(net.startupPending(), 0);

  const held = win.fetch('/api/graphql/', { method: 'POST', body: graphqlBody('PrivateMutation') });
  const overflow = await win.fetch('/api/graphql/', { method: 'POST', body: graphqlBody('PrivateMutation') });
  assert.deepEqual(await overflow.json(), { held: true }, 'the full queue fails closed');
  const large = await win.fetch('/api/graphql/', { method: 'POST', body: graphqlBody('PrivateMutation', 'x'.repeat(100)) });
  assert.deepEqual(await large.json(), { held: true }, 'an oversized known request fails closed');
  await win.fetch('/api/graphql/', { method: 'POST', body: graphqlBody('UnknownMutation', 'x'.repeat(1000)) });
  assert.equal(calls.length, 1, 'an unknown request never joins the privacy queue');
  control.set('ready');
  assert.deepEqual(await (await held).json(), { held: true });
  assert.equal(calls.length, 1);

  const formControl = startupControl({ maxBytes: 4 * 1024 });
  const formWindow = fakeWindow();
  const formNet = installNetworkHooks({ win: formWindow.win, log: quietLog, startup: formControl.startup });
  requestRule(formNet);
  const form = new FormData();
  form.append('fb_api_req_friendly_name', 'PrivateMutation');
  form.append('upload', new Blob([]), 'x'.repeat(2000));
  const formAnswer = await formWindow.win.fetch('/api/graphql/', { method: 'POST', body: form });
  assert.deepEqual(await formAnswer.json(), { held: true }, 'multipart metadata counts toward the byte bound');
  assert.equal(formNet.startupPending(), 0);
  assert.equal(formWindow.calls.length, 0);
});

test('XHR startup handling defers asynchronous requests, honors abort and fails closed when it cannot defer', async () => {
  const control = startupControl();
  const { win, xhrCalls } = fakeWindow();
  let enabled = true;
  const net = installNetworkHooks({ win, log: quietLog, startup: control.startup });
  requestRule(net, () => enabled);

  const held = new win.XMLHttpRequest();
  held.open('POST', '/api/graphql/');
  held.send(graphqlBody('PrivateMutation'));
  assert.equal(xhrCalls.length, 0);
  control.set('ready');
  await tick();
  assert.equal(held.status, 200);
  assert.deepEqual(JSON.parse(held.responseText), { held: true });
  assert.equal(xhrCalls.length, 0);

  const resumedControl = startupControl();
  const resumedWindow = fakeWindow();
  enabled = false;
  const resumedNet = installNetworkHooks({ win: resumedWindow.win, log: quietLog, startup: resumedControl.startup });
  requestRule(resumedNet, () => enabled);
  const resumed = new resumedWindow.win.XMLHttpRequest();
  resumed.open('POST', '/api/graphql/');
  const resumedBody = new URLSearchParams({ fb_api_req_friendly_name: 'PrivateMutation', value: 'before' });
  resumed.send(resumedBody);
  assert.throws(
    () => resumed.send(graphqlBody('PrivateMutation', 'second')),
    (error) => error.name === 'InvalidStateError',
  );
  resumedBody.set('value', 'after');
  resumedControl.set('ready');
  assert.equal(resumedWindow.xhrCalls.length, 1);
  assert.match(String(resumedWindow.xhrCalls[0].body), /value=before/);

  const abortedControl = startupControl();
  const abortedWindow = fakeWindow();
  const abortedNet = installNetworkHooks({ win: abortedWindow.win, log: quietLog, startup: abortedControl.startup });
  requestRule(abortedNet);
  const aborted = new abortedWindow.win.XMLHttpRequest();
  aborted.open('POST', '/api/graphql/');
  aborted.send(graphqlBody('PrivateMutation'));
  aborted.abort();
  abortedControl.set('ready');
  assert.equal(aborted.aborted, 1);
  assert.equal(abortedWindow.xhrCalls.length, 0);

  const reusedControl = startupControl();
  const reusedWindow = fakeWindow();
  const reusedNet = installNetworkHooks({ win: reusedWindow.win, log: quietLog, startup: reusedControl.startup });
  requestRule(reusedNet);
  const reused = new reusedWindow.win.XMLHttpRequest();
  reused.open('POST', '/api/graphql/');
  const params = new URLSearchParams({ fb_api_req_friendly_name: 'PrivateMutation', value: 'before' });
  reused.send(params);
  params.set('value', 'after');
  reused.open('POST', '/api/graphql/other');
  reused.send(graphqlBody('UnknownMutation'));
  reusedControl.set('ready');
  assert.deepEqual(reusedWindow.xhrCalls.map(({ url }) => url), ['/api/graphql/other']);

  const closedControl = startupControl({ state: 'error' });
  const closedWindow = fakeWindow();
  const closedNet = installNetworkHooks({ win: closedWindow.win, log: quietLog, startup: closedControl.startup });
  requestRule(closedNet);
  const reopened = new closedWindow.win.XMLHttpRequest();
  let staleLoads = 0;
  reopened.addEventListener('load', () => staleLoads++);
  reopened.open('POST', '/api/graphql/');
  reopened.send(graphqlBody('PrivateMutation'));
  reopened.open('POST', '/api/graphql/other');
  reopened.send(graphqlBody('UnknownMutation'));
  await tick();
  assert.equal(reopened.status, 204, 'reopening clears the locally completed response fields');
  assert.equal(reopened.responseText, 'native');
  assert.equal(staleLoads, 0, 'reopening cancels the old request completion events');
  assert.deepEqual(closedWindow.xhrCalls.map(({ url }) => url), ['/api/graphql/other']);

  const syncControl = startupControl();
  const syncWindow = fakeWindow();
  const syncNet = installNetworkHooks({ win: syncWindow.win, log: quietLog, startup: syncControl.startup });
  requestRule(syncNet);
  for (const asyncFlag of [false, 0, null, '']) {
    const synchronous = new syncWindow.win.XMLHttpRequest();
    synchronous.open('POST', '/api/graphql/', asyncFlag);
    synchronous.send(graphqlBody('PrivateMutation'));
    assert.equal(synchronous.status, 200);
  }
  assert.equal(syncWindow.xhrCalls.length, 0);
  const unknown = new syncWindow.win.XMLHttpRequest();
  unknown.open('POST', '/api/graphql/', false);
  unknown.send({ opaque: true });
  assert.equal(syncWindow.xhrCalls.length, 1, 'an uninspectable unknown body passes through');
});

test('sendBeacon drops only recognized privacy traffic until choices are confirmed', () => {
  const control = startupControl();
  const { win, beacons } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog, startup: control.startup });
  net.blockRequests({
    id: 'logs', startupPrivacy: true, enabled: () => false,
    match: (ctx) => ctx.path === '/ajax/bnzai', fakeResponse() {},
  });
  assert.equal(win.navigator.sendBeacon('/ajax/bnzai', new Blob(['opaque'])), true);
  assert.equal(win.navigator.sendBeacon('/ajax/other', 'x'), true);
  assert.deepEqual(beacons.map(({ url }) => url), ['/ajax/other']);
  control.set('ready');
  win.navigator.sendBeacon('/ajax/bnzai', 'x');
  assert.deepEqual(beacons.map(({ url }) => url), ['/ajax/other', '/ajax/bnzai']);
});
