import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutFacebookId } from '../src/core/jpeg-meta.js';
import { FACEBOOK_ID, ascii, iptc, jpeg, photoshop, resource, segment, SCAN } from './helpers/jpeg.js';

const has = (bytes, text) => Buffer.from(bytes).includes(Buffer.from(text, 'latin1'));
const JFIF = segment(0xe0, ascii('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'));
const EXIF = segment(0xe1, ascii('Exif\0\0MM\0\x2a\0\0\0\x08\0\0'));
const TABLES = segment(0xdb, [0, ...Array.from({ length: 64 }, (_, index) => index + 1)]);
const tail = (bytes) => Buffer.from(bytes.subarray(Buffer.from(bytes).indexOf(Buffer.from([0xff, 0xda]))));

test("Facebook's own layout, one IPTC field in APP13, loses the whole segment and nothing else", () => {
  // As served 2026-11-15: the field, then one zero byte inside the resource's data.
  const app13 = segment(0xed, photoshop(resource(0x0404, [...iptc(2, 40, FACEBOOK_ID), 0])));
  const served = jpeg(JFIF, app13, TABLES);
  assert.ok(has(served, 'FBMD'));
  const saved = withoutFacebookId(served);
  assert.equal(has(saved, 'FBMD'), false);
  assert.equal(has(saved, 'Photoshop 3.0'), false, 'nothing is left in the APP13, so it goes');
  assert.deepEqual([...saved], [...jpeg(JFIF, TABLES)]);
  assert.equal(saved.length, served.length - app13.length);
  assert.deepEqual(tail(saved), tail(served), 'the scan and the end of the file are untouched');
});

test('the rest of the IPTC record and the other resources stay, and the stale digest goes', () => {
  const resolution = resource(0x03ed, [0, 0x48, 0, 0, 0, 1, 0, 1, 0, 0x48, 0, 0, 0, 1, 0, 1]);
  const digest = resource(0x0425, Array.from({ length: 16 }, (_, index) => index));
  const record = [...iptc(2, 0, [0, 4]), ...iptc(2, 5, 'Harbor'), ...iptc(2, 40, FACEBOOK_ID), ...iptc(2, 116, 'Pat')];
  const served = jpeg(JFIF, EXIF, segment(0xed, photoshop(resolution, resource(0x0404, record, 'IPTC'), digest)), TABLES);
  const saved = withoutFacebookId(served);
  assert.equal(has(saved, 'FBMD'), false);
  const kept = [...iptc(2, 0, [0, 4]), ...iptc(2, 5, 'Harbor'), ...iptc(2, 116, 'Pat')];
  assert.deepEqual([...saved], [...jpeg(JFIF, EXIF, segment(0xed, photoshop(resolution, resource(0x0404, kept, 'IPTC'))), TABLES)]);
  assert.equal(withoutFacebookId(saved), saved, 'a cleaned file reads cleanly and has nothing more to take out');
});

test('a record left with only its version, or a field in the long length form, is still handled', () => {
  const versionOnly = jpeg(JFIF, segment(0xed, photoshop(resource(0x0404, [...iptc(2, 0, [0, 4]), ...iptc(2, 40, FACEBOOK_ID)]))), TABLES);
  assert.deepEqual([...withoutFacebookId(versionOnly)], [...jpeg(JFIF, TABLES)]);

  // 0x8004: the length takes the next four bytes.
  const value = ascii(FACEBOOK_ID);
  const long = [0x1c, 2, 40, 0x80, 0x04, 0, 0, 0, value.length, ...value];
  const other = resource(0x03ed, [1, 2]);
  const served = jpeg(segment(0xed, photoshop(other, resource(0x0404, long))), TABLES);
  assert.deepEqual([...withoutFacebookId(served)], [...jpeg(segment(0xed, photoshop(other)), TABLES)]);
});

test('extra 0xFF bytes before a marker stay with the segment they come before', () => {
  const app13 = segment(0xed, photoshop(resource(0x0404, iptc(2, 40, FACEBOOK_ID))));
  const served = jpeg([0xff, 0xff, ...JFIF], app13, [0xff, ...TABLES]);
  assert.deepEqual([...withoutFacebookId(served)], [...jpeg([0xff, 0xff, ...JFIF], [0xff, ...TABLES])]);
});

test('anything that is not a JPEG with the ID in it comes back as the same bytes', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal(withoutFacebookId(png), png);
  const plain = jpeg(JFIF, EXIF, TABLES);
  assert.equal(withoutFacebookId(plain), plain, 'no APP13');
  const noId = jpeg(segment(0xed, photoshop(resource(0x0404, iptc(2, 5, 'Harbor')))), TABLES);
  assert.equal(withoutFacebookId(noId), noId, 'APP13 with no 2:40');
  const otherApp13 = jpeg(segment(0xed, ascii('Adobe_CM\0\x01')), TABLES);
  assert.equal(withoutFacebookId(otherApp13), otherApp13, 'an APP13 that is not a Photoshop block');
  for (const tiny of [new Uint8Array(0), Uint8Array.from([0xff, 0xd8])]) assert.equal(withoutFacebookId(tiny), tiny);
});

test("a file that doesn't read cleanly is saved as served, ID and all", () => {
  const field = iptc(2, 40, FACEBOOK_ID);
  const broken = {
    'a field longer than its resource': (() => {
      const bad = [...field];
      bad[4] += 40;
      return jpeg(segment(0xed, photoshop(resource(0x0404, bad))), TABLES);
    })(),
    'a stray byte between fields': jpeg(segment(0xed, photoshop(resource(0x0404, [...field, 7, ...iptc(2, 5, 'x')]))), TABLES),
    'a resource without its 8BIM': jpeg(segment(0xed, photoshop(resource(0x0404, field)).map((value, index) => (index === 14 ? 0x37 : value))), TABLES),
    'a resource size past the segment': (() => {
      const block = photoshop(resource(0x0404, field));
      block[14 + 4 + 2 + 2 + 3] += 9;
      return jpeg(segment(0xed, block), TABLES);
    })(),
    'a segment length past the end': (() => {
      const bytes = jpeg(JFIF, segment(0xed, photoshop(resource(0x0404, field))));
      return bytes.subarray(0, bytes.length - SCAN.length - 10);
    })(),
    'an end of image before the scan': Uint8Array.from([0xff, 0xd8, ...segment(0xed, photoshop(resource(0x0404, field))), 0xff, 0xd9]),
    'a byte that is not a marker': Uint8Array.from([0xff, 0xd8, 0x00, ...segment(0xed, photoshop(resource(0x0404, field))), ...SCAN]),
  };
  for (const [what, bytes] of Object.entries(broken)) {
    assert.ok(has(bytes, 'FBMD'), what);
    assert.equal(withoutFacebookId(bytes), bytes, what);
  }
});
