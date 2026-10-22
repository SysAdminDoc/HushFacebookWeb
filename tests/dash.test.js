// Reading a video's DASH manifest for the copies it offers, and picking the one to save.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureLines, parseLine } from './helpers/fixtures.js';
import { durationOf, pickCopies, readManifest } from '../src/core/dash.js';

const whole = (url) => `<BaseURL>${url}</BaseURL><SegmentBase indexRange="824-1023" timescale="15360"><Initialization range="0-823"/></SegmentBase>`;
const rep = (id, { bandwidth = 100000, label = null, width = 720, height = 1280, codecs = 'av01.0.05M.08', mime = null, body = whole(`https://video.example.invalid/${id}.mp4?a=1&amp;b=2`) } = {}) =>
  `<Representation id="${id}" bandwidth="${bandwidth}" codecs="${codecs}"${mime ? ` mimeType="${mime}"` : ''} width="${width}" height="${height}"${label ? ` FBQualityLabel="${label}"` : ''}>${body}</Representation>`;
const set = (attributes, ...representations) => `<AdaptationSet ${attributes}>${representations.join('')}</AdaptationSet>`;
const mpd = (sets, { type = 'static', duration = 'PT10S' } = {}) =>
  `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="${type}"${duration ? ` mediaPresentationDuration="${duration}"` : ''}><Period id="0">${sets.join('')}</Period></MPD>`;

test('a manifest length reads as seconds', () => {
  assert.equal(durationOf('PT28.552799S'), 28.552799);
  assert.equal(durationOf('PT1H2M3.5S'), 3723.5);
  assert.equal(durationOf('PT2M'), 120);
  for (const nothing of ['PT', '', null, undefined, 'P1D', '28 seconds']) assert.equal(durationOf(nothing), null, String(nothing));
});

test("a captured manifest lists every picture copy best first, and the sound's", async () => {
  const [line] = await fixtureLines('video-delivery-dash.jsonl');
  const result = parseLine(line).data.video.videoDeliveryResponseFragment.videoDeliveryResponseResult;
  const manifest = readManifest(result.dash_manifests[0].manifest_xml);
  assert.equal(manifest.live, false);
  assert.equal(manifest.duration, 28.552799);
  assert.deepEqual(manifest.video.map((copy) => copy.quality), [1080, 720, 640, 540, 480, 360, 270, 240],
    "Facebook's own label, since its smaller copies are often coded at 720 wide");
  assert.equal(manifest.video[0].width, 1080);
  assert.ok(manifest.video.every((copy) => copy.url.startsWith('https://') && copy.codecs.startsWith('av01')));
  assert.equal(manifest.audio.codecs, 'mp4a.40.5');
  assert.equal(new Set([...manifest.video.map((copy) => copy.url), manifest.audio.url]).size, 9, 'each copy is its own file');
});

test('only whole files count, and anything that is not a manifest reads as nothing', () => {
  const manifest = readManifest(mpd([
    set('contentType="video"',
      rep('good', { label: '720p', bandwidth: 900000 }),
      rep('relative', { body: whole('v/relative.mp4') }),
      rep('plain-http', { body: whole('http://video.example.invalid/x.mp4') }),
      rep('two-bases', { body: `<BaseURL>https://a.example.invalid/1.mp4</BaseURL>${whole('https://a.example.invalid/2.mp4')}` }),
      rep('two-bases-one-with-attributes', { body: `<BaseURL serviceLocation="a">https://a.example.invalid/4.mp4</BaseURL>${whole('https://a.example.invalid/5.mp4')}` }),
      rep('template', { body: '<SegmentTemplate media="$Number$.m4s" initialization="init.m4s"/>' }),
      rep('list', { body: `${whole('https://a.example.invalid/3.mp4')}<SegmentList/>` }),
      rep('unlabeled', { width: 640, height: 360, bandwidth: 300000 })),
    set('mimeType="audio/mp4"', rep('quiet', { bandwidth: 32000, codecs: 'mp4a.40.5' }), rep('loud', { bandwidth: 64000, codecs: 'mp4a.40.2' })),
    set('contentType="text"', rep('captions')),
    set('contentType="video"', '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>', rep('locked', { label: '1080p', bandwidth: 5000000 })),
  ]));
  assert.deepEqual(manifest.video.map((copy) => [copy.url, copy.quality]), [
    ['https://video.example.invalid/good.mp4?a=1&b=2', 720],
    ['https://video.example.invalid/unlabeled.mp4?a=1&b=2', 360],
  ], 'escaped addresses come back whole, a copy with no label goes by its smaller side, and an encrypted one is left out');
  assert.equal(manifest.audio.url, 'https://video.example.invalid/loud.mp4?a=1&b=2', 'the best sound');

  const mime = readManifest(mpd([set('id="0"', rep('typed', { mime: 'video/mp4' }))]));
  assert.equal(mime.video.length, 1, 'the kind can come from the copy itself');
  assert.equal(mime.audio, null, 'a silent video has no sound set');
  assert.equal(mime.duration, 10);
  const periodOnly = mpd([set('contentType="video"', rep('p'))], { duration: null }).replace('<Period id="0">', '<Period id="0" duration="PT12.5S">');
  assert.equal(readManifest(periodOnly).duration, 12.5, "the Period's length when the MPD gives none");

  const live = readManifest(mpd([set('contentType="video"',
    rep('now', { body: '<BaseURL>https://a.example.invalid/live/</BaseURL><SegmentTemplate media="$Number$.m4s"/>' }),
    rep('growing', { body: whole('https://a.example.invalid/live.mp4') }))], { type: 'dynamic', duration: null }));
  assert.deepEqual(live, { live: true, duration: null, video: [], audio: null }, 'a live video offers nothing to save, even a whole file that is still growing');
  for (const nothing of [null, 42, '', '<MPD', '<html></html>']) assert.equal(readManifest(nothing), null, String(nothing));
});

test('the best copy is picked, or the best at 480p or under for smaller files, stepping down past the size limit', () => {
  const copy = (quality, bandwidth) => ({ url: `https://video.example.invalid/${quality}.mp4`, quality, bandwidth });
  // 10 seconds: a copy's estimate is (its bandwidth + the sound's) / 8 * 10 bytes.
  const manifest = { live: false, duration: 10, video: [copy(1080, 7920000), copy(720, 3920000), copy(480, 1520000), copy(360, 720000)], audio: { url: 'https://video.example.invalid/a.mp4', bandwidth: 80000 } };
  assert.deepEqual(pickCopies(manifest), { video: manifest.video[0], audio: manifest.audio, bytes: 10000000 });
  assert.equal(pickCopies(manifest, { quality: 'sd' }).video.quality, 480);
  assert.equal(pickCopies(manifest, { limit: 5000000 }).video.quality, 720);
  assert.equal(pickCopies(manifest, { limit: 5000000 - 1 }).video.quality, 480);
  assert.deepEqual(pickCopies(manifest, { limit: 999999 }), { tooBig: 1000000 }, 'too big says how big the smallest copy is');
  assert.equal(pickCopies({ ...manifest, video: manifest.video.slice(0, 2) }, { quality: 'sd' }).video.quality, 720, 'with nothing that small, the smallest');
  assert.equal(pickCopies({ ...manifest, audio: null }).bytes, 9900000, 'a silent video counts the picture alone');
  assert.deepEqual(pickCopies({ ...manifest, duration: null }, { limit: 1 }), { video: manifest.video[2], audio: manifest.audio, bytes: null },
    "with no length there's no estimate, so it takes the smaller files' copy");
  assert.equal(pickCopies({ ...manifest, video: [copy(1080, 0), ...manifest.video.slice(1)] }).video.quality, 480, 'the same when a copy gives no bandwidth');
  assert.equal(pickCopies({ ...manifest, video: [] }), null);
});
