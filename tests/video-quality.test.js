// Default video quality against two scrubbed video answers from the feed (captured 2026-10-10):
// a DASH manifest with a video set of copies labeled 240p or 270p up to 1080p, and a sound set.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureLines, parseLine } from './helpers/fixtures.js';
import videoQuality, { CHOICES, MARKERS, capAnswer, capManifest, createCopyBook, keepQualities, qualityOf } from '../src/features/playback/video-quality.js';
import { rulesFor } from '../src/core/net/payload.js';

const resultOf = (doc) => doc.data.video.videoDeliveryResponseFragment.videoDeliveryResponseResult;
const manifestOf = (doc) => resultOf(doc).dash_manifests[0].manifest_xml;
const videoLabels = (xml) => [...xml.match(/<AdaptationSet\b[^>]*contentType="video"[\s\S]*?<\/AdaptationSet>/)[0].matchAll(/FBQualityLabel="(\d+)p"/g)].map((m) => Number(m[1]));
const soundSet = (xml) => xml.match(/<AdaptationSet\b[^>]*contentType="audio"[\s\S]*?<\/AdaptationSet>/)[0];

test('the captured manifests list their copies by label, with sound in a set of its own', async () => {
  const lines = await fixtureLines('video-delivery-dash.jsonl');
  assert.equal(lines.length, 2);
  assert.deepEqual(videoLabels(manifestOf(parseLine(lines[0]))), [240, 270, 360, 480, 540, 640, 720, 1080]);
  assert.deepEqual(videoLabels(manifestOf(parseLine(lines[1]))), [270, 360, 480, 540, 640, 720, 1080]);
  for (const line of lines) assert.ok(MARKERS.some((marker) => line.includes(marker)));
});

test('a cap keeps the copies at or under it, and the best choice keeps only the top one', async () => {
  const [line] = await fixtureLines('video-delivery-dash.jsonl');
  const xml = manifestOf(parseLine(line));
  assert.deepEqual(videoLabels(capManifest(xml, '480')), [240, 270, 360, 480]);
  assert.deepEqual(videoLabels(capManifest(xml, '360')), [240, 270, 360]);
  assert.deepEqual(videoLabels(capManifest(xml, '720')), [240, 270, 360, 480, 540, 640, 720]);
  assert.deepEqual(videoLabels(capManifest(xml, 'highest')), [1080]);
  assert.equal(capManifest(xml, '1080'), xml, 'nothing above 1080p, so the manifest is the same string');
  for (const choice of ['360', 'highest']) {
    const capped = capManifest(xml, choice);
    assert.equal(soundSet(capped), soundSet(xml), 'the sound is left alone');
    assert.match(capped, /^<\?xml[\s\S]*<\/MPD>\s*$/, 'still a whole manifest');
    assert.equal((capped.match(/<Representation\b/g) ?? []).length, (capped.match(/<\/Representation>/g) ?? []).length);
  }
});

test('a video with nothing under the cap keeps its smallest copy', () => {
  assert.deepEqual(keepQualities([480, 720, 1080], '360'), [true, false, false]);
  assert.deepEqual(keepQualities([null, 720, 1080], '360'), [false, true, false]);
  assert.deepEqual(keepQualities([null, null], 'highest'), [true, true], 'copies without a label or size are left as they are');
  assert.deepEqual(keepQualities([360, 720], 'auto'), [true, true]);
  assert.equal(qualityOf('<Representation width="1280" height="720" mimeType="video/mp4">'), 720);
  assert.equal(qualityOf('<Representation width="720" height="1280" FBQualityLabel="240p">'), 240);
  assert.equal(qualityOf('<Representation mimeType="audio/mp4">'), null);
});

test("an answer's manifests are capped in place, older answers' dash_manifest too", async () => {
  const lines = await fixtureLines('video-delivery-dash.jsonl');
  const docs = lines.map(parseLine);
  const before = docs.map((doc) => structuredClone(doc));
  assert.equal(capAnswer(docs[0], '480').videos + capAnswer(docs[1], '480').videos, 2);
  assert.deepEqual(videoLabels(manifestOf(docs[1])), [270, 360, 480]);
  // Everything else in the answer is as Facebook sent it.
  const withoutManifests = (result) => Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'dash_manifests'));
  for (const [i, doc] of docs.entries()) {
    assert.deepEqual(withoutManifests(resultOf(doc)), withoutManifests(resultOf(before[i])));
  }
  assert.deepEqual(capAnswer(docs[0], '480'), { videos: 0, changed: false }, 'a second pass changes nothing');
  const legacy = { video: { dash_manifest: manifestOf(before[0]) } };
  assert.deepEqual(capAnswer(legacy, 'highest'), { videos: 1, changed: true });
  assert.deepEqual(videoLabels(legacy.video.dash_manifest), [1080]);
});

// The prefetch fixture is three streamed lines of one feed answer (captured 2026-10-10): the
// first video with its manifest, the second video, and a later line that only repeats the
// prefetch list for both. Copy ids are the same stand-ins in the manifests and the lists.
const prefetchLines = async () => (await fixtureLines('video-prefetch.jsonl')).map(parseLine);
const listOf = (doc) => doc.extensions.all_video_dash_prefetch_representations;
const copiesOf = (doc, n) => listOf(doc)[n].representations.map((copy) => copy.representation_id);
const manifestCopies = (doc) => {
  const xml = doc.data.video.videoDeliveryResponseFragment.videoDeliveryResponseResult.dash_manifests[0].manifest_xml;
  return [...xml.matchAll(/<Representation\b[^>]*?\bid="([^"]+)"/g)].map((m) => m[1]);
};

test('the prefetch lists name the same copies as the manifests, and each video picks one', async () => {
  const [first, second, later] = await prefetchLines();
  assert.deepEqual(copiesOf(first, 0), manifestCopies(first));
  assert.deepEqual(copiesOf(second, 1), manifestCopies(second));
  assert.equal(listOf(later).length, 2);
  assert.equal(later.data.video, undefined, 'the later line has no manifest');
  for (const doc of [first, second]) {
    const [video, sound] = doc.data.video.dash_prefetch_experimental;
    assert.ok(manifestCopies(doc).includes(video) && manifestCopies(doc).includes(sound));
  }
  const lines = await fixtureLines('video-prefetch.jsonl');
  for (const line of lines) assert.ok(MARKERS.some((marker) => line.includes(marker)));
});

test('a cap trims the prefetch lists to the copies the manifests kept, on later lines too', async () => {
  const [first, second, later] = await prefetchLines();
  const book = createCopyBook();
  assert.deepEqual(capAnswer(first, '360', book), { videos: 1, changed: true });
  assert.deepEqual(capAnswer(second, '360', book), { videos: 1, changed: true });
  assert.deepEqual(capAnswer(later, '360', book), { videos: 0, changed: true });
  for (const doc of [later]) {
    assert.deepEqual(copiesOf(doc, 0), manifestCopies(first), 'the first video keeps its 240p, 270p and 360p copies and its sound');
    assert.deepEqual(copiesOf(doc, 1), manifestCopies(second));
  }
  assert.deepEqual(copiesOf(second, 0), manifestCopies(first));
  assert.equal(copiesOf(first, 0).length, 4);
  // The first video's pick was its 360p copy, so it stays. The second picked 540p, which is
  // gone, so it fetches the best copy left, 360p.
  assert.deepEqual(first.data.video.dash_prefetch_experimental, ['666594021v', '367598183a']);
  assert.deepEqual(second.data.video.dash_prefetch_experimental, ['995514668v', '506816057a']);
  assert.ok(manifestCopies(second).includes('995514668v'));
});

test('the best choice leaves one copy in each list and moves both picks to it', async () => {
  const [first, second, later] = await prefetchLines();
  const book = createCopyBook();
  for (const doc of [first, second, later]) capAnswer(doc, 'highest', book);
  assert.deepEqual(copiesOf(later, 0), ['353597569v', '367598183a']);
  assert.deepEqual(copiesOf(later, 1), ['813536959v', '506816057a']);
  assert.deepEqual(first.data.video.dash_prefetch_experimental, ['353597569v', '367598183a']);
  assert.deepEqual(second.data.video.dash_prefetch_experimental, ['813536959v', '506816057a']);
});

// Live on 2026-10-11 (run21) a related video's whole list came before its manifest, and the
// player fetched a 720p copy from it under a 360p cap.
test("a list for a video whose manifest wasn't seen yet is held back, and comes back trimmed", async () => {
  const [first, second, later] = await prefetchLines();
  const book = createCopyBook();
  assert.deepEqual(capAnswer(later, '360', book), { videos: 0, changed: true });
  assert.deepEqual(listOf(later), [], 'its sizes say 720x1280 for most copies, so they are not used to judge it');
  // The second line has the first video's list too, before that video's manifest came.
  capAnswer(second, '360', book);
  assert.deepEqual(listOf(second).map((entry) => entry.representations.length), [3], 'only the second video, already trimmed to 270p and 360p and its sound');
  capAnswer(first, '360', book);
  const again = (await prefetchLines())[2];
  capAnswer(again, '360', book);
  assert.deepEqual(listOf(again).map((entry) => entry.representations.length), [4, 3], 'both, trimmed, once both manifests were seen');
});

test('a list whose manifest kept every copy is left as it came', async () => {
  const [first] = await prefetchLines();
  const before = structuredClone(first);
  assert.deepEqual(capAnswer(first, '1080', createCopyBook()), { videos: 0, changed: false }, 'nothing over 1080p, nothing dropped');
  assert.deepEqual(first, before);
});

test('the feature caps through JSON.parse only, with the chosen quality, and counts videos', async () => {
  const rules = [];
  const rows = [];
  let quality = '360';
  videoQuality.setup({
    net: { transformResponses: (rule) => rules.push(rule) },
    enabled: () => true,
    option: (key) => (key === 'quality' ? quality : undefined),
    diagnostics: { add: (label, read) => rows.push([label, read]), changed() {} },
  });
  const [rule] = rules;
  assert.equal(rule.match({ transport: 'json-parse' }), true);
  assert.equal(rule.match({ transport: 'fetch' }), false);
  const [line] = await fixtureLines('video-delivery-dash.jsonl');
  assert.equal(rulesFor(line, [rule]).length, 1, 'the marker finds the manifest');
  const doc = parseLine(line);
  assert.equal(rule.transform(doc), true);
  assert.deepEqual(videoLabels(manifestOf(doc)), [240, 270, 360]);
  quality = 'highest';
  const next = parseLine(line);
  rule.transform(next);
  assert.deepEqual(videoLabels(manifestOf(next)), [1080]);
  assert.deepEqual(rows.map(([label, read]) => [label, read()]), [['Videos set to your quality', '2']]);
  // The page keeps one book per choice: a later line's list is trimmed by what an earlier line's
  // manifest dropped, and a new choice forgets the old one's drops.
  const [first, , later] = await prefetchLines();
  quality = '360';
  assert.equal(rule.transform(first), true);
  const repeat = structuredClone(later);
  assert.equal(rule.transform(later), true);
  assert.deepEqual(copiesOf(later, 0), manifestCopies(first));
  quality = 'highest';
  assert.equal(rule.transform(repeat), true);
  assert.deepEqual(listOf(repeat), [], 'a new choice judges again from the start, so lists wait for their manifests again');
  assert.equal(videoQuality.default, false);
  assert.equal(videoQuality.needsPage, true);
  assert.deepEqual(CHOICES.map((choice) => choice.value), ['highest', '1080', '720', '480', '360']);
});
