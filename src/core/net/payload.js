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

// rules: [{ id, markers?, transform(doc, ctx) }]; a transform returns DROP, true when it
// changed doc in place, or nothing. Returns the new line, or null to drop it.
export function transformDocumentLine(line, allRules, ctx, onError) {
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
    doc = JSON.parse(body);
  } catch {
    return line;
  }

  let changed = false;
  for (const rule of rules) {
    let result;
    try {
      result = rule.transform(doc, ctx);
    } catch (error) {
      onError?.(rule, error);
      continue;
    }
    if (result === DROP) return null;
    if (result === true) changed = true;
  }
  return changed ? prefix + JSON.stringify(doc) : line;
}

// Splits a growing body into complete lines and transforms each once. Output is only ever
// appended to, so a reader that polls a growing responseText sees a stable prefix.
export function createLineStream(transformLine) {
  let pending = '';

  function emit(raw, newline) {
    const cr = raw.endsWith('\r') ? '\r' : '';
    const result = transformLine(cr ? raw.slice(0, -1) : raw);
    return result === null ? '' : result + cr + newline;
  }

  return {
    push(chunk) {
      pending += chunk;
      const end = pending.lastIndexOf('\n');
      if (end === -1) return '';
      const complete = pending.slice(0, end);
      pending = pending.slice(end + 1);
      return complete.split('\n').map((raw) => emit(raw, '\n')).join('');
    },
    flush() {
      const raw = pending;
      pending = '';
      return raw ? emit(raw, '') : '';
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
