// Puts a DASH picture copy and its sound copy together as one MP4, without re-encoding.
//
// Both are fragmented MP4 files: ftyp, a moov describing one track (with mvex, since the
// samples live in the fragments), a sidx index, then moof and mdat pairs. The result keeps the
// picture's ftyp and moov, adds the sound's track to that moov under the next free track id,
// and lays the fragments of both out in time order, numbered again from 1. The sidx indexes
// go, since each one only describes its own file. A fragment finds its samples from the start
// of its own moof unless its tfhd carries a base offset into the whole file, and that offset
// moves with it. The sound's edit list and track length are in its own movie's time scale, so
// they're scaled to the picture's when the two differ.
//
// The inputs are changed in place (track ids, sequence numbers, offsets), and the result is a
// list of pieces that mostly point into them, ready for a Blob, so a long video isn't copied
// a second time before the browser takes it.

// What's wrong, for the log. download.js gives the person its own reason.
const fault = () => new Error('not one fragmented track with its moof and mdat pairs');

function boxesIn(bytes, start, end) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found = [];
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) throw fault();
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      // "To the end of the file", which stops being true once the fragments are interleaved,
      // so the real size is written in.
      size = end - at;
      if (size > 0xffffffff) throw fault();
      view.setUint32(at, size);
    }
    if (size < header || at + size > end) throw fault();
    found.push({ type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), start: at, end: at + size, header });
    at += size;
  }
  return found;
}

const children = (bytes, box) => boxesIn(bytes, box.start + box.header, box.end);
const child = (bytes, box, type) => (box ? children(bytes, box).find((b) => b.type === type) ?? null : null);
const path = (bytes, box, ...types) => types.reduce((inside, type) => child(bytes, inside, type), box);
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const versionOf = (bytes, box) => bytes[box.start + box.header];

// Where a full box's fields start, after its header, version and flags.
const fields = (box) => box.start + box.header + 4;

// A field's offset, once it's known to lie inside its own box, so a short box can't have its
// neighbour read or overwritten.
function within(box, at, length) {
  if (at + length > box.end) throw fault();
  return at;
}

function readTime(bytes, box, at, wide) {
  within(box, at, wide ? 8 : 4);
  return wide ? Number(view(bytes).getBigUint64(at)) : view(bytes).getUint32(at);
}

// mvhd and mdhd: creation and modification times, then the time scale.
function timescaleOf(bytes, box) {
  const wide = versionOf(bytes, box) === 1;
  return view(bytes).getUint32(within(box, fields(box) + (wide ? 16 : 8), 4));
}

function parse(bytes) {
  const top = boxesIn(bytes, 0, bytes.length);
  const ftyp = top.find((b) => b.type === 'ftyp');
  const moov = top.find((b) => b.type === 'moov');
  const traks = moov ? children(bytes, moov).filter((b) => b.type === 'trak') : [];
  const mvhd = child(bytes, moov, 'mvhd');
  const mvex = child(bytes, moov, 'mvex');
  if (!ftyp || traks.length !== 1 || !mvhd || !mvex) throw fault();
  const trak = traks[0];
  const tkhd = child(bytes, trak, 'tkhd');
  const mdhd = path(bytes, trak, 'mdia', 'mdhd');
  if (!tkhd || !mdhd) throw fault();
  const idAt = within(tkhd, fields(tkhd) + (versionOf(bytes, tkhd) === 1 ? 16 : 8), 4);
  const trackId = view(bytes).getUint32(idAt);
  const trex = children(bytes, mvex).find((b) => b.type === 'trex' && view(bytes).getUint32(within(b, fields(b), 4)) === trackId);
  if (!trex) throw fault();

  const timescale = timescaleOf(bytes, mdhd);
  const fragments = [];
  top.forEach((box, index) => {
    if (box.type !== 'moof') return;
    const mdat = top[index + 1];
    const trafs = children(bytes, box).filter((b) => b.type === 'traf');
    const tfdt = child(bytes, trafs[0], 'tfdt');
    if (mdat?.type !== 'mdat' || !trafs.length || !tfdt || !timescale) throw fault();
    const time = readTime(bytes, tfdt, fields(tfdt), versionOf(bytes, tfdt) === 1);
    fragments.push({ moof: box, mdat, trafs, seconds: time / timescale });
  });
  if (!fragments.length) throw fault();
  return { bytes, ftyp, moov, mvhd, mvex, trak, tkhd, idAt, trackId, trex, movieScale: timescaleOf(bytes, mvhd), fragments };
}

function box(type, pieces) {
  const size = 8 + pieces.reduce((sum, piece) => sum + piece.length, 0);
  const out = new Uint8Array(size);
  view(out).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let at = 8;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

const slice = (bytes, b) => bytes.subarray(b.start, b.end);

// One length from the sound's movie time scale into the picture's. All ones means the length
// isn't known, and stays so; a 32-bit one too long for the new scale becomes that too.
function rescaleTime(bytes, box, at, wide, from, to) {
  const v = view(bytes);
  within(box, at, wide ? 8 : 4);
  if (wide) {
    const value = v.getBigUint64(at);
    if (value !== 0xffffffffffffffffn) v.setBigUint64(at, BigInt(Math.min(Math.round((Number(value) * to) / from), Number.MAX_SAFE_INTEGER)));
  } else {
    const value = v.getUint32(at);
    if (value !== 0xffffffff) v.setUint32(at, Math.min(Math.round((value * to) / from), 0xffffffff));
  }
}

// The sound track's length and edit list from its movie's time scale into the picture's.
function rescale(file, scale) {
  const { bytes, tkhd } = file;
  if (scale === file.movieScale) return;
  if (!file.movieScale) throw fault();
  const wide = versionOf(bytes, tkhd) === 1;
  // tkhd: times, track id and a reserved word, then the length.
  rescaleTime(bytes, tkhd, fields(tkhd) + (wide ? 24 : 16), wide, file.movieScale, scale);
  const elst = path(bytes, file.trak, 'edts', 'elst');
  if (!elst) return;
  const elstWide = versionOf(bytes, elst) === 1;
  const size = elstWide ? 20 : 12;
  const count = view(bytes).getUint32(within(elst, fields(elst), 4));
  for (let entry = 0, at = fields(elst) + 4; entry < count; entry++, at += size) {
    rescaleTime(bytes, elst, at, elstWide, file.movieScale, scale);
  }
}

// Pieces of one MP4 holding both tracks. With no sound, the picture file is already one.
export function mergeTracks(pictureBytes, soundBytes) {
  const picture = parse(pictureBytes);
  if (!soundBytes) return [pictureBytes];
  const sound = parse(soundBytes);
  const soundId = picture.trackId + 1;
  const sv = view(sound.bytes);

  sv.setUint32(sound.idAt, soundId);
  sv.setUint32(fields(sound.trex), soundId);
  rescale(sound, picture.movieScale);
  for (const fragment of sound.fragments) {
    for (const traf of fragment.trafs) {
      const tfhd = child(sound.bytes, traf, 'tfhd');
      if (!tfhd) throw fault();
      sv.setUint32(within(tfhd, fields(tfhd), 4), soundId);
    }
  }

  const pb = picture.bytes;
  const moovPieces = children(pb, picture.moov).flatMap((b) => {
    if (b.type === 'mvhd') {
      // The next track id ends the box: after the times, rate, volume, matrix and 24 bytes
      // reserved.
      const mvhd = slice(pb, b).slice();
      const at = within({ end: mvhd.length }, b.header + 4 + (versionOf(pb, b) === 1 ? 104 : 92), 4);
      view(mvhd).setUint32(at, soundId + 1);
      return [mvhd];
    }
    if (b.type === 'trak') return [slice(pb, b), slice(sound.bytes, sound.trak)];
    if (b.type === 'mvex') return [box('mvex', [...children(pb, b).map((c) => slice(pb, c)), slice(sound.bytes, sound.trex)])];
    return [slice(pb, b)];
  });
  const head = [slice(pb, picture.ftyp), box('moov', moovPieces)];

  // Time order (the sort is stable, so the picture comes first on a tie), then each fragment
  // numbered and its base offset, if it has one, moved to where its moof now starts.
  const order = [...picture.fragments.map((f) => ({ ...f, file: picture })), ...sound.fragments.map((f) => ({ ...f, file: sound }))]
    .sort((a, b) => a.seconds - b.seconds);
  let position = head.reduce((sum, piece) => sum + piece.length, 0);
  const pieces = [...head];
  order.forEach((fragment, index) => {
    const { bytes } = fragment.file;
    const v = view(bytes);
    const mfhd = child(bytes, fragment.moof, 'mfhd');
    if (!mfhd) throw fault();
    v.setUint32(within(mfhd, fields(mfhd), 4), index + 1);
    for (const traf of fragment.trafs) {
      const tfhd = child(bytes, traf, 'tfhd');
      if (!tfhd) throw fault();
      // Flag 1: an 8-byte base offset follows the track id.
      if (v.getUint32(within(tfhd, tfhd.start + tfhd.header, 4)) & 1) {
        const at = within(tfhd, fields(tfhd) + 4, 8);
        v.setBigUint64(at, v.getBigUint64(at) - BigInt(fragment.moof.start) + BigInt(position));
      }
    }
    pieces.push(slice(bytes, fragment.moof), slice(bytes, fragment.mdat));
    position += fragment.mdat.end - fragment.moof.start;
  });
  return pieces;
}
