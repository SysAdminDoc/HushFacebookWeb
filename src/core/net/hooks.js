// Wraps fetch, XMLHttpRequest and sendBeacon in Facebook's window so features can drop
// requests (story seen, telemetry) and prune responses (ads, suggestions). The chat socket's
// send is wrapped too (websocket.js), for read receipts and typing.
// JSON.parse is wrapped too: the first screen of the feed arrives inline in the HTML as
// <script type="application/json" data-sjs> blocks, never through fetch or XHR.
//
// A failing rule is logged once and skipped. Facebook always gets a response.

import { createLineStream, friendlyNameOf, rulesFor, transformDocumentLine } from './payload.js';
import { patchWebSocket } from './websocket.js';

const INSTALLED = Symbol.for('hushfacebook-web.net');
const INLINE_JSON = Object.freeze({ transport: 'json-parse', method: '', url: '', host: '', path: '', friendlyName: '' });
const STARTUP_WAIT_MS = 16000;
const STARTUP_MAX_PENDING = 32;
const STARTUP_MAX_BYTES = 256 * 1024;

export function describeRequest({ url, method = 'GET', body, headers, transport, base }) {
  let parsed;
  try {
    parsed = new URL(String(url), base);
  } catch {
    parsed = null;
  }
  return {
    transport,
    method: String(method).toUpperCase(),
    url: parsed?.href ?? String(url),
    host: parsed?.hostname ?? '',
    path: parsed?.pathname ?? '',
    friendlyName: friendlyNameOf(body, headers),
    body,
  };
}

function bodyBytes(body) {
  if (body === undefined || body === null) return 0;
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  const tag = Object.prototype.toString.call(body);
  if (tag === '[object URLSearchParams]') return new TextEncoder().encode(String(body)).byteLength;
  if (tag === '[object ArrayBuffer]') return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (tag === '[object Blob]' || tag === '[object File]') return body.size;
  if (tag !== '[object FormData]' || typeof body.entries !== 'function') return null;
  // This deliberately overcounts multipart syntax. Browsers choose their own boundary and
  // escape field metadata, so payload bytes alone are not a safe retention bound.
  let bytes = 1024;
  for (const [name, value] of body.entries()) {
    const size = typeof value === 'string'
      ? new TextEncoder().encode(value).byteLength
      : Number.isFinite(value?.size) ? value.size : null;
    if (size === null) return null;
    const filename = typeof value === 'string' ? '' : String(value?.name ?? 'blob');
    const type = typeof value === 'string' ? '' : String(value?.type ?? '');
    bytes += 1024 + size
      + new TextEncoder().encode(String(name)).byteLength * 3
      + new TextEncoder().encode(filename).byteLength * 3
      + new TextEncoder().encode(type).byteLength;
  }
  return bytes;
}

function snapshotXhrBody(body) {
  const tag = Object.prototype.toString.call(body);
  if (tag === '[object URLSearchParams]') return new body.constructor(String(body));
  if (tag === '[object ArrayBuffer]') return body.slice(0);
  if (ArrayBuffer.isView(body)) return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  if (tag !== '[object FormData]') return body;
  const copy = new body.constructor();
  for (const [name, value] of body.entries()) copy.append(name, value);
  return copy;
}

function abortReason(win, signal) {
  if (signal?.reason !== undefined) return signal.reason;
  if (typeof win.DOMException === 'function') return new win.DOMException('The operation was aborted.', 'AbortError');
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function createStartupGate(win, startup, log) {
  const waiting = new Set();
  const waitMs = startup?.waitMs ?? STARTUP_WAIT_MS;
  const maxPending = startup?.maxPending ?? STARTUP_MAX_PENDING;
  const maxBytes = startup?.maxBytes ?? STARTUP_MAX_BYTES;
  let retainedBytes = 0;
  let closed = false;
  let accountConfirmed = false;
  let statusErrorLogged = false;

  const state = () => {
    if (closed) return 'error';
    let phase = 'ready';
    try {
      const reported = startup?.status?.();
      const value = typeof reported === 'string' ? reported : reported?.state;
      if (value === 'loading' || value === 'error' || value === 'ready') phase = value;
      if (!accountConfirmed && startup?.accountMatches?.() === false) return 'error';
      if (phase === 'ready') accountConfirmed = true;
      return phase;
    } catch (error) {
      if (!statusErrorLogged) {
        statusErrorLogged = true;
        log?.error('Saved privacy choices could not be checked, so recognized requests are held back', error);
      }
      return 'error';
    }
  };

  const finish = (entry, outcome) => {
    if (!waiting.delete(entry)) return;
    retainedBytes -= entry.bytes;
    (win.clearTimeout ?? clearTimeout)(entry.timer);
    entry.signal?.removeEventListener?.('abort', entry.abort);
    if (outcome === 'ready') entry.onReady();
    else if (outcome === 'closed') entry.onClosed();
    else entry.onCancel?.();
  };
  const settle = () => {
    const phase = state();
    if (phase === 'loading') return;
    for (const entry of [...waiting]) finish(entry, phase === 'ready' ? 'ready' : 'closed');
  };

  let unsubscribe = () => {};
  try {
    unsubscribe = startup?.onStatus?.(settle) ?? unsubscribe;
  } catch (error) {
    log?.error('Saved privacy choice updates could not be watched, so recognized requests are held back', error);
    closed = true;
  }

  const close = () => {
    if (closed) return;
    closed = true;
    for (const entry of [...waiting]) finish(entry, 'closed');
    unsubscribe();
    win.removeEventListener?.('pagehide', onPageHide);
  };
  const onPageHide = (event) => {
    if (!event.persisted) close();
  };
  win.addEventListener?.('pagehide', onPageHide);

  return {
    state,
    defer({ bytes, signal, onReady, onClosed, onCancel }) {
      if (signal?.aborted) {
        onCancel?.();
        return null;
      }
      const phase = state();
      if (phase === 'ready') {
        onReady();
        return null;
      }
      if (
        phase === 'error'
        || bytes === null
        || bytes > maxBytes
        || waiting.size >= maxPending
        || retainedBytes + bytes > maxBytes
      ) {
        onClosed();
        return null;
      }
      const entry = { bytes, signal, onReady, onClosed, onCancel, timer: null, abort: null };
      entry.abort = () => finish(entry, 'cancel');
      entry.timer = (win.setTimeout ?? setTimeout)(() => finish(entry, 'closed'), waitMs);
      signal?.addEventListener?.('abort', entry.abort, { once: true });
      waiting.add(entry);
      retainedBytes += bytes;
      return { cancel: entry.abort };
    },
    close,
    pending: () => waiting.size,
  };
}

export function installNetworkHooks({ win, log, startup }) {
  if (win[INSTALLED]) return win[INSTALLED];

  const requestRules = [];
  const responseRules = [];
  const failed = new Set();

  const onError = (rule, error) => {
    if (failed.has(rule.id)) return;
    failed.add(rule.id);
    log.error(`Network rule "${rule.id}" failed, so Facebook got its original data`, error);
  };

  const matches = (rule, ctx) => {
    try {
      return rule.match(ctx);
    } catch (error) {
      onError(rule, error);
      return false;
    }
  };

  const active = (rules, ctx) =>
    rules.filter((rule) => {
      try {
        return rule.enabled() && matches(rule, ctx);
      } catch (error) {
        onError(rule, error);
        return false;
      }
    });

  const blockingRule = (ctx) => active(requestRules, ctx)[0];
  const startupRule = (ctx) => requestRules.find((rule) => rule.startupPrivacy === true && matches(rule, ctx));
  // The answer a held-back request gets. A rule that fails to make one is logged once and the
  // request stays held back, with an empty answer.
  const fakeAnswer = (rule, ctx) => {
    try {
      return rule.fakeResponse?.(ctx) ?? '{}';
    } catch (error) {
      if (!failed.has(rule.id)) {
        failed.add(rule.id);
        log.error(`Network rule "${rule.id}" couldn't make its answer, so the page got an empty one`, error);
      }
      return '{}';
    }
  };
  // Taken before patchJsonParse wraps it. See transformDocumentLine.
  const parse = win.JSON?.parse ?? JSON.parse;
  const handled = createHandledLines();
  const lineTransformer = (rules, ctx) => (line) => {
    const out = transformDocumentLine(line, rules, ctx, onError, parse);
    const ran = rulesFor(line, rules);
    if (out !== null && ran.length) handled.add(out, ran);
    return out;
  };

  const startupGate = createStartupGate(win, startup, log);
  patchFetch(win, { blockingRule, startupRule, startupGate, fakeAnswer, active, responseRules, lineTransformer, log });
  patchXhr(win, { blockingRule, startupRule, startupGate, fakeAnswer, active, responseRules, lineTransformer, log });
  patchBeacon(win, { blockingRule, startupRule, startupGate, fakeAnswer });
  patchJsonParse(win, { active, responseRules, onError, handled });
  const sockets = patchWebSocket(win, { log, startup: startupGate });

  const api = {
    // The chat socket: see websocket.js. chatStats counts what it sent and couldn't read.
    editChatRequests: sockets.editChatRequests,
    chatStats: sockets.stats,
    startupPending: startupGate.pending,
    startupState: startupGate.state,
    teardown: startupGate.close,
    // rule: { id, enabled(), match(ctx), fakeResponse?(ctx), startupPrivacy? }
    blockRequests(rule) {
      requestRules.push(rule);
    },
    // rule: { id, enabled(), match(ctx), markers?: string[], transform(doc, ctx) }
    // ctx.transport is 'fetch', 'xhr' or 'json-parse' (inline page data).
    transformResponses(rule) {
      responseRules.push(rule);
    },
  };
  Object.defineProperty(win, INSTALLED, { value: api });
  return api;
}

function patchFetch(win, { blockingRule, startupRule, startupGate, fakeAnswer, active, responseRules, lineTransformer, log }) {
  const original = win.fetch;
  if (typeof original !== 'function') return;

  win.fetch = function fetch(input, init) {
    const receiver = this;
    const isRequest = typeof win.Request === 'function' && input instanceof win.Request;
    const ctx = describeRequest({
      transport: 'fetch',
      url: isRequest ? input.url : input,
      method: init?.method ?? (isRequest ? input.method : 'GET'),
      body: init?.body,
      headers: init?.headers ?? (isRequest ? input.headers : undefined),
      base: win.location.href,
    });

    if (startupGate.state() === 'ready') {
      return sendFetch(win, { original, receiver, args: arguments, ctx, blockingRule, fakeAnswer, active, responseRules, lineTransformer, log });
    }
    const pending = startupRule(ctx);
    if (!pending) {
      return sendFetch(win, { original, receiver, args: arguments, ctx, blockingRule, fakeAnswer, active, responseRules, lineTransformer, log });
    }
    const queuedBody = init && Object.hasOwn(init, 'body') ? init.body : isRequest && input.body ? input.body : undefined;
    const bytes = bodyBytes(queuedBody);
    let request = null;
    if (bytes !== null && typeof win.Request === 'function') {
      try {
        request = new win.Request(isRequest ? input : ctx.url, init);
      } catch (error) {
        return win.Promise.reject(error);
      }
    }
    const signal = request?.signal ?? init?.signal ?? (isRequest ? input.signal : null);
    const deferredCtx = { ...ctx, body: undefined };
    if (!request) {
      if (signal?.aborted) return win.Promise.reject(abortReason(win, signal));
      return win.Promise.resolve(new win.Response(fakeAnswer(pending, deferredCtx), { status: 200 }));
    }
    return deferFetch(win, {
      original, receiver, request, bytes, signal, ctx: deferredCtx, pending,
      startupGate, blockingRule, fakeAnswer, active, responseRules, lineTransformer, log,
    });
  };
}

function sendFetch(win, { original, receiver, args, ctx, blockingRule, fakeAnswer, active, responseRules, lineTransformer, log }) {
  const blocker = blockingRule(ctx);
  if (blocker) return win.Promise.resolve(new win.Response(fakeAnswer(blocker, ctx), { status: 200 }));

  const promise = original.apply(receiver, args);
  const rules = active(responseRules, ctx);
  if (!rules.length) return promise;
  return promise.then((response) => {
    try {
      return rewriteFetchResponse(win, response, lineTransformer(rules, ctx));
    } catch (error) {
      log.error("Couldn't rewrite a fetch response, so it went through unchanged", error);
      return response;
    }
  });
}

function deferFetch(win, options) {
  const {
    original, receiver, request, bytes, signal, ctx, pending,
    startupGate, blockingRule, fakeAnswer, active, responseRules, lineTransformer, log,
  } = options;
  const fake = (rule) => new win.Response(fakeAnswer(rule, ctx), { status: 200 });
  return new win.Promise((resolve, reject) => {
    startupGate.defer({
      bytes,
      signal,
      onReady: () => {
        try {
          resolve(sendFetch(win, {
            original, receiver, args: [request], ctx, blockingRule, fakeAnswer,
            active, responseRules, lineTransformer, log,
          }));
        } catch (error) {
          reject(error);
        }
      },
      onClosed: () => resolve(fake(pending)),
      onCancel: () => reject(abortReason(win, signal)),
    });
  });
}

function rewriteFetchResponse(win, response, transformLine) {
  if (!response.body || response.type === 'opaque') return response;
  const reader = response.body.getReader();
  const stream = createLineStream(transformLine);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // pull() must enqueue or close before it returns: the stream doesn't call it again after a
  // pull that produced nothing, so a chunk that finishes no line (or only a dropped one)
  // would stall the body forever. Keep reading until there's output or the source ends.
  const body = new win.ReadableStream({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        const text = done ? stream.push(decoder.decode()) + stream.flush() : stream.push(decoder.decode(value, { stream: true }));
        if (text) controller.enqueue(encoder.encode(text));
        if (done) {
          controller.close();
          return;
        }
        if (text) return;
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });

  const headers = new win.Headers(response.headers);
  headers.delete('content-length');
  const rewritten = new win.Response(body, { status: response.status, statusText: response.statusText, headers });
  Object.defineProperty(rewritten, 'url', { value: response.url });
  return rewritten;
}

function patchXhr(win, { blockingRule, startupRule, startupGate, fakeAnswer, active, responseRules, lineTransformer, log }) {
  const Xhr = win.XMLHttpRequest;
  if (typeof Xhr !== 'function') return;
  const proto = Xhr.prototype;
  const { open, send, setRequestHeader, abort } = proto;
  const textGetter = Object.getOwnPropertyDescriptor(proto, 'responseText').get;
  const responseGetter = Object.getOwnPropertyDescriptor(proto, 'response').get;
  const state = new WeakMap();

  proto.open = function (method, url, async = true) {
    const previous = state.get(this);
    previous?.deferred?.cancel();
    previous?.fakeCleanup?.();
    state.set(this, { method, url, async: Boolean(async), headers: {}, deferred: null, fakeCleanup: null, sent: false });
    return open.apply(this, arguments);
  };

  proto.setRequestHeader = function (name, value) {
    const entry = state.get(this);
    if (entry) entry.headers[String(name).toLowerCase()] = value;
    return setRequestHeader.apply(this, arguments);
  };

  proto.send = function (body) {
    const entry = state.get(this);
    if (!entry) return send.apply(this, arguments);
    if (entry.sent) {
      const error = typeof win.DOMException === 'function'
        ? new win.DOMException("Failed to execute 'send': the request has already been sent.", 'InvalidStateError')
        : Object.assign(new Error("Failed to execute 'send': the request has already been sent."), { name: 'InvalidStateError' });
      throw error;
    }
    entry.sent = true;
    const ctx = describeRequest({ transport: 'xhr', url: entry.url, method: entry.method, body, headers: entry.headers, base: win.location.href });
    const xhr = this;
    const fakeSuccess = (text, synchronous = false) => {
      entry.fakeCleanup?.();
      entry.fakeCleanup = fakeXhrSuccess(win, xhr, ctx, text, synchronous);
    };

    const sendRequest = (requestBody) => {
      const blocker = blockingRule(ctx);
      if (blocker) return fakeSuccess(fakeAnswer(blocker, ctx), !entry.async);

      const rules = active(responseRules, ctx);
      if (rules.length) attachTextTransform(xhr, lineTransformer(rules, ctx), textGetter, responseGetter);
      return send.call(xhr, requestBody);
    };

    if (startupGate.state() === 'ready') return sendRequest(body);
    const pending = startupRule(ctx);
    if (!pending) return sendRequest(body);
    if (!entry.async) return fakeSuccess(fakeAnswer(pending, ctx), true);
    const bytes = bodyBytes(body);
    const queuedBody = bytes === null ? body : snapshotXhrBody(body);
    ctx.body = undefined;

    const resume = () => {
      if (state.get(xhr) !== entry) return;
      entry.deferred = null;
      try {
        sendRequest(queuedBody);
      } catch (error) {
        log.error("A privacy request couldn't resume after saved settings loaded, so it stayed held back", error);
        fakeSuccess(fakeAnswer(pending, ctx));
      }
    };
    const hold = () => {
      if (state.get(xhr) !== entry) return;
      entry.deferred = null;
      fakeSuccess(fakeAnswer(pending, ctx));
    };
    entry.deferred = startupGate.defer({
      bytes,
      onReady: resume,
      onClosed: hold,
      onCancel: () => {},
    });
    return undefined;
  };

  if (typeof abort === 'function') {
    proto.abort = function () {
      const entry = state.get(this);
      entry?.deferred?.cancel();
      entry?.fakeCleanup?.();
      if (entry) {
        entry.deferred = null;
        entry.fakeCleanup = null;
      }
      return abort.apply(this, arguments);
    };
  }
}

// Facebook reads responseText while the body is still arriving. Each read returns the
// transformed text of every complete line so far, which only ever grows.
function attachTextTransform(xhr, transformLine, textGetter, responseGetter) {
  const stream = createLineStream(transformLine);
  let seen = 0;
  let output = '';
  let flushed = false;

  const read = () => {
    const raw = textGetter.call(xhr);
    if (raw.length > seen) {
      output += stream.push(raw.slice(seen));
      seen = raw.length;
    }
    if (xhr.readyState === 4 && !flushed) {
      output += stream.flush();
      flushed = true;
    }
    return output;
  };

  Object.defineProperty(xhr, 'responseText', { configurable: true, get: read });
  Object.defineProperty(xhr, 'response', {
    configurable: true,
    get: () => (xhr.responseType === '' || xhr.responseType === 'text' ? read() : responseGetter.call(xhr)),
  });
}

function fakeXhrSuccess(win, xhr, ctx, text, synchronous = false) {
  const values = { readyState: 4, status: 200, statusText: 'OK', responseText: text, response: text, responseURL: ctx.url };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(xhr, key, { configurable: true, value });
  let active = true;
  let timer = null;
  const complete = () => {
    if (!active) return;
    xhr.dispatchEvent(new win.Event('readystatechange'));
    xhr.dispatchEvent(new win.ProgressEvent('load'));
    xhr.dispatchEvent(new win.ProgressEvent('loadend'));
  };
  if (synchronous) complete();
  else timer = win.setTimeout(complete, 0);
  return () => {
    if (!active) return;
    active = false;
    if (timer !== null) win.clearTimeout(timer);
    for (const key of Object.keys(values)) delete xhr[key];
  };
}

// Facebook calls JSON.parse constantly, so the marker check (a substring search) runs
// before anything else and most calls return untouched.
function patchJsonParse(win, { active, responseRules, onError, handled }) {
  const json = win.JSON;
  const parse = json?.parse;
  if (typeof parse !== 'function') return;
  json.parse = function (text) {
    const result = parse.apply(this, arguments);
    if (typeof text !== 'string' || result === null || typeof result !== 'object') return result;
    let candidates = rulesFor(text, responseRules);
    if (!candidates.length) return result;
    // A line of a fetch or XHR answer already went through the rules that were on for it,
    // judged by its query.
    const done = handled?.get(text);
    if (done) candidates = candidates.filter((rule) => !done.has(rule));
    for (const rule of active(candidates, INLINE_JSON)) {
      try {
        rule.transform(result, INLINE_JSON);
      } catch (error) {
        onError(rule, error);
      }
    }
    return result;
  };
}

// The last lines of fetch and XHR answers that rules looked at, with the rules that did.
// Facebook parses GraphQL answers with JSON.parse, and without this the JSON.parse pass would
// judge them a second time as inline page data, by the page you're on instead of by the
// query they answer. A rule that was off for the request still gets its turn there.
//
// Feed lines can run to megabytes, so each is remembered by a short stand-in: its length, its
// two ends and characters sampled along it. Facebook strips the for (;;); guard and may
// leave whitespace around a line before it parses it, so neither counts.
const GUARD = 'for (;;);';
const SAMPLES = 64;
const ENDS = 160;

export function lineKey(line) {
  let text = line.trim();
  if (text.startsWith(GUARD)) text = text.slice(GUARD.length).trimStart();
  const n = text.length;
  if (n <= 2 * ENDS + SAMPLES) return text;
  let sample = '';
  for (let i = 1; i < SAMPLES; i++) sample += text[Math.floor((i * n) / SAMPLES)];
  return `${n}:${text.slice(0, ENDS)}${sample}${text.slice(-ENDS)}`;
}

export function createHandledLines(limit = 64) {
  const lines = new Map(); // key -> Set of rules
  return {
    add(line, rules = []) {
      const key = lineKey(line);
      const done = lines.get(key) ?? new Set();
      for (const rule of rules) done.add(rule);
      lines.delete(key);
      lines.set(key, done);
      if (lines.size > limit) lines.delete(lines.keys().next().value);
    },
    // The rules that already looked at this line, or undefined.
    get: (line) => lines.get(lineKey(line)),
    has: (line) => lines.has(lineKey(line)),
  };
}

function patchBeacon(win, { blockingRule, startupRule, startupGate, fakeAnswer }) {
  const nav = win.navigator;
  const original = nav?.sendBeacon;
  if (typeof original !== 'function') return;
  nav.sendBeacon = function sendBeacon(url, data) {
    const ctx = describeRequest({ transport: 'beacon', url, method: 'POST', body: data, base: win.location.href });
    const blocker = startupGate.state() === 'ready' ? blockingRule(ctx) : startupRule(ctx);
    if (blocker) {
      // A beacon gets no answer, but the rule still hears that it held one back.
      fakeAnswer(blocker, ctx);
      return true;
    }
    return original.apply(this, arguments);
  };
}
