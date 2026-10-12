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

// A small manifest with copies in the order given, ids r<label>.
const mpd = (labels, { before = '' } = {}) => `<?xml version="1.0"?><MPD><Period>${before}<AdaptationSet contentType="video">${labels
  .map((label) => `<Representation id="r${label}" mimeType="video/mp4" FBQualityLabel="${label}p"><BaseURL>https://cdn.example.invalid/${label}.mp4</BaseURL></Representation>`)
  .join('')}</AdaptationSet><AdaptationSet contentType="audio"><Representation id="ra" mimeType="audio/mp4"/></AdaptationSet></Period></MPD>`;
const labelsIn = (xml) => [...xml.matchAll(/FBQualityLabel="(\d+)p"/g)].map((m) => Number(m[1]));
const entry = (ids) => ({ video_id: '1', initial_representation_ids: [], representations: ids.map((id) => ({ representation_id: id, mime_type: id === 'ra' ? 'audio/mp4' : 'video/mp4' })) });

test("a copy in the list that the manifest never named goes too, and a list left with no kept copy waits", async () => {
  const [first] = await prefetchLines();
  listOf(first)[0].representations.push({ representation_id: '999999999v', mime_type: 'video/mp4' });
  capAnswer(first, '360', createCopyBook());
  assert.deepEqual(copiesOf(first, 0), manifestCopies(first), 'the stray copy is gone');
  // The best choice keeps 1080p, and this list doesn't have it.
  const [again] = await prefetchLines();
  const list = listOf(again)[0];
  list.representations = list.representations.filter((copy) => copy.representation_id !== '353597569v');
  assert.deepEqual(capAnswer(again, 'highest', createCopyBook()), { videos: 1, changed: true });
  assert.deepEqual(listOf(again), [], 'no list with sound only');
});

test('a full book makes room between sets, never halfway through one', async () => {
  const book = createCopyBook();
  book.makeRoom(0);
  for (let i = 0; i < 4996; i++) book.keep(`old${i}`);
  const [first] = await prefetchLines();
  capAnswer(first, 'highest', book);
  assert.deepEqual(copiesOf(first, 0), ['353597569v', '367598183a'], 'every drop from the manifest still applies');
  assert.equal(book.kept('old0'), false, 'the old copies went first');
  assert.equal(book.kept('old4995'), true, 'only as many as needed');
});

test('a full book forgets the oldest copies first, only as many as it needs, never the answer being read', () => {
  const book = createCopyBook();
  book.nextAnswer();
  for (let i = 0; i < 5000; i++) book.keep(`old${i}`);
  book.nextAnswer();
  book.makeRoom(3);
  assert.deepEqual(['old0', 'old1', 'old2', 'old3', 'old4999'].map((id) => book.kept(id)), [false, false, false, true, true]);
  for (const id of ['new0', 'new1', 'new2']) book.keep(id, 720);
  // An answer's own copies stay, even asked for more room than the book has.
  book.makeRoom(5000);
  assert.deepEqual(['old4999', 'new0', 'new2'].map((id) => book.kept(id)), [false, true, true]);
  assert.equal(book.quality('new1'), 720);
});

test("the line before the one that fills the book keeps its videos, so their lists on later lines still get trimmed", () => {
  const book = createCopyBook();
  for (let i = 0; i < 4994; i++) book.keep(`other${i}`);
  // Line one: a video capped at 480p.
  capAnswer({ data: { a: { dash_manifest: mpd([1080, 720, 480, 360]) } } }, '480', book);
  // Line two's video fills the book.
  capAnswer({ data: { b: { dash_manifest: mpd([1080, 720, 480, 360]).replace(/id="r/g, 'id="s') } } }, '480', book);
  assert.equal(book.kept('other0'), false);
  // Line three repeats line one's list, as every streamed line after the manifest does.
  const later = { extensions: { all_video_dash_prefetch_representations: [{ ...entry(['r1080', 'r720', 'r480', 'r360', 'ra']), initial_representation_ids: ['r1080', 'ra'] }] } };
  capAnswer(later, '480', book);
  const [list] = later.extensions.all_video_dash_prefetch_representations;
  assert.deepEqual(list.representations.map((copy) => copy.representation_id), ['r480', 'r360', 'ra']);
  assert.deepEqual(list.initial_representation_ids, ['r480', 'ra']);
});

test('a dropped copy is swapped for the best one kept, in whatever order the manifest lists them', () => {
  const book = createCopyBook();
  const capped = capManifest(mpd([1080, 720, 480, 360]), '480', book);
  assert.deepEqual(labelsIn(capped), [480, 360]);
  assert.equal(book.instead('r720'), 'r480');
  assert.equal(book.instead('r1080'), 'r480');
  assert.equal(book.instead('ra'), null, 'sound is never in the book');
  const picks = { dash_prefetch_experimental: ['r1080', 'ra'], all_video_dash_prefetch_representations: [{ ...entry(['r1080', 'r720', 'r480', 'r360', 'ra']), initial_representation_ids: ['r1080', 'ra'] }] };
  assert.deepEqual(capAnswer(picks, '480', book), { videos: 0, changed: true });
  assert.deepEqual(picks.dash_prefetch_experimental, ['r480', 'ra']);
  assert.deepEqual(picks.all_video_dash_prefetch_representations[0].initial_representation_ids, ['r480', 'ra']);
});

test("a full book never forgets a video from the answer it's reading, so its list still gets trimmed", () => {
  const book = createCopyBook();
  for (let i = 0; i < 4996; i++) book.keep(`old${i}`);
  const second = mpd([1080, 720, 360]).replace(/id="r/g, 'id="s');
  const answer = {
    data: { a: { dash_manifest: mpd([1080, 720, 360]) }, b: { dash_manifest: second } },
    extensions: { all_video_dash_prefetch_representations: [
      { ...entry(['r1080', 'r720', 'r360', 'ra']), initial_representation_ids: ['r1080', 'ra'] },
      { ...entry(['s1080', 's720', 's360', 'sa']), initial_representation_ids: ['s1080', 'sa'] },
    ] },
  };
  answer.extensions.all_video_dash_prefetch_representations[1].representations[3].mime_type = 'audio/mp4';
  assert.deepEqual(capAnswer(answer, '720', book), { videos: 2, changed: true });
  const lists = answer.extensions.all_video_dash_prefetch_representations;
  assert.deepEqual(lists.map((list) => list.representations.map((copy) => copy.representation_id)), [['r720', 'r360', 'ra'], ['s720', 's360', 'sa']]);
  assert.deepEqual(lists.map((list) => list.initial_representation_ids), [['r720', 'ra'], ['s720', 'sa']]);
  assert.equal(book.kept('old1'), false, "earlier answers' copies made the room");
});

test("a first copy swapped for one the list doesn't carry becomes the best kept copy it does", () => {
  const book = createCopyBook();
  capManifest(mpd([1080, 720, 480, 360]), '480', book);
  const picks = { all_video_dash_prefetch_representations: [{ ...entry(['r1080', 'r360', 'ra']), initial_representation_ids: ['r1080', 'ra'] }] };
  capAnswer(picks, '480', book);
  assert.deepEqual(picks.all_video_dash_prefetch_representations[0].representations.map((copy) => copy.representation_id), ['r360', 'ra']);
  assert.deepEqual(picks.all_video_dash_prefetch_representations[0].initial_representation_ids, ['r360', 'ra'], 'never sound only');
});

test('a first copy the manifest never named becomes the best kept copy too', () => {
  const book = createCopyBook();
  capManifest(mpd([1080, 720, 480, 360]), '480', book);
  const picks = { all_video_dash_prefetch_representations: [{ ...entry(['r999', 'r480', 'r360', 'ra']), initial_representation_ids: ['r999', 'ra'] }] };
  capAnswer(picks, '480', book);
  const [list] = picks.all_video_dash_prefetch_representations;
  assert.deepEqual(list.representations.map((copy) => copy.representation_id), ['r480', 'r360', 'ra']);
  assert.deepEqual(list.initial_representation_ids, ['r480', 'ra'], 'never sound only');
});

test('an empty set that closes itself leaves the next set to be capped', () => {
  const xml = mpd([360, 720, 1080], { before: '<AdaptationSet contentType="text" mimeType="text/vtt"/>' });
  assert.deepEqual(labelsIn(capManifest(xml, 'highest')), [1080]);
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
