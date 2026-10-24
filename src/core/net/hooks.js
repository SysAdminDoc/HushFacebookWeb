// Wraps fetch, XMLHttpRequest and sendBeacon in Facebook's window so features can drop
// requests (story seen, telemetry) and prune responses (ads, suggestions). The chat socket's
// send is wrapped too (websocket.js), for read receipts and typing.
// JSON.parse is wrapped too: the first screen of the feed arrives inline in the HTML as
// <script type="application/json" data-sjs> blocks, never through fetch or XHR.
//
// A failing rule is logged once, and the document it failed on reaches Facebook as it came, with
// none of the other rules' edits either. Facebook always gets a response.

import { FAILED, applyRules, createLineStream, friendlyNameOf, observeRules, rulesFor, transformDocumentLine } from './payload.js';
import { patchWebSocket } from './websocket.js';

const INSTALLED = Symbol.for('hushfacebook-web.net');
const INLINE_JSON = Object.freeze({ transport: 'json-parse', method: '', url: '', host: '', path: '', friendlyName: '' });
const STARTUP_WAIT_MS = 16000;
const STARTUP_MAX_PENDING = 32;
const STARTUP_MAX_BYTES = 256 * 1024;
const FORM_MAX_BYTES = 64 * 1024;
const FORM_WAIT_MS = 250;

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

// A Request from any window: one made in an iframe isn't an instance of this window's Request.
function isRequestInput(win, input) {
  if (typeof win.Request === 'function' && input instanceof win.Request) return true;
  return Object.prototype.toString.call(input) === '[object Request]' && typeof input.clone === 'function';
}

// A Request can carry its form alone, with no body in init, so its operation name is only in the
// body. Only a url-encoded or multipart form is read, from a clone so the page's Request stays
// unread, and only while it stays under FORM_MAX_BYTES and FORM_WAIT_MS. Anything else (another
// type, a bigger or stalled body, an abort) goes out as it came: rules see its URL, method and
// headers but no operation name, so nothing keyed on the name runs or counts it.
function requestFormType(win, input, init) {
  if (input.bodyUsed || (init && Object.hasOwn(init, 'body'))) return '';
  if (['GET', 'HEAD'].includes(String(init?.method ?? input.method).toUpperCase())) return '';
  let type;
  try {
    type = init && Object.hasOwn(init, 'headers') ? new win.Headers(init.headers).get('content-type') : input.headers.get('content-type');
  } catch {
    return '';
  }
  const kind = String(type ?? '').toLowerCase();
  return kind.startsWith('application/x-www-form-urlencoded') || kind.startsWith('multipart/form-data') ? type : '';
}

// Resolves { body, bytes } with the form, or null when it can't be read in time. Never rejects.
function readRequestForm(win, request, type, signal) {
  return new Promise((resolve) => {
    let reader = null;
    let settled = false;
    const finish = (form) => {
      if (settled) return;
      settled = true;
      (win.clearTimeout ?? clearTimeout)(timer);
      signal?.removeEventListener?.('abort', stop);
      if (!form) reader?.cancel().catch(() => {});
      resolve(form);
    };
    const stop = () => finish(null);
    const timer = (win.setTimeout ?? setTimeout)(stop, FORM_WAIT_MS);
    if (signal?.aborted) return stop();
    signal?.addEventListener?.('abort', stop, { once: true });
    let copy;
    try {
      copy = request.clone();
    } catch {
      return stop();
    }
    const chunks = [];
    let bytes = 0;
    const parse = async () => {
      const all = new Uint8Array(bytes);
      let at = 0;
      for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.byteLength;
      }
      const body = type.toLowerCase().startsWith('multipart/form-data')
        ? await new win.Response(all, { headers: { 'content-type': type } }).formData()
        : new URLSearchParams(new TextDecoder().decode(all));
      finish({ body, bytes });
    };
    // Firefox has no Request.body, and its request bodies are never streams, so there a Blob gives
    // the size before anything is read.
    if (!copy.body) {
      copy.blob().then((blob) => {
        if (settled) return undefined;
        if (blob.size > FORM_MAX_BYTES) return stop();
        return blob.arrayBuffer().then((buffer) => {
          chunks.push(new Uint8Array(buffer));
          bytes = buffer.byteLength;
          return parse();
        });
      }).catch(stop);
      return undefined;
    }
    reader = copy.body.getReader();
    const pump = () => reader.read().then(({ done, value }) => {
      if (settled) return undefined;
      if (done) return parse();
      bytes += value.byteLength;
      if (bytes > FORM_MAX_BYTES) return stop();
      chunks.push(value);
      return pump();
    });
    pump().catch(stop);
  });
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

  let disposed = false;
  const close = () => {
    if (disposed) return;
    disposed = true;
    closed = true;
    for (const entry of [...waiting]) finish(entry, 'closed');
    try {
      unsubscribe();
    } finally {
      win.removeEventListener?.('pagehide', onPageHide);
    }
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
  // Lines too long to read as they arrived (see LINE_LIMIT). They reach the page unread here,
  // and only the page's own JSON.parse of them, judged as inline data, may still edit them.
  const lineStats = { oversized: 0 };
  const lineStream = (rules, ctx) => createLineStream((line) => {
    const out = transformDocumentLine(line, rules, ctx, onError, parse);
    const ran = rulesFor(line, rules);
    // A line that failed counts as handled for all of them too, so the page's own JSON.parse of it
    // doesn't run the rest without the one that failed.
    if (out !== null && ran.length) handled.add(out, ran);
    return out;
  }, {
    onBypass: () => {
      if (!lineStats.oversized++) log.warn("A Facebook answer was too long to filter as it arrived, so it went through as sent. Diagnostics counts them.", ctx.friendlyName || ctx.transport);
    },
  });

  const startupGate = createStartupGate(win, startup, log);
  const patch = installationPatches();
  let sockets;
  try {
    patchFetch(win, { blockingRule, startupRule, startupGate, fakeAnswer, active, responseRules, lineStream, log, patch });
    patchXhr(win, { blockingRule, startupRule, startupGate, fakeAnswer, active, responseRules, lineStream, log, patch });
    patchBeacon(win, { blockingRule, startupRule, startupGate, fakeAnswer, patch });
    patchJsonParse(win, { active, responseRules, onError, handled, patch });
    sockets = patchWebSocket(win, { log, startup: startupGate, replace: patch.set });
  } catch (error) {
    try { startupGate.close(); } finally { patch.rollback(); }
    throw error;
  }

  const api = {
    // The chat socket: see websocket.js. chatStats counts what it sent and couldn't read.
    editChatRequests: sockets.editChatRequests,
    chatStats: sockets.stats,
    lineStats,
    startupPending: startupGate.pending,
    startupState: startupGate.state,
    teardown: startupGate.close,
    // rule: { id, enabled(), match(ctx), fakeResponse?(ctx), startupPrivacy? }
    blockRequests(rule) {
      requestRules.push(rule);
    },
    // rule: { id, enabled(), match(ctx), markers?: string[], observe?, transform(doc, ctx, stage) }
    // ctx.transport is 'fetch', 'xhr' or 'json-parse' (inline page data). Anything a transform
    // keeps past the document goes through stage (see applyRules), so a document that fails
    // leaves no trace. An observe rule only reads, after the others, the data the page gets.
    transformResponses(rule) {
      responseRules.push(rule);
    },
  };
  try {
    patch.define(win, INSTALLED, { value: api });
  } catch (error) {
    try { startupGate.close(); } finally { patch.rollback(); }
    throw error;
  }
  return api;
}

// Every installation write records its own descriptor. If a later hook is refused, restore
// these writes in reverse order, leaving inherited properties and earlier wrappers intact.
function installationPatches() {
  const writes = [];
  const define = (object, key, descriptor) => {
    const previous = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { ...descriptor, configurable: previous?.configurable === false ? false : true });
    writes.push({ object, key, previous, installed: Object.getOwnPropertyDescriptor(object, key) });
  };
  return {
    define,
    set(object, key, value) {
      const current = Object.getOwnPropertyDescriptor(object, key);
      define(object, key, {
        configurable: current?.configurable ?? true,
        enumerable: current?.enumerable ?? true,
        writable: current && 'writable' in current ? current.writable : true,
        value,
      });
    },
    rollback() {
      for (const { object, key, previous, installed } of writes.reverse()) {
        const current = Object.getOwnPropertyDescriptor(object, key);
        if (current?.value !== installed.value || current?.get !== installed.get || current?.set !== installed.set) continue;
        if (previous) Object.defineProperty(object, key, previous);
        else Reflect.deleteProperty(object, key);
      }
    },
  };
}

function patchFetch(win, { blockingRule, startupRule, startupGate, fakeAnswer, active, responseRules, lineStream, log, patch }) {
  const original = win.fetch;
  if (typeof original !== 'function') return;

  patch.set(win, 'fetch', function fetch(input, init) {
    const receiver = this;
    const args = arguments;
    const isRequest = isRequestInput(win, input);
    const ctx = describeRequest({
      transport: 'fetch',
      url: isRequest ? input.url : input,
      method: init?.method ?? (isRequest ? input.method : 'GET'),
      body: init?.body,
      headers: init?.headers ?? (isRequest ? input.headers : undefined),
      base: win.location.href,
    });
    const route = (form) => routeFetch(win, {
      input, init, isRequest, form, startupRule, startupGate,
      original, receiver, args, ctx, blockingRule, fakeAnswer, active, responseRules, lineStream, log,
    });
    const formType = isRequest && !ctx.friendlyName ? requestFormType(win, input, init) : '';
    if (!formType) return route(null);
    return new win.Promise((resolve, reject) => {
      readRequestForm(win, input, formType, init?.signal ?? input.signal).then((form) => {
        if (form) {
          ctx.body = form.body;
          ctx.friendlyName = friendlyNameOf(form.body);
        }
        try {
          resolve(route(form));
        } catch (error) {
          reject(error);
        }
      });
    });
  });
}

// send: what sendFetch takes. A recognized privacy fetch made before the saved choices are in
// waits for them, or gets a held-back answer when it can't wait.
function routeFetch(win, { input, init, isRequest, form, startupRule, startupGate, ...send }) {
  const { ctx } = send;
  if (startupGate.state() === 'ready') return sendFetch(win, send);
  const pending = startupRule(ctx);
  if (!pending) return sendFetch(win, send);
  const queuedBody = init && Object.hasOwn(init, 'body') ? init.body : isRequest && input.body ? input.body : undefined;
  // A form read off a Request has a known size, so it can wait like any other body.
  const bytes = form ? form.bytes : bodyBytes(queuedBody);
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
    return win.Promise.resolve(new win.Response(send.fakeAnswer(pending, deferredCtx), { status: 200 }));
  }
  return deferFetch(win, { ...send, request, bytes, signal, ctx: deferredCtx, pending, startupGate });
}

function sendFetch(win, { original, receiver, args, ctx, blockingRule, fakeAnswer, active, responseRules, lineStream, log }) {
  const blocker = blockingRule(ctx);
  if (blocker) return win.Promise.resolve(new win.Response(fakeAnswer(blocker, ctx), { status: 200 }));

  const promise = original.apply(receiver, args);
  const rules = active(responseRules, ctx);
  if (!rules.length) return promise;
  return promise.then((response) => {
    try {
      return rewriteFetchResponse(win, response, lineStream(rules, ctx));
    } catch (error) {
      log.error("Couldn't rewrite a fetch response, so it went through unchanged", error);
      return response;
    }
  });
}

function deferFetch(win, options) {
  const {
    original, receiver, request, bytes, signal, ctx, pending,
    startupGate, blockingRule, fakeAnswer, active, responseRules, lineStream, log,
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
            active, responseRules, lineStream, log,
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

function rewriteFetchResponse(win, response, stream) {
  if (!response.body || response.type === 'opaque') return response;
  const reader = response.body.getReader();
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
  return keepResponseFacts(win, rewritten, { url: response.url, redirected: response.redirected, type: response.type });
}

// A Response built here would say it came from nowhere: no URL, no redirect, type "default". It
// keeps the original's instead, and so does every clone made of it.
function keepResponseFacts(win, response, facts) {
  const nativeClone = win.Response.prototype.clone;
  for (const [key, value] of Object.entries(facts)) Object.defineProperty(response, key, { value, configurable: true });
  Object.defineProperty(response, 'clone', {
    configurable: true,
    writable: true,
    value: function clone() {
      return keepResponseFacts(win, nativeClone.call(this), facts);
    },
  });
  return response;
}

// A held or answered XHR is measured against an unhooked one in Chromium and Firefox (an
// iframe's own XMLHttpRequest, answered by a server with the same text). Where the two engines
// differ, the hook does what the XHR spec says and one of them does:
//   Firefox fires load and loadend after a reopen inside DONE's readystatechange, still starts
//   the upload of a request reopened in its loadstart, and keeps responseURL, the Content-Type
//   header and even responseText after an abort.
//   Chromium keeps feeding the old body into a request reopened during HEADERS_RECEIVED.
// Two differences no script can close: its events are never isTrusted, and a microtask queued
// by one listener runs after the event's other listeners rather than between them.
function patchXhr(win, { blockingRule, startupRule, startupGate, fakeAnswer, active, responseRules, lineStream, log, patch }) {
  const Xhr = win.XMLHttpRequest;
  if (typeof Xhr !== 'function') return;
  const proto = Xhr.prototype;
  const { open, send, setRequestHeader, abort, getResponseHeader, getAllResponseHeaders, overrideMimeType } = proto;
  const textGetter = descriptorOf(proto, 'responseText')?.get;
  const responseGetter = descriptorOf(proto, 'response')?.get;
  if (typeof textGetter !== 'function' || typeof responseGetter !== 'function') throw new TypeError('XMLHttpRequest response accessors are unavailable');
  // Taken before patchJsonParse wraps it: the browser's json responseType doesn't go
  // through the page's JSON.parse either.
  const json = win.JSON ?? JSON;
  const jsonParse = json.parse;
  const parse = (text) => jsonParse.call(json, text);
  const state = new WeakMap();
  const overrides = xhrOverrides();
  // The XHRs and uploads whose browser loadstart is kept from the page, for sendQuietly.
  const quiet = new WeakSet();
  const hush = (event) => {
    if (quiet.has(event.currentTarget)) event.stopImmediatePropagation();
  };
  const hushXhr = listenFirst(win, proto, Xhr, 'loadstart', hush, patch);
  listenFirst(win, win.XMLHttpRequestUpload?.prototype, win.XMLHttpRequestUpload, 'loadstart', hush, patch);
  const synthetic = (xhr) => state.get(xhr)?.synthetic === true;
  const inFlight = (entry) => Boolean(entry?.deferred || entry?.fake?.pending);

  // Ends what this hook started for a request: a held send or a synthetic completion still to run.
  const stop = (entry) => {
    if (!entry) return;
    entry.deferred?.cancel();
    entry.deferred = null;
    entry.fake?.cancel();
    entry.fake = null;
  };

  patch.set(proto, 'open', function (method, url) {
    const shown = this.readyState;
    const previous = state.get(this);
    const released = overrides.release(this);
    // A held or answered request never left the browser's OPENED state, and open() only
    // announces OPENED when the state changes, so the page's DONE or UNSENT request would
    // reopen without the readystatechange a real one fires.
    const silent = shown !== 1 && this.readyState === 1;
    // An explicit async argument counts even when it's undefined, as in the browser.
    const entry = {
      method, url, async: arguments.length < 3 || Boolean(arguments[2]), headers: {},
      deferred: null, fake: null, sent: false, synthetic: false, uploading: false,
    };
    state.set(this, entry);
    let result;
    try {
      result = open.apply(this, arguments);
    } catch (error) {
      // An open() that throws changes nothing, so the last request carries on as it was.
      if (state.get(this) === entry) {
        if (previous) state.set(this, previous);
        else state.delete(this);
        overrides.restore(this, released);
      }
      throw error;
    }
    stop(previous);
    hushXhr(this);
    if (silent) this.dispatchEvent(new win.Event('readystatechange'));
    return result;
  });

  // A held or answered request was sent as far as the page knows, so whatever a sent, finished
  // or aborted request refuses, it refuses too, before the browser (which still has it OPENED)
  // can allow it. Calls missing arguments go to the browser for its own TypeError.
  const refuse = (name) => invalidState(win, `Failed to execute '${name}' on 'XMLHttpRequest': The object's state must be OPENED.`);
  patch.set(proto, 'setRequestHeader', function (name, value) {
    const entry = state.get(this);
    if (entry?.synthetic && arguments.length >= 2) throw refuse('setRequestHeader');
    if (entry) entry.headers[String(name).toLowerCase()] = value;
    return setRequestHeader.apply(this, arguments);
  });
  const loadingOrDone = (xhr) => synthetic(xhr) && xhr.readyState >= 3;
  if (typeof overrideMimeType === 'function') {
    patch.set(proto, 'overrideMimeType', function () {
      if (loadingOrDone(this) && arguments.length >= 1) throw refuse('overrideMimeType');
      return overrideMimeType.apply(this, arguments);
    });
  }
  guardSetter(proto, 'responseType', (xhr) => {
    if (loadingOrDone(xhr)) throw invalidState(win, "Failed to set the 'responseType' property on 'XMLHttpRequest': The response type cannot be set if the object's state is LOADING or DONE.");
  }, patch);
  guardSetter(proto, 'withCredentials', (xhr) => {
    if (synthetic(xhr) && xhr.readyState !== 0) throw invalidState(win, "Failed to set the 'withCredentials' property on 'XMLHttpRequest': The value may only be set if the object's state is UNSENT or OPENED.");
  }, patch);

  // From HEADERS_RECEIVED on, an answered request shows the one header its answer has. Before
  // that, and once aborted, its status is 0.
  const answered = (xhr) => synthetic(xhr) && xhr.status !== 0;
  if (typeof getResponseHeader === 'function') {
    patch.set(proto, 'getResponseHeader', function (name) {
      const value = getResponseHeader.apply(this, arguments);
      if (!synthetic(this)) return value;
      return answered(this) && String(name).toLowerCase() === 'content-type' ? ANSWER_TYPE : null;
    });
  }
  if (typeof getAllResponseHeaders === 'function') {
    patch.set(proto, 'getAllResponseHeaders', function () {
      const value = getAllResponseHeaders.apply(this, arguments);
      if (!synthetic(this)) return value;
      return answered(this) ? `content-type: ${ANSWER_TYPE}\r\n` : '';
    });
  }

  // The send that follows a hold: the page saw this request start when it called send(), so
  // the browser's own loadstart is kept from it, and the upload's too when the page saw that one
  // start (a FormData upload's size wasn't known then, so its start comes from the browser).
  const sendQuietly = (xhr, body, uploadStarted) => {
    const upload = uploadStarted ? xhr.upload : null;
    quiet.add(xhr);
    if (upload) quiet.add(upload);
    try {
      return send.call(xhr, body);
    } finally {
      quiet.delete(xhr);
      if (upload) quiet.delete(upload);
    }
  };

  patch.set(proto, 'send', function (body) {
    const entry = state.get(this);
    if (!entry) return send.apply(this, arguments);
    if (entry.sent) throw invalidState(win, "Failed to execute 'send' on 'XMLHttpRequest': The object's state must be OPENED.");
    entry.sent = true;
    const ctx = describeRequest({ transport: 'xhr', url: entry.url, method: entry.method, body, headers: entry.headers, base: win.location.href });
    const xhr = this;
    const upload = entry.async ? uploadSize(entry.method, body) : null;
    const live = () => state.get(xhr) === entry && Boolean(entry.fake || entry.deferred);
    // A request the browser never sends starts the way a real one does before send() returns:
    // loadstart, then the upload's. A handler there that aborts or reopens ends it.
    const announce = () => {
      entry.uploading = upload !== null;
      // Sent, as far as the page knows. Firefox only refuses responseText for a json or other
      // typed request once it's sent, and the browser still has this one unsent.
      overrides.define(xhr, xhrResult(win, xhr, { readyState: 1, status: 0, statusText: '', url: '', text: null }));
      xhr.dispatchEvent(progressEvent(win, 'loadstart'));
      if (entry.uploading && live()) xhr.upload?.dispatchEvent(progressEvent(win, 'loadstart', 0, upload));
      return live();
    };
    const fakeSuccess = (text, synchronous = false) => {
      entry.fake?.cancel();
      entry.synthetic = true;
      entry.fake = fakeXhrSuccess(win, xhr, {
        url: ctx.url, text, parse, synchronous, overrides,
        // Read when it starts, after loadstart has said whether there's an upload.
        uploadBytes: () => (entry.uploading ? upload : null),
        uploaded: () => { entry.uploading = false; },
      });
      return entry.fake;
    };

    const sendRequest = (requestBody, resumed) => {
      const blocker = blockingRule(ctx);
      if (blocker) {
        const fake = fakeSuccess(fakeAnswer(blocker, ctx), !entry.async);
        if (resumed || !entry.async || announce()) fake.start();
        return undefined;
      }

      entry.synthetic = false;
      overrides.release(xhr);
      const rules = active(responseRules, ctx);
      if (rules.length) attachTextTransform(xhr, lineStream(rules, ctx), textGetter, responseGetter, overrides);
      return resumed ? sendQuietly(xhr, requestBody, entry.uploading) : send.call(xhr, requestBody);
    };

    if (startupGate.state() === 'ready') return sendRequest(body, false);
    const pending = startupRule(ctx);
    if (!pending) return sendRequest(body, false);
    if (!entry.async) {
      fakeSuccess(fakeAnswer(pending, ctx), true).start();
      return undefined;
    }
    const bytes = bodyBytes(body);
    const queuedBody = bytes === null ? body : snapshotXhrBody(body);
    ctx.body = undefined;
    entry.synthetic = true;
    // Held while loadstart runs, so a handler that aborts there sees a request in flight. The
    // gate only takes it once loadstart is over.
    entry.deferred = { cancel() {} };
    if (!announce()) return undefined;

    const resume = () => {
      if (state.get(xhr) !== entry) return;
      entry.deferred = null;
      try {
        sendRequest(queuedBody, true);
      } catch (error) {
        log.error("A privacy request couldn't resume after saved settings loaded, so it stayed held back", error);
        fakeSuccess(fakeAnswer(pending, ctx)).start();
      }
    };
    const hold = () => {
      if (state.get(xhr) !== entry) return;
      entry.deferred = null;
      fakeSuccess(fakeAnswer(pending, ctx)).start();
    };
    entry.deferred = startupGate.defer({
      bytes,
      onReady: resume,
      onClosed: hold,
      onCancel: () => {},
    });
    return undefined;
  });

  if (typeof abort === 'function') {
    patch.set(proto, 'abort', function () {
      const entry = state.get(this);
      const wasInFlight = inFlight(entry);
      const uploading = wasInFlight && entry.uploading;
      stop(entry);
      overrides.release(this);
      const result = abort.apply(this, arguments);
      // The browser never sent a held or answered request, so its own abort changes nothing
      // and the page has to see what a real one shows: an in-flight request fails with
      // readystatechange, the upload's abort and loadend if it hadn't finished, then abort and
      // loadend, all at DONE, and every request ends UNSENT.
      if (!entry?.synthetic) return result;
      entry.uploading = false;
      if (wasInFlight) {
        overrides.define(this, xhrResult(win, this, { readyState: 4, status: 0, statusText: '', url: '', text: null }));
        // Chromium and Firefox fire them all even when a handler reopens or aborts again.
        this.dispatchEvent(new win.Event('readystatechange'));
        if (uploading) {
          this.upload?.dispatchEvent(progressEvent(win, 'abort'));
          this.upload?.dispatchEvent(progressEvent(win, 'loadend'));
        }
        this.dispatchEvent(progressEvent(win, 'abort'));
        this.dispatchEvent(progressEvent(win, 'loadend'));
        // A handler that reopened leaves the new request alone.
        if (state.get(this) !== entry) return result;
      }
      overrides.define(this, xhrResult(win, this, { readyState: 0, status: 0, statusText: '', url: '', text: null }));
      return result;
    });
  }
}

// The one header a held-back answer has: what new Response(text) gives the held-back fetch.
const ANSWER_TYPE = 'text/plain;charset=UTF-8';

// Wraps one of the prototype's setters so check can throw first. A property the browser
// doesn't have, or one fixed for good, is left alone.
function guardSetter(proto, key, check, patch) {
  const descriptor = descriptorOf(proto, key);
  if (typeof descriptor?.set !== 'function' || !descriptor.configurable) return;
  const set = descriptor.set;
  patch.define(proto, key, {
    ...descriptor,
    set(value) {
      check(this);
      set.call(this, value);
    },
  });
}

// Puts listener ahead of the page's own listeners for type on the instances of Target, since
// Chromium runs a target's listeners in the order they were added, capture or not. It's added
// the first time the page listens, through addEventListener or the on<type> handler, or when
// the hook calls the function it returns. Until the page listens on an upload, nothing is
// added to it: a listener there changes how a cross-origin request is sent.
function listenFirst(win, proto, Target, type, listener, patch) {
  const added = new WeakSet();
  const add = win.EventTarget?.prototype.addEventListener ?? proto?.addEventListener;
  const ensure = (target) => {
    if (added.has(target) || !(target instanceof Target)) return;
    added.add(target);
    add.call(target, type, listener, true);
  };
  if (!proto || typeof Target !== 'function' || typeof add !== 'function') return () => {};
  const definable = (key) => Object.getOwnPropertyDescriptor(proto, key)?.configurable !== false;
  const listen = descriptorOf(proto, 'addEventListener');
  if (typeof listen?.value === 'function' && definable('addEventListener')) {
    patch.define(proto, 'addEventListener', {
      ...listen,
      value: function addEventListener(eventType) {
        if (eventType === type) ensure(this);
        return listen.value.apply(this, arguments);
      },
    });
  }
  const handler = descriptorOf(proto, `on${type}`);
  if (typeof handler?.set === 'function' && definable(`on${type}`)) {
    patch.define(proto, `on${type}`, {
      ...handler,
      set(value) {
        ensure(this);
        handler.set.call(this, value);
      },
    });
  }
  return ensure;
}

// A property's descriptor from the first prototype on the chain that has it.
function descriptorOf(object, key) {
  for (let current = object; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return descriptor;
  }
  return undefined;
}

// The body a real send would upload, in bytes, or null when it uploads nothing (GET and HEAD
// send no body) or the exact size can't be known: the browser picks a FormData's multipart
// boundary, so a held FormData send fires no upload events.
function uploadSize(method, body) {
  if (body === undefined || body === null || ['GET', 'HEAD'].includes(String(method).toUpperCase())) return null;
  if (Object.prototype.toString.call(body) === '[object FormData]') return null;
  return bodyBytes(body);
}

// loaded and total as the browser gives them: a total it doesn't know is 0, and not computable.
function progressEvent(win, type, loaded = 0, total = 0) {
  return new win.ProgressEvent(type, { lengthComputable: total !== 0, loaded, total });
}

// The properties this hook puts on one XHR instance, all accessors. Releasing removes only
// those still holding the getter this hook set, and puts back whatever the page had defined
// on the instance before. It returns what it removed, for restore.
function xhrOverrides() {
  const owned = new WeakMap();
  return {
    define(xhr, getters) {
      let props = owned.get(xhr);
      if (!props) owned.set(xhr, (props = new Map()));
      for (const [key, get] of Object.entries(getters)) {
        const current = Object.getOwnPropertyDescriptor(xhr, key);
        if (current && !current.configurable) continue; // The page fixed this one for good.
        const mine = props.get(key);
        const previous = mine && current?.get === mine.get ? mine.previous : current;
        Object.defineProperty(xhr, key, { configurable: true, enumerable: true, get });
        props.set(key, { get, previous });
      }
    },
    release(xhr) {
      const props = owned.get(xhr);
      const removed = new Map();
      if (!props) return removed;
      owned.delete(xhr);
      for (const [key, entry] of props) {
        if (Object.getOwnPropertyDescriptor(xhr, key)?.get !== entry.get) continue;
        if (entry.previous) Object.defineProperty(xhr, key, entry.previous);
        else delete xhr[key];
        removed.set(key, entry);
      }
      return removed;
    },
    // Puts back what release removed, for an open() that threw.
    restore(xhr, removed) {
      if (removed.size) this.define(xhr, Object.fromEntries([...removed].map(([key, { get }]) => [key, get])));
    },
  };
}

function invalidState(win, message) {
  return typeof win.DOMException === 'function'
    ? new win.DOMException(message, 'InvalidStateError')
    : Object.assign(new Error(message), { name: 'InvalidStateError' });
}

// What a request the browser never sent shows the page. text is the answer, or null for a
// failed request, and each read follows responseType and readyState the way the browser's own
// getters do: no text before LOADING, and no typed response before DONE.
function xhrResult(win, xhr, { readyState, status, statusText, url, text, parse }) {
  const textual = () => xhr.responseType === '' || xhr.responseType === 'text';
  let typed = null;
  const typedResponse = () => {
    const type = xhr.responseType;
    if (typed?.type !== type) typed = { type, value: text === null ? null : decodeAs(win, type, text, parse) };
    return typed.value;
  };
  return {
    readyState: () => readyState,
    status: () => status,
    statusText: () => statusText,
    responseURL: () => url,
    responseText: () => {
      if (!textual()) {
        throw invalidState(win, `Failed to read the 'responseText' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'text' (was '${xhr.responseType}').`);
      }
      return readyState < 3 ? '' : text ?? '';
    },
    response: () => {
      if (textual()) return readyState < 3 ? '' : text ?? '';
      return readyState < 4 ? null : typedResponse();
    },
  };
}

function decodeAs(win, type, text, parse) {
  if (type === 'json') {
    try {
      return parse(text);
    } catch {
      return null; // The browser's json response is null when the body doesn't parse.
    }
  }
  if (type === 'arraybuffer' && typeof win.TextEncoder === 'function') return new win.TextEncoder().encode(text).buffer;
  if (type === 'blob' && typeof win.Blob === 'function') return new win.Blob([text]);
  return null;
}

// Facebook reads responseText while the body is still arriving. Each read returns the
// transformed text of every complete line so far, which only ever grows.
// The getters taken from the prototype can belong to another script that hooked XHR first,
// and one that builds responseText from this.response lands back on these getters mid-read.
// While a read runs, they hand back what the prototype says, so the two never loop.
function attachTextTransform(xhr, stream, textGetter, responseGetter, overrides) {
  let seen = 0;
  let output = '';
  let flushed = false;
  let reading = false;

  const read = () => {
    if (reading) return textGetter.call(xhr);
    reading = true;
    try {
      const raw = textGetter.call(xhr);
      if (raw.length > seen) {
        output += stream.push(raw.slice(seen));
        seen = raw.length;
      }
      if (xhr.readyState === 4 && !flushed) {
        output += stream.flush();
        flushed = true;
      }
    } finally {
      reading = false;
    }
    return output;
  };
  const textual = () => xhr.responseType === '' || xhr.responseType === 'text';

  overrides.define(xhr, {
    responseText: read,
    response: () => (!reading && textual() ? read() : responseGetter.call(xhr)),
  });
}

// Completes a request the browser never sent the way Chromium and Firefox deliver an answer
// that comes in one piece with no length. Until then the page sees the opened request. Each
// stage is a task of its own: the upload's progress, load and loadend when there's a body, then
// HEADERS_RECEIVED, then LOADING with one progress event, then DONE with load and loadend. Each
// event runs in its own microtask, so what one event's listeners queue runs before the next
// event. A reopen or abort stops the stages still to come, but LOADING's progress fires anyway
// (with nothing received), and so does loadend once load has, as in both browsers.
function fakeXhrSuccess(win, xhr, { url, text, parse, synchronous, uploadBytes = () => null, uploaded = () => {}, overrides }) {
  let active = true;
  let timer = null;
  const bytes = bodyBytes(String(text));
  const show = (readyState) => overrides.define(xhr, xhrResult(win, xhr, { readyState, status: 200, statusText: 'OK', url, text, parse }));
  const changed = () => { xhr.dispatchEvent(new win.Event('readystatechange')); };
  const fire = (target, type, loaded, total) => { target?.dispatchEvent(progressEvent(win, type, loaded, total)); };
  const later = typeof win.queueMicrotask === 'function' ? (step) => win.queueMicrotask(step) : (step) => Promise.resolve().then(step);
  // Runs one stage's events in order. A step that returns false ends the stage.
  const run = (steps, then) => {
    const next = (i) => {
      if (i === steps.length) return then();
      if (steps[i]() === false) return undefined;
      if (synchronous) return next(i + 1);
      later(() => next(i + 1));
      return undefined;
    };
    next(0);
  };
  const done = [
    () => {
      fake.pending = false;
      show(4);
      changed();
      return active;
    },
    () => fire(xhr, 'load', bytes, 0),
    () => fire(xhr, 'loadend', bytes, 0),
  ];
  const stagesFor = (upload) => {
    if (synchronous) return [done];
    const stages = [];
    if (upload !== null) {
      stages.push([
        () => {
          uploaded();
          fire(xhr.upload, 'progress', upload, upload);
        },
        () => fire(xhr.upload, 'load', upload, upload),
        () => fire(xhr.upload, 'loadend', upload, upload),
      ]);
    }
    stages.push([() => { show(2); changed(); }]);
    stages.push([() => { show(3); changed(); }, () => fire(xhr, 'progress', active ? bytes : 0, 0)]);
    stages.push(done);
    return stages;
  };
  // Started only once the caller holds the handle, so a synchronous completion's handlers
  // can already cancel it.
  const fake = {
    pending: true,
    start() {
      const stages = stagesFor(uploadBytes());
      const stage = (i) => {
        timer = null;
        if (!active) return;
        run(stages[i], () => {
          if (active && i + 1 < stages.length) timer = win.setTimeout(() => stage(i + 1), 0);
        });
      };
      if (synchronous) stage(0);
      else timer = win.setTimeout(() => stage(0), 0);
    },
    cancel() {
      active = false;
      fake.pending = false;
      if (timer !== null) win.clearTimeout(timer);
      timer = null;
    },
  };
  return fake;
}

// Facebook calls JSON.parse constantly, so the marker check (a substring search) runs
// before anything else and most calls return untouched. A call with a reviver is left alone:
// the reviver has already seen every value as it was built, and editing after it would hand
// back what it never saw.
function patchJsonParse(win, { active, responseRules, onError, handled, patch }) {
  const json = win.JSON;
  const parse = json?.parse;
  if (typeof parse !== 'function') return;
  patch.set(json, 'parse', function (text, reviver) {
    const result = parse.apply(this, arguments);
    if (typeof reviver === 'function') return result;
    if (typeof text !== 'string' || result === null || typeof result !== 'object') return result;
    let candidates = rulesFor(text, responseRules);
    if (!candidates.length) return result;
    // A line of a fetch or XHR answer already went through the rules that were on for it,
    // judged by its query.
    const done = handled?.get(text);
    if (done) candidates = candidates.filter((rule) => !done.has(rule));
    const rules = active(candidates, INLINE_JSON);
    if (!rules.length) return result;
    // The rules edit in place, so a failed pass parses again for an unedited copy. Only then:
    // a pass that works costs no copy. DROP means nothing here, since the page asked for a
    // value, so a dropped document comes back as edited.
    const accepted = applyRules(result, rules, INLINE_JSON, onError) === FAILED ? parse.apply(this, arguments) : result;
    observeRules(accepted, rules, INLINE_JSON, onError);
    return accepted;
  });
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

// Facebook parses a line it fetched a second time inside a one-key box, {"q7z": line}, with
// a key of its own choosing (live 2026-10-22, ghlParseRelayResponse), so a pruner keyed on
// data.viewer misses it. The line inside, or null.
const BOX = /^\{"[^"\\]{1,32}":/;
function unboxed(line) {
  const text = line.trim();
  const head = BOX.exec(text);
  return head && text.endsWith('}') ? text.slice(head[0].length, -1) : null;
}

export function createHandledLines(limit = 64) {
  const lines = new Map(); // key -> Set of rules
  const find = (line) => {
    const key = lineKey(line);
    if (lines.has(key)) return key;
    const inner = unboxed(line);
    const boxed = inner === null ? null : lineKey(inner);
    return boxed !== null && lines.has(boxed) ? boxed : undefined;
  };
  return {
    add(line, rules = []) {
      const key = lineKey(line);
      const done = lines.get(key) ?? new Set();
      for (const rule of rules) done.add(rule);
      lines.delete(key);
      lines.set(key, done);
      if (lines.size > limit) lines.delete(lines.keys().next().value);
    },
    // The rules that already looked at this line, or at the line inside its box, or undefined.
    get: (line) => {
      const key = find(line);
      return key === undefined ? undefined : lines.get(key);
    },
    has: (line) => find(line) !== undefined,
  };
}

function patchBeacon(win, { blockingRule, startupRule, startupGate, fakeAnswer, patch }) {
  const nav = win.navigator;
  const original = nav?.sendBeacon;
  if (typeof original !== 'function') return;
  patch.set(nav, 'sendBeacon', function sendBeacon(url, data) {
    const ctx = describeRequest({ transport: 'beacon', url, method: 'POST', body: data, base: win.location.href });
    const blocker = startupGate.state() === 'ready' ? blockingRule(ctx) : startupRule(ctx);
    if (blocker) {
      // A beacon gets no answer, but the rule still hears that it held one back.
      fakeAnswer(blocker, ctx);
      return true;
    }
    return original.apply(this, arguments);
  });
}
