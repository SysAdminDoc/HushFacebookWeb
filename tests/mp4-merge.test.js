// Joining a DASH picture copy and its sound copy into one MP4 without re-encoding.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeTracks } from '../src/core/mp4-merge.js';
import { boxes, inside, join, text, trackFile, wide, word } from './helpers/mp4.js';

// Where a full box's fields start, after its header, version and flags.
const fields = (b) => b.body + 4;

function read(bytes) {
  const top = boxes(bytes);
  const moov = top.find((b) => b.type === 'moov');
  const traks = inside(bytes, moov, 'trak');
  const moofs = top.filter((b) => b.type === 'moof');
  const tfhdOf = (moof) => inside(bytes, inside(bytes, moof, 'traf')[0], 'tfhd')[0];
  return {
    types: top.map((b) => b.type),
    nextTrack: word(bytes, inside(bytes, moov, 'mvhd')[0].end - 4),
    trackIds: traks.map((trak) => word(bytes, fields(inside(bytes, trak, 'tkhd')[0]) + 8)),
    trexIds: inside(bytes, inside(bytes, moov, 'mvex')[0], 'trex').map((trex) => word(bytes, fields(trex))),
    order: top.filter((b) => b.type === 'mdat').map((b) => text(bytes, b)),
    sequence: moofs.map((moof) => word(bytes, fields(inside(bytes, moof, 'mfhd')[0]))),
    fragmentTracks: moofs.map((moof) => word(bytes, fields(tfhdOf(moof)))),
    // Each base offset next to where its moof now starts, for fragments that carry one.
    offsets: moofs.filter((moof) => word(bytes, tfhdOf(moof).body) & 1).map((moof) => [wide(bytes, fields(tfhdOf(moof)) + 4), moof.start]),
    traks: traks.map((trak) => ({ bytes, trak })),
  };
}

test('a picture and its sound become one file with both tracks, the fragments in time order', () => {
  // The picture counts 15360 a second, the sound 44100, and both start at 0.
  const picture = trackFile({ id: 1, mediaScale: 15360, fragments: [[0, 'P0'], [30720, 'P2'], [61440, 'P4']] });
  const sound = trackFile({ id: 1, mediaScale: 44100, edit: 3000, fragments: [[0, 'S0'], [110250, 'S2.5'], [220500, 'S5']] });
  const out = read(join(mergeTracks(picture, sound)));
  assert.deepEqual(out.types, ['ftyp', 'moov', ...Array(6).fill(['moof', 'mdat']).flat()], "each file's sidx only indexes that file, so both go");
  assert.deepEqual(out.order, ['P0', 'S0', 'P2', 'S2.5', 'P4', 'S5'], 'the picture comes first on a tie');
  assert.deepEqual(out.sequence, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(out.trackIds, [1, 2], 'the sound takes the next track id');
  assert.deepEqual(out.trexIds, [1, 2]);
  assert.deepEqual(out.fragmentTracks, [1, 2, 1, 2, 1, 2]);
  assert.equal(out.nextTrack, 3);
  const [, soundTrak] = out.traks;
  const { bytes } = soundTrak;
  const elst = inside(bytes, inside(bytes, soundTrak.trak, 'edts')[0], 'elst')[0];
  assert.equal(word(bytes, fields(elst) + 4), 3000, 'the same movie time scale leaves the edit list alone');
  assert.equal(word(bytes, fields(inside(bytes, soundTrak.trak, 'tkhd')[0]) + 16), 8000);
});

test('the sound keeps its own place when the picture is not track 1', () => {
  const picture = trackFile({ id: 3, fragments: [[0, 'P']] });
  const sound = trackFile({ id: 7, mediaScale: 48000, fragments: [[0, 'S']] });
  const out = read(join(mergeTracks(picture, sound)));
  assert.deepEqual(out.trackIds, [3, 4]);
  assert.deepEqual(out.trexIds, [3, 4]);
  assert.deepEqual(out.fragmentTracks, [3, 4]);
  assert.equal(out.nextTrack, 5);
});

test('a base offset into the whole file moves with its fragment, 64-bit sizes included', () => {
  // ffmpeg's default output: every tfhd says where its moof starts in its own file.
  const picture = trackFile({ fragments: [[0, 'P0'], [30720, 'P2']], absolute: true, largeMdat: true });
  const sound = trackFile({ mediaScale: 44100, fragments: [[0, 'S0'], [88200, 'S2']], absolute: true });
  const out = read(join(mergeTracks(picture, sound)));
  assert.deepEqual(out.order, ['P0', 'S0', 'P2', 'S2']);
  assert.equal(out.offsets.length, 4);
  for (const [offset, start] of out.offsets) assert.equal(offset, start);
});

test("the sound's length and edit list move to the picture's movie time scale", () => {
  for (const version of [0, 1]) {
    const picture = trackFile({ movieScale: 1000, fragments: [[0, 'P']] });
    // 8 seconds counted 600 a second, with an edit 5 seconds long.
    const sound = trackFile({ movieScale: 600, length: 4800, edit: 3000, version, mediaScale: 44100, fragments: [[0, 'S']] });
    const out = read(join(mergeTracks(picture, sound)));
    const { bytes, trak } = out.traks[1];
    const tkhd = inside(bytes, trak, 'tkhd')[0];
    const elst = inside(bytes, inside(bytes, trak, 'edts')[0], 'elst')[0];
    // Version 1 has 64-bit times, so the track id and the length sit further in.
    const time = (at) => (version === 1 ? wide(bytes, at) : word(bytes, at));
    assert.equal(word(bytes, fields(tkhd) + (version === 1 ? 16 : 8)), 2, `version ${version} track id`);
    assert.equal(time(fields(tkhd) + (version === 1 ? 24 : 16)), 8000, `version ${version} length`);
    assert.equal(time(fields(elst) + 4), 5000, `version ${version} edit`);
  }
});

test('version 1 movie and media headers and a version 0 fragment time read the same', () => {
  const picture = trackFile({ headerVersion: 1, tfdtVersion: 0, fragments: [[0, 'P0'], [30720, 'P2']] });
  const sound = trackFile({ headerVersion: 1, movieScale: 600, length: 4800, mediaScale: 44100, fragments: [[0, 'S0'], [66150, 'S1.5']] });
  const out = read(join(mergeTracks(picture, sound)));
  assert.deepEqual(out.order, ['P0', 'S0', 'S1.5', 'P2']);
  assert.equal(out.nextTrack, 3);
  const { bytes, trak } = out.traks[1];
  assert.equal(word(bytes, fields(inside(bytes, trak, 'tkhd')[0]) + 16), 8000, 'the movie time scale came from the version 1 mvhd');
});

test('a last mdat sized "to the end of the file" gets its real size once fragments follow it', () => {
  const picture = trackFile({ fragments: [[0, 'P0'], [30720, 'P2']], openMdat: true });
  const sound = trackFile({ mediaScale: 44100, fragments: [[0, 'S0'], [110250, 'S2.5']], openMdat: true });
  assert.deepEqual(read(join(mergeTracks(picture, sound))).order, ['P0', 'S0', 'P2', 'S2.5']);
});

test("a sound length that isn't known stays unknown, and one too long for 32 bits stops at the most", () => {
  const picture = trackFile({ movieScale: 90000, fragments: [[0, 'P']] });
  const lengthOf = (sound, version) => {
    const { bytes, trak } = read(join(mergeTracks(picture.slice(), sound))).traks[1];
    const at = fields(inside(bytes, trak, 'tkhd')[0]) + (version === 1 ? 24 : 16);
    return version === 1 ? new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(at) : word(bytes, at);
  };
  // A finer scale than the picture's, so a real length would shrink.
  assert.equal(lengthOf(trackFile({ movieScale: 180000, length: 0xffffffff, fragments: [[0, 'S']] }), 0), 0xffffffff);
  assert.equal(lengthOf(trackFile({ movieScale: 600, version: 1, headerVersion: 1, length: 0xffffffffffffffffn, fragments: [[0, 'S']] }), 1), 0xffffffffffffffffn);
  const long = trackFile({ movieScale: 600, length: 0x7fffffff, edit: 0x7fffffff, fragments: [[0, 'S']] });
  assert.equal(lengthOf(long, 0), 0xffffffff, '150 times longer, which a 32-bit length cannot hold');
});

test('with no sound the picture file is saved as it is', () => {
  const picture = trackFile({ fragments: [[0, 'P']] });
  const pieces = mergeTracks(picture, null);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0], picture);
});

test("files that don't look like one DASH track each are refused", () => {
  const good = () => trackFile({ fragments: [[0, 'S']] });
  const broken = {
    'two tracks': trackFile({ traks: 2 }),
    'no mvex': trackFile({ mvex: false }),
    'no tfdt': trackFile({ tfdt: false }),
    'no fragments': trackFile({ fragments: [] }),
    'a box running past the end': trackFile().subarray(0, 60),
    'a base offset flag with no room for the offset': trackFile({ shortTfhd: true }),
    'a fragment with no tfhd': trackFile({ noTfhd: true }),
    'a moof with no mdat': (() => {
      const bytes = trackFile({ fragments: [[0, 'A'], [1, 'B']] });
      return bytes.subarray(0, boxes(bytes).at(-1).start);
    })(),
  };
  for (const [what, bytes] of Object.entries(broken)) {
    assert.throws(() => mergeTracks(bytes, good()), /not one fragmented track/, `${what}, as the picture`);
    assert.throws(() => mergeTracks(trackFile(), bytes), /not one fragmented track/, `${what}, as the sound`);
  }
  // Only the sound's lengths are rescaled, so only there do these show.
  const counted = trackFile({ movieScale: 600, edit: 3000, elstCount: 2 });
  assert.throws(() => mergeTracks(trackFile(), counted), /not one fragmented track/, 'an edit list counting entries it lacks');
  assert.throws(() => mergeTracks(trackFile(), trackFile({ movieScale: 0 })), /not one fragmented track/, 'a movie time scale of 0');
});
