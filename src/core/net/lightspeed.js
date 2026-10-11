// Facebook's chat runs over one socket, wss://gateway.facebook.com/ws/lightspeed. Each socket
// message holds one or more gateway frames:
//
//   0x0f open a stream    type, stream (2 bytes), length (3 bytes), body ("{}" going out)
//   0x0d data             same header; body is a 2 byte sequence number, then JSON
//   0x0c acknowledgement  same header
//   0x0e close a stream   type, stream (2 bytes)
//   0x09, 0x0a            ping and pong, one byte
//
// Numbers are little-endian. Every request opens its own stream, so a frame is never dropped:
// the server would be left waiting on it. A request is edited in place and its length fixed.
//
// The data JSON is {app_id, payload, request_id, type}, with payload a JSON string of its own.
// type 3 carries queued tasks ({epoch_id, tasks: [{label, payload, queue_name, task_id}]}),
// type 4 one task that isn't queued ({label, payload, version}). Labels are the ones the open
// source mautrix-meta bridge names: 21 marks a thread read, 3 says whether you're typing.

const SHORT = new Map([[0x09, 1], [0x0a, 1], [0x0e, 3]]);
const WITH_BODY = new Set([0x0c, 0x0d, 0x0f]);
export const DATA = 0x0d;

// The frames in a message, or null when it isn't exactly a run of known frames.
export function readFrames(bytes) {
  const frames = [];
  let at = 0;
  while (at < bytes.length) {
    const type = bytes[at];
    const size = SHORT.get(type);
    if (size) {
      if (at + size > bytes.length) return null;
      frames.push({ type, raw: bytes.subarray(at, at + size) });
      at += size;
      continue;
    }
    if (!WITH_BODY.has(type) || at + 6 > bytes.length) return null;
    const length = bytes[at + 3] | (bytes[at + 4] << 8) | (bytes[at + 5] << 16);
    if (at + 6 + length > bytes.length) return null;
    frames.push({ type, stream: bytes[at + 1] | (bytes[at + 2] << 8), body: bytes.subarray(at + 6, at + 6 + length) });
    at += 6 + length;
  }
  return frames;
}

export function writeFrames(frames) {
  const size = frames.reduce((sum, frame) => sum + (frame.raw ? frame.raw.length : 6 + frame.body.length), 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const frame of frames) {
    if (frame.raw) {
      out.set(frame.raw, at);
      at += frame.raw.length;
      continue;
    }
    const length = frame.body.length;
    out[at] = frame.type;
    out[at + 1] = frame.stream & 0xff;
    out[at + 2] = (frame.stream >> 8) & 0xff;
    out[at + 3] = length & 0xff;
    out[at + 4] = (length >> 8) & 0xff;
    out[at + 5] = (length >> 16) & 0xff;
    out.set(frame.body, at + 6);
    at += 6 + length;
  }
  return out;
}

// A data frame's JSON, or null when the body isn't a sequence number followed by an object.
export function frameJson(frame, decoder) {
  if (frame.type !== DATA || !frame.body || frame.body.length < 3 || frame.body[2] !== 0x7b) return null;
  return decoder.decode(frame.body.subarray(2));
}

export function withJson(frame, text, encoder) {
  const json = encoder.encode(text);
  const body = new Uint8Array(2 + json.length);
  body.set(frame.body.subarray(0, 2));
  body.set(json, 2);
  return { ...frame, body };
}

// Ids like epoch_id run to 19 digits, past what a JavaScript number holds, so plain JSON.parse
// and JSON.stringify would change them. Integers that big are read as tagged strings and
// written back as the digits they were.
const BIG = '\u0000n:';
const BIG_BACK = /"\\u0000n:(-?\d+)"/g;

function protectBig(text) {
  let out = '';
  let last = 0;
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (char === '"') {
      at++;
      while (at < text.length && text[at] !== '"') at += text[at] === '\\' ? 2 : 1;
      at++;
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      let end = at + 1;
      while (end < text.length && '0123456789.eE+-'.includes(text[end])) end++;
      const token = text.slice(at, end);
      if (/^-?\d{16,}$/.test(token) && !Number.isSafeInteger(Number(token))) {
        out += text.slice(last, at) + JSON.stringify(BIG + token);
        last = end;
      }
      at = end;
      continue;
    }
    at++;
  }
  return out + text.slice(last);
}

export function writeJson(value) {
  return JSON.stringify(value).replace(BIG_BACK, '$1');
}

// Parsed JSON, or null unless writing it back gives the same text, so an edit never changes
// anything but what it means to.
export function readJson(text) {
  try {
    const value = JSON.parse(protectBig(text));
    return writeJson(value) === text ? value : null;
  } catch {
    return null;
  }
}

// { type, payload } of a lightspeed request, payload parsed, or null.
export function readRequest(text) {
  const outer = readJson(text);
  if (!outer || typeof outer !== 'object' || typeof outer.payload !== 'string') return null;
  const payload = readJson(outer.payload);
  if (!payload || typeof payload !== 'object') return null;
  return { outer, type: outer.type, payload };
}

export function writeRequest(request) {
  return writeJson({ ...request.outer, payload: writeJson(request.payload) });
}
