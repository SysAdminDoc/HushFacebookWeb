// Wraps fetch, XMLHttpRequest and sendBeacon in Facebook's window so features can drop
// requests (read receipts, story seen, telemetry) and prune responses (ads, suggestions).
// JSON.parse is wrapped too: the first screen of the feed arrives inline in the HTML as
// <script type="application/json" data-sjs> blocks, never through fetch or XHR.
//
// A failing rule is logged once and skipped. Facebook always gets a response.

import { createLineStream, friendlyNameOf, rulesFor, transformDocumentLine } from './payload.js';

const INSTALLED = Symbol.for('hushfacebook-web.net');
const INLINE_JSON = Object.freeze({ transport: 'json-parse', method: '', url: '', host: '', path: '', friendlyName: '' });

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

export function installNetworkHooks({ win, log }) {
  if (win[INSTALLED]) return win[INSTALLED];

  const requestRules = [];
  const responseRules = [];
  const failed = new Set();

  const onError = (rule, error) => {
    if (failed.has(rule.id)) return;
    failed.add(rule.id);
    log.error(`Network rule "${rule.id}" failed, so Facebook got its original data`, error);
  };

  const active = (rules, ctx) =>
    rules.filter((rule) => {
      try {
        return rule.enabled() && rule.match(ctx);
      } catch (error) {
        onError(rule, error);
        return false;
      }
    });

  const blockingRule = (ctx) => active(requestRules, ctx)[0];
  const lineTransformer = (rules, ctx) => (line) => transformDocumentLine(line, rules, ctx, onError);

  patchFetch(win, { blockingRule, active, responseRules, lineTransformer, log });
  patchXhr(win, { blockingRule, active, responseRules, lineTransformer });
  patchBeacon(win, { blockingRule });
  patchJsonParse(win, { active, responseRules, onError });

  const api = {
    // rule: { id, enabled(), match(ctx), fakeResponse?(ctx) }
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

function patchFetch(win, { blockingRule, active, responseRules, lineTransformer, log }) {
  const original = win.fetch;
  if (typeof original !== 'function') return;

  win.fetch = function fetch(input, init) {
    const isRequest = typeof win.Request === 'function' && input instanceof win.Request;
    const ctx = describeRequest({
      transport: 'fetch',
      url: isRequest ? input.url : input,
      method: init?.method ?? (isRequest ? input.method : 'GET'),
      body: init?.body,
      headers: init?.headers ?? (isRequest ? input.headers : undefined),
      base: win.location.href,
    });

    const blocker = blockingRule(ctx);
    if (blocker) {
      return win.Promise.resolve(new win.Response(blocker.fakeResponse?.(ctx) ?? '{}', { status: 200 }));
    }

    const promise = original.apply(this, arguments);
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
  };
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

function patchXhr(win, { blockingRule, active, responseRules, lineTransformer }) {
  const Xhr = win.XMLHttpRequest;
  if (typeof Xhr !== 'function') return;
  const proto = Xhr.prototype;
  const { open, send, setRequestHeader } = proto;
  const textGetter = Object.getOwnPropertyDescriptor(proto, 'responseText').get;
  const responseGetter = Object.getOwnPropertyDescriptor(proto, 'response').get;
  const state = new WeakMap();

  proto.open = function (method, url) {
    state.set(this, { method, url, headers: {} });
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
    const ctx = describeRequest({ transport: 'xhr', url: entry.url, method: entry.method, body, headers: entry.headers, base: win.location.href });

    const blocker = blockingRule(ctx);
    if (blocker) return fakeXhrSuccess(win, this, ctx, blocker.fakeResponse?.(ctx) ?? '{}');

    const rules = active(responseRules, ctx);
    if (rules.length) attachTextTransform(this, lineTransformer(rules, ctx), textGetter, responseGetter);
    return send.apply(this, arguments);
  };
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

function fakeXhrSuccess(win, xhr, ctx, text) {
  const values = { readyState: 4, status: 200, statusText: 'OK', responseText: text, response: text, responseURL: ctx.url };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(xhr, key, { configurable: true, value });
  win.setTimeout(() => {
    xhr.dispatchEvent(new win.Event('readystatechange'));
    xhr.dispatchEvent(new win.ProgressEvent('load'));
    xhr.dispatchEvent(new win.ProgressEvent('loadend'));
  }, 0);
}

// Facebook calls JSON.parse constantly, so the marker check (a substring search) runs
// before anything else and most calls return untouched.
function patchJsonParse(win, { active, responseRules, onError }) {
  const json = win.JSON;
  const parse = json?.parse;
  if (typeof parse !== 'function') return;
  json.parse = function (text) {
    const result = parse.apply(this, arguments);
    if (typeof text !== 'string' || result === null || typeof result !== 'object') return result;
    const candidates = rulesFor(text, responseRules);
    if (!candidates.length) return result;
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

function patchBeacon(win, { blockingRule }) {
  const nav = win.navigator;
  const original = nav?.sendBeacon;
  if (typeof original !== 'function') return;
  nav.sendBeacon = function sendBeacon(url, data) {
    const ctx = describeRequest({ transport: 'beacon', url, method: 'POST', body: data, base: win.location.href });
    if (blockingRule(ctx)) return true;
    return original.apply(this, arguments);
  };
}
