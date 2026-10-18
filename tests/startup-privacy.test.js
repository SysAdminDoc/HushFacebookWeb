import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installNetworkHooks } from '../src/core/net/hooks.js';
import anonymousStories from '../src/features/stories/anonymous-stories.js';
import noWatchHistory from '../src/features/reels/no-watch-history.js';
import holdBackLogs from '../src/features/privacy/usage-logs.js';
import hideCommentTyping from '../src/features/comments/hide-comment-typing.js';
import sanitizeLinks from '../src/features/links/sanitize-links.js';
import { DROP, LINE_LIMIT } from '../src/core/net/payload.js';

const quietLog = { error() {}, warn() {}, info() {}, debug() {} };
const graphqlBody = (name, extra = '') => new URLSearchParams({
  fb_api_req_friendly_name: name,
  doc_id: '1',
  variables: extra,
}).toString();
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const attempt = (fn) => {
  try {
    fn();
    return 'ok';
  } catch (error) {
    return error.name;
  }
};

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

function fakeWindow({ respond = () => 'native' } = {}) {
  const calls = [];
  const beacons = [];
  const xhrCalls = [];
  const listeners = new Map();
  const immediates = new WeakSet();
  class FakeProgressEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.lengthComputable = Boolean(init.lengthComputable);
      this.loaded = init.loaded ?? 0;
      this.total = init.total ?? 0;
    }
  }
  class FakeUpload extends EventTarget {}
  class FakeXhr extends EventTarget {
    constructor() {
      super();
      this.readyState = 0;
      this.status = 0;
      this._responseType = '';
      this._withCredentials = false;
      this._responseText = '';
      this.aborted = 0;
      this.upload = new FakeUpload();
    }

    // Like a browser, open() announces OPENED only when the state changes, refuses a method
    // that isn't a token, and abort() on a request that was never sent leaves it OPENED.
    open(method, url, async) {
      if (/\s/.test(method)) throw new DOMException(`'${method}' is not a valid HTTP method.`, 'SyntaxError');
      this.method = method;
      this.url = url;
      this.async = arguments.length < 3 || Boolean(async);
      if (this.readyState === 1) return;
      this.readyState = 1;
      this.dispatchEvent(new Event('readystatechange'));
    }

    setRequestHeader() {}

    getResponseHeader() {
      return null;
    }

    getAllResponseHeaders() {
      return '';
    }

    overrideMimeType() {}

    // An asynchronous send starts the way a browser's does, before it returns.
    send(body) {
      xhrCalls.push({ xhr: this, method: this.method, url: this.url, body });
      if (this.async) {
        this.dispatchEvent(new FakeProgressEvent('loadstart'));
        if (body !== undefined && body !== null) this.upload.dispatchEvent(new FakeProgressEvent('loadstart'));
      }
      this._responseText = respond(this.url);
      this.readyState = 4;
      this.status = 204;
    }

    abort() {
      this.aborted++;
      if (this.readyState === 4) this.readyState = 0;
    }
  }
  Object.defineProperties(FakeXhr.prototype, {
    responseText: { configurable: true, get() { return this._responseText; } },
    response: { configurable: true, get() { return this._responseText; } },
    responseType: { configurable: true, get() { return this._responseType; }, set(value) { this._responseType = value; } },
    withCredentials: { configurable: true, get() { return this._withCredentials; }, set(value) { this._withCredentials = Boolean(value); } },
  });
  const win = {
    Request, Response, Headers, ReadableStream, Promise, Event, DOMException, TextEncoder, Blob,
    ProgressEvent: FakeProgressEvent,
    XMLHttpRequest: FakeXhr,
    XMLHttpRequestUpload: FakeUpload,
    queueMicrotask,
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
    // A browser runs a 0 ms timer within a millisecond or so, where Node on Windows waits for
    // its 15 ms clock tick, which would stretch a held answer's steps past the tests' waits.
    setTimeout(callback, ms, ...args) {
      if (ms > 0) return setTimeout(callback, ms, ...args);
      const handle = setImmediate(callback, ...args);
      immediates.add(handle);
      return handle;
    },
    clearTimeout(handle) {
      if (immediates.has(handle)) clearImmediate(handle);
      else clearTimeout(handle);
    },
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

test('a recognized Request that carries its form alone waits too, and leaves whole once its switch is off', async () => {
  const control = startupControl();
  const { win, calls } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog, startup: control.startup });
  requestRule(net, () => false);
  const body = new URLSearchParams({ fb_api_req_friendly_name: 'PrivateMutation', value: 'kept' }).toString();
  const response = win.fetch(new Request('https://www.facebook.com/api/graphql/', { method: 'POST', body: new URLSearchParams(body) }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 0);
  assert.equal(net.startupPending(), 1, 'held for the saved choices, not answered for them');
  control.set('ready');
  assert.equal(await (await response).text(), 'native');
  assert.equal(calls.length, 1);
  assert.equal(await calls[0].input.text(), body);
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

// Issue #2: another script on the page had already swapped the prototype's responseText for a
// getter that reads this.response. The transform's response getter read responseText again,
// and the two called each other until the stack ran out (Facebook stayed on its skeletons).
test('a transformed XHR still reads when another script built responseText on top of response', () => {
  const window = fakeWindow({ respond: () => '{"ad":1}\n{"n":1}' });
  const proto = window.win.XMLHttpRequest.prototype;
  const nativeText = Object.getOwnPropertyDescriptor(proto, 'responseText').get;
  let foreignReads = 0;
  Object.defineProperty(proto, 'responseText', {
    configurable: true,
    get() {
      foreignReads++;
      const value = this.response;
      return typeof value === 'string' ? value : nativeText.call(this);
    },
  });
  const net = installNetworkHooks({ win: window.win, log: quietLog, startup: startupControl({ state: 'ready' }).startup });
  net.transformResponses({ id: 'drop-ad', enabled: () => true, match: () => true, transform: (doc) => ('ad' in doc ? DROP : undefined) });
  const xhr = new window.win.XMLHttpRequest();
  xhr.open('POST', '/api/graphql/');
  xhr.send(graphqlBody('Feed'));
  assert.equal(xhr.responseText, '{"n":1}');
  assert.equal(xhr.response, '{"n":1}');
  assert.ok(foreignReads > 0, "the other script's getter still runs");
});

test('an XHR read while a line past LINE_LIMIT arrives shows it as sent, a growing prefix each time', () => {
  const window = fakeWindow({ respond: () => '' });
  const net = installNetworkHooks({ win: window.win, log: quietLog, startup: startupControl({ state: 'ready' }).startup });
  net.transformResponses({ id: 'cut-ad', enabled: () => true, match: () => true, transform: (doc) => ('ad' in doc ? delete doc.ad : undefined) });
  const xhr = new window.win.XMLHttpRequest();
  xhr.open('POST', '/api/graphql/');
  xhr.send(graphqlBody('Feed'));
  xhr.readyState = 3;
  const piece = 'x'.repeat(512 * 1024);
  const pieces = ['{"ad":1}\n{"ad":1,"pad":"', ...Array(Math.ceil(LINE_LIMIT / piece.length) + 1).fill(piece), '"}\n{"ad":2,', '"n":1}'];
  let last = '';
  for (const [index, part] of pieces.entries()) {
    xhr._responseText += part;
    if (index === pieces.length - 1) xhr.readyState = 4;
    const read = xhr.responseText;
    assert.ok(read.startsWith(last), `read ${index} keeps what earlier reads showed`);
    last = read;
  }
  const sent = pieces.join('');
  assert.ok(last === `{}\n${sent.slice('{"ad":1}\n'.length, -'{"ad":2,"n":1}'.length)}{"n":1}`, 'the long line is what Facebook sent, the lines around it are edited');
  assert.equal(net.lineStats.oversized, 1);
});

test('a reused XHR shows only its current request, whatever the last one was', async () => {
  const setup = () => {
    const window = fakeWindow({ respond: (url) => (url === '/api/graphql/' ? '{"ad":1}\n{"n":1}' : '{"ad":2}') });
    const net = installNetworkHooks({ win: window.win, log: quietLog, startup: startupControl({ state: 'ready' }).startup });
    requestRule(net);
    net.transformResponses({
      id: 'drop-ad', enabled: () => true, match: (ctx) => ctx.path === '/api/graphql/',
      transform: (doc) => ('ad' in doc ? DROP : undefined),
    });
    const xhr = new window.win.XMLHttpRequest();
    const events = [];
    for (const type of ['readystatechange', 'load', 'abort', 'loadend']) {
      xhr.addEventListener(type, () => events.push(`${type}@${xhr.readyState}/${xhr.status}`));
    }
    return { ...window, xhr, events };
  };
  const ownGetter = (xhr, key) => Object.getOwnPropertyDescriptor(xhr, key)?.get;

  const transformed = setup();
  transformed.xhr.open('POST', '/api/graphql/');
  transformed.xhr.send(graphqlBody('Feed'));
  assert.equal(transformed.xhr.responseText, '{"n":1}');
  transformed.xhr.open('POST', '/ajax/plain');
  assert.equal(ownGetter(transformed.xhr, 'responseText'), undefined, 'reopening removes the transform getters');
  transformed.xhr.send(graphqlBody('Feed'));
  assert.equal(transformed.xhr.responseText, '{"ad":2}');
  assert.equal(transformed.xhr.response, '{"ad":2}');

  const blocked = setup();
  blocked.xhr.open('POST', '/api/graphql/');
  blocked.xhr.send(graphqlBody('PrivateMutation'));
  assert.equal(blocked.xhr.readyState, 1, 'a held answer is still loading until its events run');
  await tick();
  assert.deepEqual(blocked.events, [
    'readystatechange@1/0', 'readystatechange@2/200', 'readystatechange@3/200', 'readystatechange@4/200', 'load@4/200', 'loadend@4/200',
  ]);
  assert.equal(blocked.xhr.responseURL, 'https://www.facebook.com/api/graphql/');
  blocked.events.length = 0;
  blocked.xhr.open('POST', '/ajax/plain');
  assert.equal(blocked.xhr.readyState, 1);
  assert.equal(blocked.xhr.status, 0);
  blocked.xhr.send(graphqlBody('UnknownMutation'));
  await tick();
  assert.equal(blocked.xhr.status, 204);
  assert.equal(blocked.xhr.responseText, '{"ad":2}');
  assert.equal(blocked.xhr.responseURL, undefined, 'the stand-in has no responseURL of its own');
  assert.deepEqual(blocked.events, ['readystatechange@1/0'], 'reopening a finished answer announces OPENED, as a real one does');
  assert.deepEqual(blocked.xhrCalls.map(({ url }) => url), ['/ajax/plain']);

  const aborted = setup();
  aborted.xhr.open('POST', '/api/graphql/');
  aborted.xhr.send(graphqlBody('PrivateMutation'));
  aborted.events.length = 0;
  aborted.xhr.abort();
  assert.deepEqual(aborted.events, ['readystatechange@4/0', 'abort@4/0', 'loadend@4/0']);
  assert.equal(aborted.xhr.readyState, 0);
  assert.equal(aborted.xhr.responseText, '');
  aborted.xhr.abort();
  assert.equal(aborted.xhr.readyState, 0, 'aborting an unsent request leaves it unsent');
  await tick();
  assert.equal(aborted.events.length, 3, 'an aborted answer never completes');
  aborted.events.length = 0;
  aborted.xhr.open('POST', '/ajax/plain');
  assert.equal(aborted.xhr.readyState, 1);
  assert.equal(ownGetter(aborted.xhr, 'readyState'), undefined);
  aborted.xhr.send(graphqlBody('UnknownMutation'));
  assert.equal(aborted.xhr.status, 204);
  assert.equal(aborted.xhr.responseText, '{"ad":2}');
  assert.deepEqual(aborted.events, ['readystatechange@1/0'], 'reopening an aborted answer announces OPENED, as a real one does');

  const done = setup();
  done.xhr.open('POST', '/api/graphql/');
  done.xhr.send(graphqlBody('PrivateMutation'));
  await tick();
  done.events.length = 0;
  done.xhr.abort();
  assert.deepEqual(done.events, [], 'aborting a finished request fires nothing');
  assert.equal(done.xhr.readyState, 0);
  assert.equal(done.xhr.status, 0);

  const heldControl = startupControl();
  const heldWindow = fakeWindow();
  const heldNet = installNetworkHooks({ win: heldWindow.win, log: quietLog, startup: heldControl.startup });
  requestRule(heldNet);
  const waiting = new heldWindow.win.XMLHttpRequest();
  const heldEvents = [];
  waiting.addEventListener('abort', () => heldEvents.push(`abort@${waiting.readyState}`));
  waiting.addEventListener('load', () => heldEvents.push('load'));
  waiting.open('POST', '/api/graphql/');
  waiting.send(graphqlBody('PrivateMutation'));
  waiting.abort();
  heldControl.set('ready');
  await tick();
  assert.deepEqual(heldEvents, ['abort@4'], 'a request held for saved choices fails like a real abort');
  assert.equal(heldWindow.xhrCalls.length, 0);

  const reentrant = setup();
  let reopened = false;
  reentrant.xhr.addEventListener('readystatechange', () => {
    if (reopened || reentrant.xhr.readyState !== 4) return;
    reopened = true;
    reentrant.xhr.open('POST', '/ajax/plain');
  });
  reentrant.xhr.open('POST', '/api/graphql/', false);
  reentrant.events.length = 0;
  reentrant.xhr.send(graphqlBody('PrivateMutation'));
  assert.deepEqual(reentrant.events, ['readystatechange@4/200', 'readystatechange@1/0'], 'reopening from readystatechange stops load, as in Chromium');
  assert.equal(reentrant.xhr.readyState, 1);
  assert.equal(reentrant.xhr.status, 0);

  // Measured in Chromium 155 and Firefox 156: once abort or load has fired, loadend follows
  // whatever the handler did, and reads the state the handler left.
  const handlers = async (type, act, abortAtSend) => {
    const { xhr, events } = setup();
    xhr.open('POST', '/api/graphql/');
    xhr.send(graphqlBody('PrivateMutation'));
    xhr.addEventListener(type, () => act(xhr), { once: true });
    events.length = 0;
    if (abortAtSend) xhr.abort();
    await tick();
    return { events, readyState: xhr.readyState };
  };
  const reopen = (xhr) => xhr.open('POST', '/ajax/plain');
  assert.deepEqual(await handlers('abort', reopen, true), {
    events: ['readystatechange@4/0', 'abort@4/0', 'readystatechange@1/0', 'loadend@1/0'], readyState: 1,
  });
  assert.deepEqual(await handlers('readystatechange', reopen, true), {
    events: ['readystatechange@4/0', 'readystatechange@1/0', 'abort@1/0', 'loadend@1/0'], readyState: 1,
  });
  const answered = ['readystatechange@2/200', 'readystatechange@3/200', 'readystatechange@4/200', 'load@4/200'];
  assert.deepEqual(await handlers('load', reopen, false), {
    events: [...answered, 'readystatechange@1/0', 'loadend@1/0'], readyState: 1,
  });
  assert.deepEqual(await handlers('load', (xhr) => xhr.abort(), false), {
    events: [...answered, 'loadend@0/0'], readyState: 0,
  });
});

test('a held-back XHR answer reads the way its responseType asks', async () => {
  const { win } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog, startup: startupControl({ state: 'ready' }).startup });
  requestRule(net);
  const answer = async (responseType) => {
    const xhr = new win.XMLHttpRequest();
    xhr.open('POST', '/api/graphql/');
    xhr.responseType = responseType;
    xhr.send(graphqlBody('PrivateMutation'));
    await tick();
    return xhr;
  };

  const json = await answer('json');
  assert.deepEqual(json.response, { held: true });
  assert.equal(json.response, json.response, 'the parsed answer is one object, as the XHR spec has it');
  assert.throws(() => json.responseText, (error) => error.name === 'InvalidStateError');
  const buffer = await answer('arraybuffer');
  assert.ok(buffer.response instanceof ArrayBuffer);
  assert.equal(new TextDecoder().decode(buffer.response), '{"held":true}');
  const blob = await answer('blob');
  assert.equal(await blob.response.text(), '{"held":true}');
  assert.equal((await answer('document')).response, null);
  assert.equal((await answer('text')).response, '{"held":true}');
  assert.equal((await answer('')).responseText, '{"held":true}');

  const pageDefined = new win.XMLHttpRequest();
  Object.defineProperty(pageDefined, 'responseURL', { configurable: true, writable: true, value: 'page-defined' });
  pageDefined.open('POST', '/api/graphql/');
  pageDefined.send(graphqlBody('PrivateMutation'));
  await tick();
  assert.equal(pageDefined.responseURL, 'https://www.facebook.com/api/graphql/');
  Object.defineProperty(pageDefined, 'statusText', { configurable: true, value: 'page-replaced' });
  pageDefined.open('POST', '/ajax/plain');
  assert.equal(pageDefined.responseURL, 'page-defined', "reopening puts back the page's own property");
  assert.equal(pageDefined.statusText, 'page-replaced', "a property the page replaced stays the page's");

  const locked = new win.XMLHttpRequest();
  Object.defineProperty(locked, 'statusText', { configurable: false, value: 'page-locked' });
  const loads = [];
  locked.addEventListener('load', () => loads.push(locked.status));
  locked.open('POST', '/api/graphql/');
  locked.send(graphqlBody('PrivateMutation'));
  await tick();
  assert.deepEqual(loads, [200], 'a property the page locked for good does not stop the answer');
  assert.equal(locked.statusText, 'page-locked');
  assert.equal(locked.responseText, '{"held":true}');

  const early = new win.XMLHttpRequest();
  const reads = [];
  early.addEventListener('loadstart', () => reads.push(attempt(() => early.responseText), early.response));
  early.open('POST', '/api/graphql/');
  early.responseType = 'json';
  early.send(graphqlBody('PrivateMutation'));
  assert.deepEqual(reads, ['InvalidStateError', null], 'a sent json request refuses responseText from the start, as in Firefox');

  const typed = new win.XMLHttpRequest();
  const seen = [];
  typed.addEventListener('readystatechange', () => seen.push(`${typed.readyState}:${JSON.stringify(typed.response)}`));
  const typedEnd = new Promise((resolve) => typed.addEventListener('loadend', resolve));
  typed.open('POST', '/api/graphql/');
  typed.responseType = 'json';
  typed.send(graphqlBody('PrivateMutation'));
  await typedEnd;
  assert.deepEqual(seen, ['1:""', '2:null', '3:null', '4:{"held":true}'], 'opened as text, then a json answer stays null until DONE');
});

// Measured against an unhooked XHR in Chromium 155 and Firefox 156, answered by a local server
// with the same text: one header, the body in one piece and no length.
test('a held-back XHR goes through the steps a browser shows for a real answer', async () => {
  const { win } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog, startup: startupControl({ state: 'ready' }).startup });
  requestRule(net);
  const body = graphqlBody('PrivateMutation');
  const up = body.length;
  const watch = (xhr) => {
    const trace = [];
    const snap = () => `${xhr.readyState}/${xhr.status}|${xhr.getResponseHeader('Content-Type')}|${xhr.responseText.length}`;
    const ended = new Promise((resolve) => xhr.addEventListener('loadend', resolve));
    for (const type of ['loadstart', 'progress', 'readystatechange', 'load', 'loadend']) {
      xhr.addEventListener(type, (event) => {
        trace.push(`${type}${'loaded' in event ? `[${event.loaded},${event.total},${event.lengthComputable}]` : ''}@${snap()}`);
        queueMicrotask(() => trace.push(`micro:${type}`));
      });
    }
    for (const type of ['loadstart', 'progress', 'load', 'loadend']) {
      xhr.upload.addEventListener(type, (event) => trace.push(`upload.${type}[${event.loaded},${event.total},${event.lengthComputable}]`));
    }
    return { trace, snap, ended };
  };

  const xhr = new win.XMLHttpRequest();
  const { trace, snap, ended } = watch(xhr);
  xhr.open('POST', '/api/graphql/');
  xhr.send(body);
  trace.push(`sent@${snap()}`);
  await ended;
  await tick();
  const answer = 'text/plain;charset=UTF-8|13';
  assert.deepEqual(trace, [
    'readystatechange@1/0|null|0',
    'loadstart[0,0,false]@1/0|null|0',
    `upload.loadstart[0,${up},true]`,
    'sent@1/0|null|0',
    'micro:readystatechange',
    'micro:loadstart',
    `upload.progress[${up},${up},true]`,
    `upload.load[${up},${up},true]`,
    `upload.loadend[${up},${up},true]`,
    'readystatechange@2/200|text/plain;charset=UTF-8|0',
    'micro:readystatechange',
    `readystatechange@3/200|${answer}`,
    'micro:readystatechange',
    `progress[13,0,false]@3/200|${answer}`,
    'micro:progress',
    `readystatechange@4/200|${answer}`,
    'micro:readystatechange',
    `load[13,0,false]@4/200|${answer}`,
    'micro:load',
    `loadend[13,0,false]@4/200|${answer}`,
    'micro:loadend',
  ], "each event's microtasks run before the next event, as they do for a real answer");
  assert.equal(xhr.getAllResponseHeaders(), 'content-type: text/plain;charset=UTF-8\r\n');

  for (const flag of [[false], [undefined]]) {
    const sync = new win.XMLHttpRequest();
    const steps = watch(sync);
    sync.open('POST', '/api/graphql/', ...flag);
    sync.send(body);
    steps.trace.push('sent');
    assert.deepEqual(steps.trace, [
      'readystatechange@1/0|null|0',
      `readystatechange@4/200|${answer}`,
      `load[13,0,false]@4/200|${answer}`,
      `loadend[13,0,false]@4/200|${answer}`,
      'sent',
    ], `a synchronous answer (async ${flag[0]}) finishes before send() returns, with no loadstart or upload`);
  }
});

test('a held-back XHR refuses what a sent, finished or aborted one refuses', async () => {
  const { win } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog, startup: startupControl({ state: 'ready' }).startup });
  requestRule(net);
  const xhr = new win.XMLHttpRequest();
  const ended = new Promise((resolve) => xhr.addEventListener('loadend', resolve));
  xhr.open('POST', '/api/graphql/');
  xhr.send(graphqlBody('PrivateMutation'));
  const attempts = () => ({
    header: attempt(() => xhr.setRequestHeader('x-a', '1')),
    credentials: attempt(() => { xhr.withCredentials = true; }),
    type: attempt(() => { xhr.responseType = ''; }),
    mime: attempt(() => xhr.overrideMimeType('text/plain')),
    send: attempt(() => xhr.send()),
  });
  const refused = 'InvalidStateError';
  assert.deepEqual(attempts(), { header: refused, credentials: refused, type: 'ok', mime: 'ok', send: refused }, 'sent');
  await ended;
  assert.deepEqual(attempts(), { header: refused, credentials: refused, type: refused, mime: refused, send: refused }, 'done');
  xhr.abort();
  assert.equal(xhr.readyState, 0);
  assert.deepEqual(attempts(), { header: refused, credentials: 'ok', type: 'ok', mime: 'ok', send: refused }, 'unsent');
  assert.equal(xhr.withCredentials, true, 'an allowed change reaches the browser');
});

// Each trace is what the XHR spec gives a real request, and what Chromium 155 showed for one.
test('a held-back XHR ends the way a real one does when the page aborts or reopens part way', async () => {
  const body = graphqlBody('PrivateMutation');
  const up = body.length;
  const answer = 'text/plain;charset=UTF-8';
  // Sends one held-back request with act() listening after the recorder, then waits out its steps.
  const run = async ({ state = 'ready', switchOn = true, method = 'POST', payload = body, on, at, act, then = () => {} }) => {
    const control = startupControl({ state });
    const { win, xhrCalls } = fakeWindow();
    const net = installNetworkHooks({ win, log: quietLog, startup: control.startup });
    requestRule(net, () => switchOn);
    const xhr = new win.XMLHttpRequest();
    const trace = [];
    const shown = () => `@${xhr.readyState}/${xhr.status}|${xhr.getResponseHeader('content-type')}`;
    const progress = (event) => `[${event.loaded},${event.total},${event.lengthComputable}]`;
    for (const type of ['loadstart', 'readystatechange', 'progress', 'abort', 'load', 'loadend']) {
      xhr.addEventListener(type, (event) => trace.push(`${type}${type === 'readystatechange' ? '' : progress(event)}${shown()}`));
    }
    for (const type of ['loadstart', 'progress', 'abort', 'load', 'loadend']) {
      xhr.upload.addEventListener(type, (event) => trace.push(`upload.${type}${progress(event)}`));
    }
    let acted = false;
    if (on) {
      xhr.addEventListener(on, () => {
        if (acted || (at !== undefined && xhr.readyState !== at)) return;
        acted = true;
        act(xhr);
      });
    }
    xhr.open(method, '/api/graphql/');
    xhr.send(payload);
    if (!on && act) act(xhr);
    then(control);
    await tick();
    trace.push(`end${shown()}`);
    return { trace, xhrCalls };
  };
  const opened = ['readystatechange@1/0|null', 'loadstart[0,0,false]@1/0|null'];
  const uploaded = [`upload.loadstart[0,${up},true]`, `upload.progress[${up},${up},true]`, `upload.load[${up},${up},true]`, `upload.loadend[${up},${up},true]`];
  const failed = ['readystatechange@4/0|null', 'abort[0,0,false]@4/0|null', 'loadend[0,0,false]@4/0|null'];
  const uploadFailed = ['upload.abort[0,0,false]', 'upload.loadend[0,0,false]'];
  const abort = (xhr) => xhr.abort();
  const reopen = (xhr) => xhr.open('POST', '/ajax/plain');

  assert.deepEqual((await run({ act: abort })).trace, [
    ...opened, `upload.loadstart[0,${up},true]`, failed[0], ...uploadFailed, ...failed.slice(1), 'end@0/0|null',
  ], 'aborted at once, the upload fails too');

  const atStart = [...opened, failed[0], ...uploadFailed, ...failed.slice(1), 'end@0/0|null'];
  assert.deepEqual((await run({ on: 'loadstart', act: abort })).trace, atStart, 'aborted in loadstart, the upload never starts');
  const heldAbort = await run({ state: 'loading', switchOn: false, on: 'loadstart', act: abort, then: (control) => control.set('ready') });
  assert.deepEqual(heldAbort.trace, atStart, 'the same while held for saved choices');
  assert.equal(heldAbort.xhrCalls.length, 0, 'and it never goes out once they load with its switch off');
  assert.deepEqual((await run({ on: 'loadstart', act: reopen })).trace, [...opened, 'end@1/0|null'], 'reopened in loadstart, nothing more of it runs');

  assert.deepEqual((await run({ on: 'readystatechange', at: 2, act: abort })).trace, [
    ...opened, ...uploaded, `readystatechange@2/200|${answer}`, ...failed, 'end@0/0|null',
  ], 'aborted once the upload is done, only the request fails, and its header goes');
  assert.deepEqual((await run({ on: 'readystatechange', at: 3, act: reopen })).trace, [
    ...opened, ...uploaded, `readystatechange@2/200|${answer}`, `readystatechange@3/200|${answer}`,
    'readystatechange@1/0|null', 'progress[0,0,false]@1/0|null', 'end@1/0|null',
  ], 'reopened at LOADING, its progress still fires, with nothing received');
  assert.deepEqual((await run({ on: 'readystatechange', at: 3, act: abort })).trace, [
    ...opened, ...uploaded, `readystatechange@2/200|${answer}`, `readystatechange@3/200|${answer}`,
    ...failed, 'progress[0,0,false]@0/0|null', 'end@0/0|null',
  ], 'aborted at LOADING, the same');

  const form = new FormData();
  form.append('fb_api_req_friendly_name', 'PrivateMutation');
  for (const [label, options] of [['a GET', { method: 'GET' }], ['a form', { payload: form }]]) {
    const { trace } = await run(options);
    assert.deepEqual(trace.filter((line) => /^(upload\.|loadstart|end)/.test(line)), ['loadstart[0,0,false]@1/0|null', `end@4/200|${answer}`], `${label} starts and finishes with no upload events`);
  }
});

test('an open() that throws leaves a held-back request as it was', async () => {
  const { win, xhrCalls } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog, startup: startupControl({ state: 'ready' }).startup });
  requestRule(net);
  const body = graphqlBody('PrivateMutation');
  const done = new win.XMLHttpRequest();
  const ended = new Promise((resolve) => done.addEventListener('loadend', resolve));
  done.open('POST', '/api/graphql/');
  done.send(body);
  await ended;
  assert.throws(() => done.open('BAD METHOD', '/ajax/plain'), (error) => error.name === 'SyntaxError');
  assert.deepEqual([done.readyState, done.status, done.responseText, done.getResponseHeader('content-type')], [4, 200, '{"held":true}', 'text/plain;charset=UTF-8']);

  const sent = new win.XMLHttpRequest();
  const loads = [];
  sent.addEventListener('load', () => loads.push(`${sent.readyState}/${sent.status}`));
  const finished = new Promise((resolve) => sent.addEventListener('loadend', resolve));
  sent.open('POST', '/api/graphql/');
  sent.send(body);
  assert.throws(() => sent.open('BAD METHOD', '/ajax/plain'), (error) => error.name === 'SyntaxError');
  await finished;
  assert.deepEqual(loads, ['4/200'], 'the request still finishes');
  assert.equal(xhrCalls.length, 0);
});

// Chromium runs a target's listeners in the order they were added, capture or not, and so does
// Node, so the page here listens before open() as a page in Chromium can.
test('a request held for saved choices starts once, even when the page listened before open', () => {
  const control = startupControl();
  const { win, xhrCalls } = fakeWindow();
  const net = installNetworkHooks({ win, log: quietLog, startup: control.startup });
  requestRule(net, () => false);
  const xhr = new win.XMLHttpRequest();
  const starts = [];
  xhr.addEventListener('loadstart', () => starts.push(`xhr@${xhr.readyState}`));
  xhr.upload.addEventListener('loadstart', () => starts.push('upload'));
  xhr.open('POST', '/api/graphql/');
  xhr.send(graphqlBody('PrivateMutation'));
  const form = new FormData();
  form.append('fb_api_req_friendly_name', 'PrivateMutation');
  const formXhr = new win.XMLHttpRequest();
  const formStarts = [];
  formXhr.addEventListener('loadstart', () => formStarts.push('xhr'));
  formXhr.upload.addEventListener('loadstart', () => formStarts.push('upload'));
  formXhr.open('POST', '/api/graphql/');
  formXhr.send(form);
  assert.deepEqual(starts, ['xhr@1', 'upload'], 'the page sees the request start when it sends');
  assert.deepEqual(formStarts, ['xhr'], "a form's upload size isn't known until the browser sends it");
  control.set('ready');
  assert.equal(xhrCalls.length, 2, 'then they go out for real');
  assert.deepEqual([xhr.readyState, xhr.status], [4, 204], 'showing what the browser has');
  assert.deepEqual(starts, ['xhr@1', 'upload'], "the browser's own start is kept from the page");
  assert.deepEqual(formStarts, ['xhr', 'upload'], "and the form's upload starts when the browser sends it");
  xhr.open('POST', '/ajax/plain');
  xhr.send('x');
  assert.deepEqual(starts, ['xhr@1', 'upload', 'xhr@1', 'upload'], 'a later request starts as usual');
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
