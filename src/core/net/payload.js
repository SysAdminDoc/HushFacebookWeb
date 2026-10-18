// Facebook answers GraphQL and many /ajax/ calls with several JSON documents in one body,
// one per line (streamed @defer and @stream chunks), and sometimes behind a "for (;;);"
// guard. Transforms run per document; untouched lines keep their exact bytes.

export const DROP = Symbol('hfw.drop');
const GUARD = 'for (;;);';

// A rule with markers only runs on text that contains one of them, so most documents are
// never parsed at all.
export function rulesFor(text, rules) {
  return rules.filter((rule) => !rule.markers || rule.markers.some((marker) => text.includes(marker)));
}

// What applyRules returns when a rule threw, so the caller hands back the data as it came.
export const FAILED = Symbol('hfw.failed');

// Runs effect once the document a rule changed is the one the page gets: a count, a
// Diagnostics decision, anything kept after the document. Called with no stage (a rule run on
// its own, in a test), it runs at once.
export function later(stage, effect) {
  if (stage) stage.defer(effect);
  else effect();
}

// The rules on one parsed document, run as one change. A transform gets (doc, ctx, stage) and
// returns DROP, true when it changed doc in place, or nothing. When one throws, the rest don't
// run, nothing queued with stage.defer happens, what was given to stage.undo runs (newest
// first), and the result is FAILED: doc may be half edited and must not reach the page.
// Otherwise the queued effects run and the result is DROP or whether doc changed. Rules marked
// observe only read, and are left to observeRules.
export function applyRules(doc, rules, ctx, onError) {
  const effects = [];
  const undos = [];
  let current = null;
  const stage = {
    defer: (effect) => effects.push([current, effect]),
    undo: (restore) => undos.push([current, restore]),
  };
  let changed = false;
  for (const rule of rules) {
    if (rule.observe) continue;
    current = rule;
    let result;
    try {
      result = rule.transform(doc, ctx, stage);
    } catch (error) {
      onError?.(rule, error);
      settle(undos.reverse(), onError);
      return FAILED;
    }
    if (result === DROP) {
      settle(effects, onError);
      return DROP;
    }
    if (result === true) changed = true;
  }
  settle(effects, onError);
  return changed;
}

function settle(steps, onError) {
  for (const [rule, step] of steps) {
    try {
      step();
    } catch (error) {
      onError?.(rule, error);
    }
  }
}

// The read-only rules, on the data the page actually gets.
export function observeRules(doc, rules, ctx, onError) {
  for (const rule of rules) {
    if (!rule.observe) continue;
    try {
      rule.transform(doc, ctx);
    } catch (error) {
      onError?.(rule, error);
    }
  }
}

// Returns the new line, or null to drop it. A failed pass returns the line's own bytes.
// parse should be the page's original JSON.parse: the hooked one runs the same rules
// first, and the line would then look unchanged and go out with the ad still in it.
export function transformDocumentLine(line, allRules, ctx, onError, parse = JSON.parse) {
  const rules = rulesFor(line, allRules);
  if (!rules.length) return line;
  let prefix = '';
  let body = line;
  if (body.startsWith(GUARD)) {
    prefix = GUARD;
    body = body.slice(GUARD.length);
  }
  const first = body.trimStart()[0];
  if (first !== '{' && first !== '[') return line;

  let doc;
  try {
    doc = parse(body);
  } catch {
    return line;
  }

  const result = applyRules(doc, rules, ctx, onError);
  if (result === DROP) return null;
  if (result === FAILED) {
    // doc took the failed rules' edits, so readers get a fresh copy of what Facebook sent.
    if (rules.some((rule) => rule.observe)) observeRules(parse(body), rules, ctx, onError);
    return line;
  }
  observeRules(doc, rules, ctx, onError);
  return result ? prefix + JSON.stringify(doc) : line;
}

// A document longer than this many characters goes out as it came, unparsed and never held
// whole. The largest one captured from Facebook (a Groups feed page, 2026-10-11) was about
// 1.8 million characters, so this leaves room for four times that.
export const LINE_LIMIT = 8 * 1024 * 1024;

// Splits a growing body into complete lines and transforms each once. Output is only ever
// appended to, so a reader that polls a growing responseText sees a stable prefix. Once an
// unfinished line passes limit, what's held of it goes out untouched, and so does the rest
// of it as it arrives, up to its line break. onBypass is called once for each such line.
export function createLineStream(transformLine, { limit = LINE_LIMIT, onBypass } = {}) {
  let pending = '';
  let passing = false;

  function emit(raw, newline) {
    if (raw.length > limit) {
      onBypass?.();
      return raw + newline;
    }
    const cr = raw.endsWith('\r') ? '\r' : '';
    const result = transformLine(cr ? raw.slice(0, -1) : raw);
    return result === null ? '' : result + cr + newline;
  }

  return {
    push(chunk) {
      let out = '';
      if (passing) {
        const end = chunk.indexOf('\n');
        if (end === -1) return chunk;
        passing = false;
        out = chunk.slice(0, end + 1);
        chunk = chunk.slice(end + 1);
      }
      // Only the new text can hold a line break, so a long line isn't searched again each time.
      const end = chunk.lastIndexOf('\n');
      if (end === -1) {
        pending += chunk;
      } else {
        const complete = pending + chunk.slice(0, end);
        pending = chunk.slice(end + 1);
        out += complete.split('\n').map((raw) => emit(raw, '\n')).join('');
      }
      if (pending.length > limit) {
        onBypass?.();
        out += pending;
        pending = '';
        passing = true;
      }
      return out;
    },
    // The end of the body. A stream isn't used again after it.
    flush() {
      const raw = pending;
      pending = '';
      return raw ? emit(raw, '') : '';
    },
    // How much of an unfinished line is held, in characters.
    get held() {
      return pending.length;
    },
  };
}

export function transformText(text, transformLine) {
  const stream = createLineStream(transformLine);
  return stream.push(text) + stream.flush();
}

// Relay names every GraphQL operation; the header is newer, the body field older.
export function friendlyNameOf(body, headers) {
  const header = headerValue(headers, 'x-fb-friendly-name');
  if (header) return header;
  if (typeof body === 'string') {
    if (!body.includes('fb_api_req_friendly_name')) return '';
    return new URLSearchParams(body).get('fb_api_req_friendly_name') ?? '';
  }
  if (body && typeof body.get === 'function') return body.get('fb_api_req_friendly_name') ?? '';
  return '';
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) ?? '';
  if (Array.isArray(headers)) return headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? '';
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return '';
}
