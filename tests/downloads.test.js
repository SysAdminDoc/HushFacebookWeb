// Downloads: the index of photos and videos in Facebook's data, what the button saves for an
// element on the page, the save itself, and the button.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { fixtureLines, parseLine } from './helpers/fixtures.js';
import { extensionOf, fileName, saveFile } from '../src/core/download.js';
import { createMediaIndex, MEDIA_MARKERS, photoFile, videoFiles } from '../src/core/media-index.js';
import { createDownloadButton, mediaAt } from '../src/features/downloads/button.js';
import { authorOf, findMedia, linkTarget, nearestVideoLink, pageTarget, planSave } from '../src/features/downloads/find.js';
import { downloads } from '../src/features/downloads/shared.js';
import downloadPhotos from '../src/features/downloads/download-photos.js';
import downloadReels from '../src/features/downloads/download-reels.js';
import downloadStories from '../src/features/downloads/download-stories.js';
import downloadVideos from '../src/features/downloads/download-videos.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(html, href = 'https://www.facebook.com/') {
  const win = new Window({ url: href });
  windows.push(win);
  win.document.body.innerHTML = html;
  return win;
}

const video = (id, files = [['SD', 'sd'], ['HD', 'hd']], extra = {}) => ({
  __typename: 'Video', id, width: 1080, height: 1920,
  videoDeliveryResponseFragment: { videoDeliveryResponseResult: {
    dash_manifests: [{ manifest_xml: '<MPD/>' }],
    progressive_urls: files.map(([quality, name]) => ({ progressive_url: `https://video.example.invalid/${id}-${name}.mp4?x=1`, failure_reason: null, metadata: { quality } })),
  } },
  ...extra,
});
const photo = (id) => ({
  __typename: 'Photo', id,
  photo_image: { uri: `https://cdn.example.invalid/${id}-small.jpg`, width: 526, height: 701 },
  viewer_image: { uri: `https://cdn.example.invalid/${id}-big.jpg`, width: 1536, height: 2048 },
});

test('a video lists its progressive files HD first, and says when it only streams', () => {
  const { files, dash } = videoFiles(video('11111111'));
  assert.deepEqual(files.map((f) => f.quality), ['HD', 'SD']);
  assert.equal(dash, true);
  const failed = video('2', [['HD', 'hd']]);
  failed.videoDeliveryResponseFragment.videoDeliveryResponseResult.progressive_urls[0].failure_reason = 'EXPIRED';
  assert.deepEqual(videoFiles(failed).files, []);
  assert.deepEqual(videoFiles({ __typename: 'Video', id: '3', playable_url: 'https://v.example.invalid/a.mp4', playable_url_quality_hd: 'https://v.example.invalid/b.mp4' }).files,
    [{ url: 'https://v.example.invalid/b.mp4', quality: 'HD' }, { url: 'https://v.example.invalid/a.mp4', quality: 'SD' }], 'the older fields still count');
  assert.deepEqual(videoFiles({ __typename: 'Video', id: '4' }), { files: [], dash: false });
});

test('a photo is saved from its largest copy with an address', () => {
  assert.equal(photoFile(photo('5')).url, 'https://cdn.example.invalid/5-big.jpg');
  const noBig = { ...photo('6'), viewer_image: { width: 2048, height: 1230 } };
  assert.equal(photoFile(noBig).url, 'https://cdn.example.invalid/6-small.jpg', 'viewer_image without a uri is skipped');
  assert.equal(photoFile({ __typename: 'Photo', id: '7' }), null);
});

test('the index keeps the best of what it sees and forgets the oldest past its limit', () => {
  const index = createMediaIndex({ max: 2 });
  index.scan({ a: video('100'), b: { __typename: 'Video', id: '100' } });
  assert.equal(index.get('100').files.length, 2, 'a bare reference to the video changes nothing');
  index.scan({ p: { ...photo('200'), viewer_image: undefined } });
  index.scan({ p: photo('200') });
  assert.equal(index.get('200').url, 'https://cdn.example.invalid/200-big.jpg', 'a bigger copy replaces a smaller one');
  index.scan({ p: { ...photo('200'), viewer_image: undefined } });
  assert.equal(index.get('200').url, 'https://cdn.example.invalid/200-big.jpg', 'and a smaller one never replaces it');
  index.scan({ v: video('300') });
  assert.equal(index.get('100'), null, 'the oldest went');
  assert.equal(index.size(), 2);
  assert.equal(index.get(null), null);
  index.scan({ v: video('400') });
  index.scan({ p: photo('400') });
  assert.equal(index.get('400').kind, 'video', 'a photo under the same id never replaces a video');
});

test('the captured Home and Marketplace answers fill the index', async () => {
  const index = createMediaIndex();
  for (const name of ['CometNewsFeedPaginationQuery.jsonl', 'home-data-sjs.jsonl', 'MarketplaceCometBrowseFeedLightPaginationQuery.jsonl']) {
    for (const line of await fixtureLines(name)) {
      if (MEDIA_MARKERS.some((marker) => line.includes(marker))) index.scan(parseLine(line));
    }
  }
  assert.ok(index.size() > 3, `${index.size()} items`);
  const lines = await fixtureLines('MarketplaceCometBrowseFeedLightPaginationQuery.jsonl');
  const id = lines.join('\n').match(/"__typename":"Video"[^{}]*?"id":"(\d+)"/)?.[1] ?? null;
  if (id && index.get(id)) assert.ok(index.get(id).files.every((file) => file.url.startsWith('https://')));
});

test('a captured story bucket maps each card to its video or photo and to whose story it is', async () => {
  const [line] = await fixtureLines('StoriesSuspenseContentPaneRootWithEntryPointQuery.jsonl');
  const doc = parseLine(line);
  const index = createMediaIndex();
  index.scan(doc);
  const bucket = doc.data.bucket;
  const [first, second] = bucket.unified_stories_with_notes.edges.map((edge) => edge.node);
  const a = index.card(first.id);
  assert.equal(a.kind, 'video');
  assert.deepEqual(a.files.map((f) => f.quality), ['HD', 'SD']);
  assert.equal(a.author, bucket.story_bucket_owner.name);
  const b = index.card(second.id);
  assert.equal(b.kind, 'photo');
  assert.ok(b.url.startsWith('https://'));
  assert.equal(index.card('nope'), null);
});

test('links and addresses name a reel, a video, a photo or a story card', () => {
  assert.deepEqual(linkTarget('/reel/1234567/?s=1'), { kind: 'reel', id: '1234567' });
  assert.deepEqual(linkTarget('https://www.facebook.com/Page/videos/2345678/'), { kind: 'video', id: '2345678' });
  assert.deepEqual(linkTarget('/watch/?ref=x&v=3456789'), { kind: 'video', id: '3456789' });
  assert.deepEqual(linkTarget('/photo/?fbid=4567890&set=a.1'), { kind: 'photo', id: '4567890' });
  assert.deepEqual(linkTarget('/someone/photos/a.1/5678901/'), { kind: 'photo', id: '5678901' });
  assert.equal(linkTarget('/permalink.php?story_fbid=6789012&id=1'), null);
  assert.deepEqual(pageTarget('https://www.facebook.com/stories/103554761776924/UzpfSVNDOjI2ODg%3D/?bucket_count=9'), { kind: 'story', card: 'UzpfSVNDOjI2ODg=' });
  assert.equal(pageTarget('not a url'), null);
});

const POST = (inner) => `<div aria-posinset="1"><h4><a href="/pat"><strong>Pat Example</strong></a> · Follow</h4>${inner}</div>`;

test('a video in a post is found by the nearest video or reel link, and two different ones mean it cannot tell', () => {
  const win = page(
    POST('<div class="v1"><div><video></video></div><a href="/Pat/videos/7777777/">3h</a></div>')
    + POST('<div><video class="reel"></video><a href="/reel/8888888/">reel</a></div>')
    + POST('<div><video class="two"></video><a href="/reel/1111111/">a</a><a href="/reel/2222222/">b</a></div>')
    + POST('<div><video class="none"></video></div>'),
  );
  const index = createMediaIndex();
  index.scan({ a: video('7777777'), b: video('8888888') });
  const q = (selector) => win.document.querySelector(selector);
  const one = findMedia(q('.v1 video'), { href: win.location.href, index });
  assert.equal(one.feature, 'downloadVideos');
  assert.equal(one.id, '7777777');
  assert.equal(one.author, 'Pat Example');
  assert.equal(findMedia(q('video.reel'), { href: win.location.href, index }).feature, 'downloadReels');
  assert.equal(nearestVideoLink(q('video.two')), null);
  const unsure = findMedia(q('video.two'), { href: win.location.href, index });
  assert.match(planSave(unsure).error, /Couldn't tell which video/);
  assert.equal(findMedia(q('video.none'), { href: win.location.href, index }).id, null);
});

test('on a reel or video page the address names the video, and a story uses its card', () => {
  const index = createMediaIndex();
  index.scan({ a: video('3333333') });
  const reelPage = page('<video></video>', 'https://www.facebook.com/reel/3333333');
  const found = findMedia(reelPage.document.querySelector('video'), { href: reelPage.location.href, index });
  assert.equal(found.feature, 'downloadReels');
  assert.equal(found.item.id, '3333333');
  const watch = page('<video></video>', 'https://www.facebook.com/watch/?v=3333333');
  assert.equal(findMedia(watch.document.querySelector('video'), { href: watch.location.href, index }).feature, 'downloadVideos');

  index.scan({ bucket: { story_bucket_owner: { name: 'Harbor Pier' }, unified_stories_with_notes: { edges: [{ node: { id: 'card1', story_card_info: {}, attachments: [{ media: video('4444444') }] } }] } } });
  const story = page('<video></video>', 'https://www.facebook.com/stories/1/card1/');
  const s = findMedia(story.document.querySelector('video'), { href: story.location.href, index });
  assert.equal(s.feature, 'downloadStories');
  assert.equal(planSave(s).name, 'Harbor Pier story 4444444 HD.mp4');
});

test('a photo is found by its photo link, and pictures that are not post photos are left alone', () => {
  const win = page(POST('<a href="/photo/?fbid=9999999&set=a.1"><img class="p" src="https://cdn.example.invalid/shown.jpg"></a>')
    + '<a href="/pat"><img class="avatar" src="https://cdn.example.invalid/face.jpg"></a><img class="loose" src="x.jpg">');
  const index = createMediaIndex();
  index.scan({ p: photo('9999999') });
  const q = (selector) => win.document.querySelector(selector);
  const found = findMedia(q('img.p'), { href: win.location.href, index });
  assert.equal(found.feature, 'downloadPhotos');
  assert.deepEqual(planSave(found), { url: 'https://cdn.example.invalid/9999999-big.jpg', name: 'Pat Example photo 9999999.jpg' });
  assert.equal(findMedia(q('img.avatar'), { href: win.location.href, index }), null);
  assert.equal(findMedia(q('img.loose'), { href: win.location.href, index }), null);
  // Without the page's data (content mode) the copy on screen is saved.
  assert.equal(planSave(findMedia(q('img.p'), { href: win.location.href, index: null })).url, 'https://cdn.example.invalid/shown.jpg');
  const viewer = page('<img src="https://cdn.example.invalid/large.jpg">'
    + '<div role="article"><h3><a href="/bob">Bob</a></h3><img class="gif" src="https://cdn.example.invalid/gif.gif"></div>', 'https://www.facebook.com/photo/?fbid=9999999&set=a.1');
  assert.equal(findMedia(viewer.document.querySelector('img'), { href: viewer.location.href, index }).id, '9999999');
  assert.equal(findMedia(viewer.document.querySelector('img.gif'), { href: viewer.location.href, index }), null, "a GIF in a comment isn't the viewer's photo");
});

test('the saved file is HD unless smaller files are picked, and a stream-only video says so', () => {
  const found = { feature: 'downloadVideos', kind: 'video', id: '5', author: 'Pat', item: { kind: 'video', id: '5', files: videoFiles(video('5')).files, dash: true } };
  assert.equal(planSave(found).quality, 'HD');
  assert.equal(planSave(found).name, 'Pat video 5 HD.mp4');
  assert.equal(planSave(found, { quality: 'sd' }).quality, 'SD');
  assert.equal(planSave(found, { quality: 'sd' }).name, 'Pat video 5.mp4');
  const streamOnly = { ...found, item: { kind: 'video', id: '5', files: [], dash: true } };
  assert.match(planSave(streamOnly).error, /only streams this video in small pieces/);
  assert.match(planSave({ ...found, item: null }).error, /hasn't sent this video's file yet/);
});

test('file names lose characters a file system or a reader could trip on', () => {
  assert.equal(fileName(['A/B: "C"?', 'video', '1'], 'mp4'), 'A B C video 1.mp4');
  assert.equal(fileName([`evil${String.fromCodePoint(0x202e)}gpj`, null, 'photo'], 'jpg'), 'evil gpj photo.jpg');
  assert.equal(fileName([], 'jpg'), 'Facebook.jpg');
  assert.equal(fileName(['x'.repeat(300)], 'mp4').length, 104);
  assert.equal(extensionOf('https://cdn.example.invalid/a/b.JPEG?x=1', 'jpg'), 'jpg');
  assert.equal(extensionOf('https://cdn.example.invalid/a/b', 'mp4'), 'mp4');
  assert.equal(extensionOf('nonsense', 'mp4'), 'mp4');
  // Facebook's image server converts on the way out: the address says .png, the file is a JPEG.
  assert.equal(extensionOf('https://scontent.example.invalid/v/t39-6/1_n.png?stp=dst-jpg_tt6&_nc_cat=1', 'jpg'), 'jpg');
  assert.equal(extensionOf('https://scontent.example.invalid/v/t39-6/1_n.jpg?stp=c0.32.864.864a_dst-png', 'jpg'), 'png');
  assert.equal(extensionOf('https://scontent.example.invalid/v/t39-6/1_n.jpg?stp=dst-jpegr_tt6', 'jpg'), 'jpg', 'an HDR JPEG is still a JPEG');
  assert.equal(extensionOf('https://scontent.example.invalid/v/t39-6/1_n.png?stp=mx1080x1080', 'jpg'), 'png', 'only a size, so the address decides');
  // Direction marks, soft hyphens, word joiners and the tag characters inside flag emoji.
  const hidden = [0x61c, 0xad, 0x2060, 0x2063, 0x180e, 0xe0067, 0xe007f].map((c) => String.fromCodePoint(c)).join('');
  assert.equal(fileName([`Pat${hidden}Example`, 'photo', '1'], 'jpg'), 'Pat Example photo 1.jpg');
  assert.equal(fileName(['.hidden', 'photo'], 'jpg'), 'hidden photo.jpg', 'no hidden file');
  assert.equal(fileName(['~ . Pat'], 'jpg'), 'Pat.jpg');
});

function fakeDoc() {
  const clicks = [];
  return {
    clicks,
    body: { append() {} },
    createElement: () => ({ style: {}, click() { clicks.push(this.download); }, remove() {} }),
  };
}

test("the manager's download is tried first, and a fetched copy is saved when it fails", async () => {
  const calls = [];
  const ok = { download: (options) => { calls.push(options.name); options.onload(); } };
  assert.equal(await saveFile({ url: 'https://v.example.invalid/a.mp4', name: 'a.mp4', api: ok, doc: fakeDoc() }), 'manager');
  assert.deepEqual(calls, ['a.mp4']);

  const doc = fakeDoc();
  const api = {
    download: (options) => options.onerror({ error: 'not_whitelisted' }),
    request: (options) => options.onload({ status: 200, response: new Blob(['x']) }),
  };
  assert.equal(await saveFile({ url: 'https://v.example.invalid/a.mp4', name: 'b.mp4', api, doc }), 'link');
  assert.deepEqual(doc.clicks, ['b.mp4']);

  const refused = { request: (options) => options.onload({ status: 403, response: null }) };
  await assert.rejects(saveFile({ url: 'https://v.example.invalid/a.mp4', name: 'c.mp4', api: refused, doc: fakeDoc() }), /answered 403/);
  const win = { fetch: async () => new Response('y') };
  const viaFetch = fakeDoc();
  assert.equal(await saveFile({ url: 'https://v.example.invalid/a.mp4', name: 'd.mp4', api: {}, doc: viaFetch, win }), 'link');
  assert.deepEqual(viaFetch.clicks, ['d.mp4']);

  // Cancelled in the browser: no second try behind the person's back.
  const cancelled = {
    download: (options) => options.onerror({ error: 'not_succeeded', details: 'USER_CANCELED' }),
    request: () => assert.fail('fetched a second time'),
  };
  await assert.rejects(saveFile({ url: 'https://v.example.invalid/a.mp4', name: 'e.mp4', api: cancelled, doc: fakeDoc() }), /^Error: you cancelled it$/);
  // Some managers hand over the browser's own error object.
  const cancelledObject = {
    download: (options) => options.onerror({ error: 'not_succeeded', details: { current: 'USER_CANCELED' } }),
    request: () => assert.fail('fetched a second time'),
  };
  await assert.rejects(saveFile({ url: 'https://v.example.invalid/a.mp4', name: 'f.mp4', api: cancelledObject, doc: fakeDoc() }),
    (error) => error.cancelled === true && error.message === 'you cancelled it');
});

// Lays out an element for the button: happy-dom has no layout.
function box(element, rect) {
  element.getBoundingClientRect = () => ({ left: rect[0], top: rect[1], right: rect[0] + rect[2], bottom: rect[1] + rect[3], width: rect[2], height: rect[3] });
}
const frame = () => new Promise((resolve) => setTimeout(resolve, 30));

test('the button finds the video under the clear box Facebook lays over it', () => {
  const win = page('<div class="wrap"><video></video><div class="cover"></div></div><img class="small">');
  const doc = win.document;
  const [videoEl, cover, small] = ['video', '.cover', 'img.small'].map((s) => doc.querySelector(s));
  box(videoEl, [0, 0, 600, 400]);
  box(small, [700, 500, 40, 40]);
  // Compared with ===, since a failed assert would print the whole DOM.
  doc.elementsFromPoint = () => [cover, videoEl];
  assert.ok(mediaAt(doc, null, 100, 100) === videoEl);
  doc.elementsFromPoint = () => [cover];
  assert.ok(mediaAt(doc, null, 100, 100) === videoEl, 'found inside the boxes when the stack leaves it out');
  assert.ok(mediaAt(doc, null, 700, 100) === null, 'not when the point is outside it');
  doc.elementsFromPoint = () => [small];
  assert.ok(mediaAt(doc, null, 710, 510) === null, 'a small picture is no media');
});

test('media under a dialog, menu or chat window opened over it gets no button', () => {
  // A feed video sits deep in the page. Dialogs are mounted on their own, near the top.
  const deep = '<div>'.repeat(14) + '<div class="wrap"><video></video><div class="cover"></div></div>' + '</div>'.repeat(14);
  const win = page(`<div id="feed">${deep}</div><div role="dialog"><div class="sheet"></div></div>`);
  const doc = win.document;
  const [videoEl, cover, sheet] = ['video', '.cover', '.sheet'].map((s) => doc.querySelector(s));
  box(videoEl, [0, 0, 600, 400]);
  doc.elementsFromPoint = () => [cover, videoEl];
  assert.ok(mediaAt(doc, null, 100, 100) === videoEl, 'its own clear box is fine');
  doc.elementsFromPoint = () => [sheet, videoEl];
  assert.ok(mediaAt(doc, null, 100, 100) === null, 'a dialog over it is not');
  doc.elementsFromPoint = () => [sheet, cover, videoEl];
  assert.ok(mediaAt(doc, null, 100, 100) === null);
});

test('a click saves what is under the button right then, and turning every switch off takes the button away', async () => {
  const win = page('<video></video>');
  const doc = win.document;
  const videoEl = doc.querySelector('video');
  box(videoEl, [100, 50, 600, 400]);
  let card = 'card1';
  let on = true;
  let under = () => [videoEl];
  doc.elementsFromPoint = () => under();
  const saved = [];
  const button = createDownloadButton({
    doc, win, active: () => on,
    find: () => (on ? { what: card } : null),
    run: async (found) => saved.push(found.what),
  });
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 200, clientY: 100 }));
  await frame();
  assert.equal(button.state().shown, true);
  // The pointer rests on the button while the story viewer moves on to the next card.
  const host = doc.querySelector('[data-hushfacebook-web="download"]');
  under = () => [host, videoEl];
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 650, clientY: 62 }));
  await frame();
  card = 'card2';
  button.click();
  await frame();
  assert.deepEqual(saved, ['card2']);
  on = false;
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 651, clientY: 62 }));
  await frame();
  assert.equal(button.state().shown, false, 'gone as soon as the pointer moves');
  button.click();
  await frame();
  assert.deepEqual(saved, ['card2'], 'and a click on it saves nothing');
  button.stop();
});

test('a slow save only keeps its own media busy', async () => {
  const win = page('<video class="a"></video><video class="b"></video>');
  const doc = win.document;
  const [a, b] = doc.querySelectorAll('video');
  box(a, [100, 50, 600, 400]);
  box(b, [100, 600, 600, 400]);
  let under = a;
  doc.elementsFromPoint = () => [under];
  const started = [];
  let finish = null;
  const button = createDownloadButton({
    doc, win, active: () => true,
    find: (element) => ({ what: element === a ? 'a' : 'b' }),
    run: (found) => {
      started.push(found.what);
      return found.what === 'a' ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve();
    },
  });
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 200, clientY: 100 }));
  await frame();
  button.click();
  await frame();
  assert.equal(button.state().text, 'Saving');
  button.click();
  await frame();
  assert.deepEqual(started, ['a'], 'a second click on the same one waits');
  under = b;
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 200, clientY: 700 }));
  await frame();
  assert.equal(button.state().text, 'Download', 'the other video is free');
  button.click();
  await frame();
  assert.deepEqual(started, ['a', 'b']);
  under = a;
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 200, clientY: 100 }));
  await frame();
  assert.equal(button.state().text, 'Saving', 'back over the first, still saving');
  finish();
  await frame();
  assert.equal(button.state().text, 'Download');
  button.stop();
});

test('when the story swaps its video for a new element, a click saves the new one, or says nothing is there', async () => {
  const win = page('<div class="viewer"><video class="first"></video></div>');
  const doc = win.document;
  const first = doc.querySelector('video');
  box(first, [100, 50, 600, 400]);
  let under = () => [first];
  doc.elementsFromPoint = () => under();
  const saved = [];
  let missing = 0;
  const button = createDownloadButton({
    doc, win, active: () => true,
    find: (element) => ({ what: element.className }),
    run: async (found) => saved.push(found.what),
    onMissing: () => missing++,
  });
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 650, clientY: 62 }));
  await frame();
  const host = doc.querySelector('[data-hushfacebook-web="download"]');
  // The pointer is on the button; the viewer replaces the video element with the next card's.
  const next = doc.createElement('video');
  next.className = 'second';
  box(next, [100, 50, 600, 400]);
  first.replaceWith(next);
  under = () => [host, next];
  button.click();
  await frame();
  assert.deepEqual(saved, ['second']);
  // Then a card with nothing to save under the button.
  next.remove();
  under = () => [host];
  button.click();
  await frame();
  assert.deepEqual(saved, ['second']);
  assert.equal(missing, 1);
  button.stop();
});

test('a stopped button stays gone even with a move already waiting', async () => {
  const win = page('<video></video>');
  const doc = win.document;
  box(doc.querySelector('video'), [0, 0, 600, 400]);
  doc.elementsFromPoint = () => [doc.querySelector('video')];
  const button = createDownloadButton({ doc, win, active: () => true, find: () => ({}), run: async () => {} });
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 10, clientY: 10 }));
  button.stop();
  await frame();
  assert.equal(doc.querySelectorAll('[data-hushfacebook-web="download"]').length, 0);
});

test('the button shows over media a switch covers, and a click saves it', async () => {
  const win = page('<video class="a"></video><video class="b"></video>');
  const doc = win.document;
  const [a, b] = doc.querySelectorAll('video');
  box(a, [100, 50, 600, 400]);
  box(b, [100, 600, 600, 400]);
  let under = a;
  doc.elementsFromPoint = () => [under];
  const saved = [];
  const button = createDownloadButton({
    doc, win, active: () => true,
    find: (element) => (element === a ? { what: 'a' } : null),
    run: async (found) => saved.push(found.what),
  });
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 200, clientY: 100 }));
  await frame();
  assert.equal(button.state().shown, true);
  assert.equal(button.state().text, 'Download');
  assert.equal(button.state().top, '60px');
  assert.equal(button.state().right, `${win.innerWidth - 700 + 10}px`);
  button.click();
  await frame();
  assert.deepEqual(saved, ['a']);
  assert.equal(doc.querySelectorAll('[data-hushfacebook-web="download"]').length, 1, 'one host, outside Facebook\'s markup');
  under = b;
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 200, clientY: 700 }));
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(button.state().shown, false, 'nothing to save there');
  button.stop();
});

test('each switch only offers what it covers, and the index fills from what Facebook parses', async () => {
  const win = page(POST('<div><video></video><a href="/Pat/videos/7777777/">3h</a></div>') + POST('<a href="/photo/?fbid=9999999"><img></a>'));
  const doc = win.document;
  const rules = [];
  const on = { downloadPhotos: true, downloadVideos: false, downloadReels: true, downloadStories: true };
  const toasts = [];
  const downloaded = [];
  const api = { download: ({ name, onload }) => { downloaded.push(name); onload(); }, request: null };
  for (const feature of [downloadPhotos, downloadVideos, downloadReels, downloadStories]) {
    feature.setup({
      win, doc, api, net: { transformResponses: (rule) => rules.push(rule) }, router: { current: () => ({ href: win.location.href }) },
      log: { error() {}, warn() {}, info() {} }, toast: (message) => toasts.push(message),
      enabled: () => on[feature.id],
      // Like the real settings, which throw for an option the switch doesn't have.
      option(key) {
        if (!feature.options?.some((option) => option.key === key)) throw new Error(`Unknown setting: ${feature.id}.${key}`);
        return 'best';
      },
    });
  }
  assert.equal(rules.length, 1, 'one index for all four switches');
  const [rule] = rules;
  assert.deepEqual(rule.markers, MEDIA_MARKERS);
  assert.equal(rule.match({ transport: 'fetch' }), false, 'it reads what JSON.parse returns, never a second parse');
  assert.equal(rule.match({ transport: 'json-parse' }), true);
  assert.equal(rule.transform({ a: video('7777777'), p: photo('9999999') }), false, 'it changes nothing');
  const shared = downloads({ doc });
  assert.equal(shared.index.size(), 2);
  assert.equal(downloadVideos.default, false, 'Download any video starts off, like on Android');
  assert.ok([downloadPhotos, downloadReels, downloadStories].every((feature) => feature.default === true));
  assert.ok([downloadVideos, downloadReels, downloadStories].every((feature) => feature.needsPage));
  assert.equal(authorOf(doc.querySelector('img')), 'Pat Example');
  // A photo save goes through, though Download any photo has no quality option.
  const found = findMedia(doc.querySelector('img'), { href: win.location.href, index: shared.index });
  assert.equal(found?.feature, 'downloadPhotos');
  await shared.run(found, doc.body);
  assert.deepEqual(downloaded, ['Pat Example photo 9999999.jpg'], toasts.join(' | '));
  // Cancelled in the manager: a plain note, not an error.
  api.download = (options) => options.onerror({ error: 'not_succeeded', details: 'USER_CANCELED' });
  toasts.length = 0;
  await shared.run(found, doc.body);
  assert.deepEqual(toasts, ['Cancelled Pat Example photo 9999999.jpg']);
});
