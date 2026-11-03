// Facebook's site sends its logging events (Falco) over a second socket,
// wss://gateway.facebook.com/ws/realtime, in the same gateway frames as the chat (lightspeed.js).
// Live 2026-11-03 on Home: a data frame's body is the 2 byte sequence number, then a Thrift compact
// struct field holding a number and the batch as JSON, then the two stop bytes:
//
//   3c  16 <varint>  18 <varint length> {"events":[{"name":..., "extra":"<JSON>", ...}]}  00 00
//
// (field 3, a struct: field 1 an i64, field 2 binary). The server acknowledges every data frame, so
// a frame is never dropped, only its JSON rewritten and both lengths fixed. Anything that isn't
// exactly that shape is left alone.

const STRUCT = 0x0c;
const INTEGERS = new Set([0x04, 0x05, 0x06]);
const BINARY = 0x08;

function varint(bytes, at) {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 10 && at + i < bytes.length; i++) {
    const byte = bytes[at + i];
    value += (byte & 0x7f) * scale;
    scale *= 128;
    if (!(byte & 0x80)) return { value, end: at + i + 1 };
  }
  return null;
}

function writeVarint(value) {
  const out = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
}

// { text, start, end, lengthAt } for a data frame body holding a log batch, or null.
export function readBatchBody(body, decoder) {
  if (!body || body.length < 8) return null;
  let at = 2;
  const outer = body[at++];
  if ((outer & 0x0f) !== STRUCT || !(outer >> 4)) return null;
  let json = null;
  for (;;) {
    if (at >= body.length) return null;
    const header = body[at++];
    if (header === 0) break;
    const type = header & 0x0f;
    // A zero delta means a long field id follows, which this shape never has.
    if (!(header >> 4)) return null;
    const length = varint(body, at);
    if (!length) return null;
    if (INTEGERS.has(type)) {
      at = length.end;
      continue;
    }
    if (type !== BINARY || json) return null;
    const start = length.end;
    const end = start + length.value;
    if (end > body.length || body[start] !== 0x7b) return null;
    json = { lengthAt: at, start, end };
    at = end;
  }
  if (!json || at !== body.length - 1 || body[at] !== 0) return null;
  return { ...json, text: decoder.decode(body.subarray(json.start, json.end)) };
}

export function withBatchText(frame, read, text, encoder) {
  const json = encoder.encode(text);
  const length = writeVarint(json.length);
  const head = frame.body.subarray(0, read.lengthAt);
  const tail = frame.body.subarray(read.end);
  const body = new Uint8Array(head.length + length.length + json.length + tail.length);
  body.set(head);
  body.set(length, head.length);
  body.set(json, head.length + length.length);
  body.set(tail, head.length + length.length + json.length);
  return { ...frame, body };
}
