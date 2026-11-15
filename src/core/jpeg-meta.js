// Takes Facebook's ID out of a saved JPEG.
//
// Facebook writes a value starting "FBMD" into the photos it serves, as the IPTC Special
// Instructions field (dataset 2:40). IPTC sits in a Photoshop block ("Photoshop 3.0", then
// "8BIM" resources) inside an APP13 segment near the start of the file. Seen 2026-11-15 on a
// photo from scontent: APP13 held one IPTC resource with that one field and nothing else.
//
// Only the metadata before the picture's scan is read. Everything from the start of scan to the
// end of the file is copied as served, and so is every other segment. When a segment doesn't
// read the way the format says it should, the file comes back unchanged: a photo saved with the
// ID still in it beats no photo.

const SOS = 0xda;
const APP13 = 0xed;
const PHOTOSHOP = [...'Photoshop 3.0\0'].map((char) => char.charCodeAt(0));
const RESOURCE = [0x38, 0x42, 0x49, 0x4d]; // "8BIM"
const IPTC = 0x0404;
// An MD5 of the IPTC record as it was, ID included, so it goes with the ID.
const IPTC_DIGEST = 0x0425;
const IPTC_TAG = 0x1c;

const u16 = (bytes, at) => (bytes[at] << 8) | bytes[at + 1];
const u32 = (bytes, at) => ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
const startsWith = (bytes, at, prefix) => prefix.every((value, index) => bytes[at + index] === value);

function join(pieces) {
  const out = new Uint8Array(pieces.reduce((total, piece) => total + piece.length, 0));
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

// The IPTC datasets as [{ record, dataset, bytes }], or null when they don't read cleanly.
// Zero bytes after the last one are padding, which some writers add (Facebook adds one).
function datasets(data) {
  const found = [];
  let at = 0;
  while (at < data.length) {
    if (data[at] !== IPTC_TAG) return data.subarray(at).every((value) => value === 0) ? found : null;
    if (at + 5 > data.length) return null;
    let length = u16(data, at + 3);
    let header = 5;
    if (length & 0x8000) {
      // The extended form: the low bits say how many bytes the length takes.
      const size = length & 0x7fff;
      if (size < 1 || size > 4 || at + 5 + size > data.length) return null;
      length = 0;
      for (let index = 0; index < size; index++) length = length * 256 + data[at + 5 + index];
      header += size;
    }
    const end = at + header + length;
    if (end > data.length) return null;
    found.push({ record: data[at + 1], dataset: data[at + 2], bytes: data.subarray(at, end) });
    at = end;
  }
  return found;
}

// The IPTC record without 2:40, null to drop it (nothing left but the record version, 2:00),
// or the same array when there was no 2:40. undefined when it doesn't read cleanly.
function cleanIptc(data) {
  const all = datasets(data);
  if (!all) return undefined;
  const kept = all.filter((entry) => !(entry.record === 2 && entry.dataset === 40));
  if (kept.length === all.length) return data;
  if (kept.every((entry) => entry.record === 2 && entry.dataset === 0)) return null;
  return join(kept.map((entry) => entry.bytes));
}

// The Photoshop resources as [{ id, header, data }], or null when they don't read cleanly. A
// resource is "8BIM", its id, a name (a length byte and the name, padded to an even count) and
// a four-byte size, then its data, padded to an even count.
function resources(block) {
  const found = [];
  let at = PHOTOSHOP.length;
  while (at < block.length) {
    if (at + 7 > block.length || !startsWith(block, at, RESOURCE)) return null;
    const nameBytes = (block[at + 6] + 2) & ~1;
    const sizeAt = at + 6 + nameBytes;
    if (sizeAt + 4 > block.length) return null;
    const size = u32(block, sizeAt);
    const dataAt = sizeAt + 4;
    if (dataAt + size > block.length) return null;
    found.push({ id: u16(block, at + 4), header: block.subarray(at, sizeAt), data: block.subarray(dataAt, dataAt + size) });
    at = Math.min(dataAt + size + (size & 1), block.length);
  }
  return found;
}

function resourceBytes({ header, data }) {
  const size = data.length;
  return join([header, new Uint8Array([size >>> 24, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff]), data, new Uint8Array(size & 1)]);
}

// An APP13 segment's contents (after its length) without the ID: the same array when there's
// no ID in it or it doesn't read cleanly, null to drop the segment, or new contents.
function cleanApp13(block) {
  if (!startsWith(block, 0, PHOTOSHOP)) return block;
  const all = resources(block);
  if (!all) return block;
  let changed = false;
  const kept = [];
  for (const resource of all) {
    if (resource.id !== IPTC) {
      kept.push(resource);
      continue;
    }
    const data = cleanIptc(resource.data);
    if (data === undefined) return block;
    if (data === resource.data) {
      kept.push(resource);
      continue;
    }
    changed = true;
    if (data) kept.push({ ...resource, data });
  }
  if (!changed) return block;
  const left = kept.filter((resource) => resource.id !== IPTC_DIGEST);
  if (!left.length) return null;
  return join([block.subarray(0, PHOTOSHOP.length), ...left.map(resourceBytes)]);
}

// The JPEG's bytes without Facebook's ID. Anything that isn't a JPEG, has no ID, or doesn't read
// cleanly comes back as the same array.
export function withoutFacebookId(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const pieces = [bytes.subarray(0, 2)];
  let changed = false;
  let at = 2;
  for (;;) {
    // Fill bytes (extra 0xFF) may come before a marker. They're kept with the segment after them.
    let marker = at;
    while (bytes[marker] === 0xff && bytes[marker + 1] === 0xff) marker++;
    if (marker + 4 > bytes.length || bytes[marker] !== 0xff) return bytes;
    const code = bytes[marker + 1];
    if (code === SOS) {
      pieces.push(bytes.subarray(at));
      break;
    }
    // Before the scan, every marker but SOI and EOI has a length. Those two, or a byte that
    // isn't a marker, mean the file isn't laid out the way this reads it.
    if (code === 0x00 || code === 0xd8 || code === 0xd9 || (code >= 0xd0 && code <= 0xd7) || code === 0x01) return bytes;
    const length = u16(bytes, marker + 2);
    const end = marker + 2 + length;
    if (length < 2 || end > bytes.length) return bytes;
    if (code !== APP13) {
      pieces.push(bytes.subarray(at, end));
      at = end;
      continue;
    }
    const block = bytes.subarray(marker + 4, end);
    const clean = cleanApp13(block);
    if (clean === block) pieces.push(bytes.subarray(at, end));
    else {
      changed = true;
      // The fill bytes go with the dropped segment.
      if (clean) pieces.push(bytes.subarray(at, marker + 2), new Uint8Array([(clean.length + 2) >> 8, (clean.length + 2) & 0xff]), clean);
    }
    at = end;
  }
  return changed ? join(pieces) : bytes;
}
