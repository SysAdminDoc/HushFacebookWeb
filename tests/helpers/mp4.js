// Small fragmented MP4 files built box by box, shaped like the DASH copies Facebook serves (one
// track, mvex, a sidx index, then moof and mdat pairs), and a reader for the boxes of a result.
// Each mdat holds a short text, so a test can follow where a fragment went.

const ascii = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0));

function number(size, value) {
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  if (size === 8) view.setBigUint64(0, BigInt(value));
  else if (size === 4) view.setUint32(0, value);
  else view.setUint16(0, value);
  return out;
}
const u16 = (value) => number(2, value);
const u32 = (value) => number(4, value);
const u64 = (value) => number(8, value);
const zeros = (size) => new Uint8Array(size);

export function join(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const box = (type, ...parts) => {
  const body = join(parts);
  return join([u32(8 + body.length), ascii(type), body]);
};
// The same with a 64-bit size, the way a very long mdat is written.
const largeBox = (type, ...parts) => {
  const body = join(parts);
  return join([u32(1), ascii(type), u64(16 + body.length), body]);
};
const full = (type, version, flags, ...parts) => box(type, Uint8Array.of(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);

const MATRIX = join([u32(0x10000), zeros(12), u32(0x10000), zeros(12), u32(0x40000000)]);

// One track's file. fragments: [[time in the track's time scale, mdat text], ...].
// absolute: each tfhd carries a base offset into the whole file (ffmpeg's default) instead of
// counting from its moof. version: tkhd and elst; headerVersion: mvhd and mdhd. The rest make
// broken files: elstCount past the entries there, shortTfhd (flag 1 with no room for the
// offset), noTfhd, and openMdat (the last mdat's size 0, "to the end of the file", which is
// allowed).
export function trackFile({
  id = 1, movieScale = 1000, mediaScale = 15360, length = 8000, edit = null, version = 0, headerVersion = 0,
  fragments = [[0, 'A']], absolute = false, sidx = true, largeMdat = false, traks = 1, mvex = true, tfdt = true,
  tfdtVersion = 1, elstCount = 1, shortTfhd = false, noTfhd = false, openMdat = false,
} = {}) {
  const wide = version === 1;
  const time = wide ? u64 : u32;
  const headerTime = headerVersion === 1 ? u64 : u32;
  const tkhd = full('tkhd', version, 3, time(0), time(0), u32(id), u32(0), time(length), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(0), u32(0));
  const edts = edit === null ? [] : [box('edts', full('elst', version, 0, u32(elstCount), time(edit), time(0), u16(1), u16(0)))];
  const mdhd = full('mdhd', headerVersion, 0, headerTime(0), headerTime(0), u32(mediaScale), headerTime(0), u16(0x55c4), u16(0));
  const trak = box('trak', tkhd, ...edts, box('mdia', mdhd));
  const mvhd = full('mvhd', headerVersion, 0, headerTime(0), headerTime(0), u32(movieScale), headerTime(length), u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(id + 1));
  const trex = full('trex', 0, 0, u32(id), u32(1), u32(0), u32(0), u32(0));
  const moov = box('moov', mvhd, ...Array.from({ length: traks }, () => trak), ...(mvex ? [box('mvex', trex)] : []));
  const parts = [box('ftyp', ascii('iso6'), u32(0), ascii('iso6dash')), moov];
  if (sidx) parts.push(full('sidx', 1, 0, u32(id), u32(mediaScale), u64(0), u64(0), u16(0), u16(0)));
  let position = parts.reduce((sum, part) => sum + part.length, 0);
  fragments.forEach(([start, text], index) => {
    const tfhd = shortTfhd ? full('tfhd', 0, 1, u32(id)) : absolute ? full('tfhd', 0, 1, u32(id), u64(position)) : full('tfhd', 0, 0x20000, u32(id));
    const tfdtBox = full('tfdt', tfdtVersion, 0, (tfdtVersion === 1 ? u64 : u32)(start));
    const traf = box('traf', ...(noTfhd ? [] : [tfhd]), ...(tfdt ? [tfdtBox] : []), full('trun', 0, 1, u32(1), u32(0)));
    const moof = box('moof', full('mfhd', 0, 0, u32(index + 1)), traf);
    const mdat = (largeMdat ? largeBox : box)('mdat', ascii(text));
    if (openMdat && index === fragments.length - 1) mdat.set(u32(0), 0);
    parts.push(moof, mdat);
    position += moof.length + mdat.length;
  });
  return join(parts);
}

// The boxes from start to end: { type, start, end, body } with body where the contents begin.
export function boxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found = [];
  for (let at = start; at < end;) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = end - at;
    found.push({ type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), start: at, end: at + size, body: at + header });
    at += size;
  }
  return found;
}

export const inside = (bytes, parent, type) => boxes(bytes, parent.body, parent.end).filter((b) => type === undefined || b.type === type);
export const word = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at);
export const wide = (bytes, at) => Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(at));
export const text = (bytes, b) => String.fromCharCode(...bytes.subarray(b.body, b.end));
