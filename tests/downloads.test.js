// Downloads: the index of photos and videos in Facebook's data, what the button saves for an
// element on the page, the save itself, and the button.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { fixtureLines, parseLine } from './helpers/fixtures.js';
import { boxes, text, trackFile } from './helpers/mp4.js';
import { extensionOf, fileName, saveFile, startSave } from '../src/core/download.js';
import { createMediaIndex, MEDIA_MARKERS, photoFile, videoFiles } from '../src/core/media-index.js';
import { cornerControls, createDownloadButton, mediaAt } from '../src/features/downloads/button.js';
import { authorOf, findMedia, linkTarget, nearestVideoLink, pageTarget, planSave } from '../src/features/downloads/find.js';
import { downloads } from '../src/features/downloads/shared.js';
import { t } from '../src/core/i18n.js';
import downloadPhotos from '../src/features/downloads/download-photos.js';
import downloadReels from '../src/features/downloads/download-reels.js';
import downloadStories from '../src/features/downloads/download-stories.js';
import downloadVideos from '../src/features/downloads/download-videos.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(html, href = 'https://www.facebook.com/') {
  const win = testWindow(href);
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
  assert.deepEqual(videoFiles({ __typename: 'Video', id: '4' }), { files: [], dash: false, stream: null, sharper: null });
});

// The captured video with a static manifest, its files taken away, or a live one.
async function streamedVideo(id, { live = false } = {}) {
  const [line] = await fixtureLines('video-delivery-dash.jsonl');
  const value = parseLine(line).data.video;
  const result = value.videoDeliveryResponseFragment.videoDeliveryResponseResult;
  result.progressive_urls = result.progressive_urls.map((entry) => ({ ...entry, progressive_url: null, failure_reason: { type: live ? 'NoProgressiveUrlForLive' : 'Unknown' } }));
  if (live) result.dash_manifests = [{ manifest_xml: '<MPD type="dynamic"><Period/></MPD>', failure_reason: null }];
  return { __typename: 'Video', ...value, id };
}

test("a video with no file keeps what its manifest offers, a live one says so, and the index holds on to it", async () => {
  const { files, stream } = videoFiles(await streamedVideo('8'));
  assert.deepEqual(files, []);
  assert.equal(stream.live, false);
  assert.equal(stream.video.length, 8);
  assert.equal(stream.audio.codecs, 'mp4a.40.5');
  assert.equal(videoFiles(await streamedVideo('8', { live: true })).stream.live, true);
  const liveNoManifest = await streamedVideo('8', { live: true });
  liveNoManifest.videoDeliveryResponseFragment.videoDeliveryResponseResult.dash_manifests = [];
  assert.deepEqual(videoFiles(liveNoManifest).stream, { duration: null, video: [], audio: null, live: true }, 'its file entries alone say it is live');
  assert.equal(videoFiles(video('9')).stream, null, 'a video with a file needs no pieces');
  const xml = (await streamedVideo('8')).videoDeliveryResponseFragment.videoDeliveryResponseResult.dash_manifests[0].manifest_xml;
  assert.equal(videoFiles({ __typename: 'Video', id: '8', dash_manifest: xml }).stream.video.length, 8, 'the older dash_manifest field still counts');
  const timeless = { __typename: 'Video', id: '8', playable_duration_in_ms: 84842, dash_manifest: xml.replace(/ (?:mediaPresentationDuration|duration)="[^"]*"/g, '') };
  assert.equal(videoFiles(timeless).stream.duration, 84.842, "the video's own length when the manifest gives none");
  assert.equal(videoFiles({ ...timeless, playable_duration_in_ms: undefined, length_in_second: 84.842 }).stream.duration, 84.842);

  const index = createMediaIndex();
  index.scan({ v: await streamedVideo('500') });
  const bare = { __typename: 'Video', id: '500', videoDeliveryResponseFragment: { videoDeliveryResponseResult: { dash_manifest_urls: ['https://video.example.invalid/500.mpd'] } } };
  index.scan({ v: bare });
  assert.equal(index.get('500').stream.video.length, 8, 'a later copy with nothing to read keeps the manifest');
  const empty = await streamedVideo('500');
  empty.videoDeliveryResponseFragment.videoDeliveryResponseResult.dash_manifests = [{ manifest_xml: '<MPD type="static"><Period/></MPD>' }];
  index.scan({ v: empty });
  assert.equal(index.get('500').stream.video.length, 8, 'and so does one whose manifest has no whole copies');
  const fresher = await streamedVideo('500');
  fresher.videoDeliveryResponseFragment.videoDeliveryResponseResult.dash_manifests[0].manifest_xml = fresher.videoDeliveryResponseFragment.videoDeliveryResponseResult.dash_manifests[0].manifest_xml.replace(/cdn\.example\.invalid/g, 'cdn2.example.invalid');
  index.scan({ v: fresher });
  assert.match(index.get('500').stream.video[0].url, /cdn2\.example\.invalid/, 'a newer manifest replaces it, with addresses that last longer');
  index.scan({ v: video('500') });
  assert.equal(index.get('500').files.length, 2, 'and files win over pieces');

  // A live video with no manifest at all is still kept, so the button can say it's live.
  index.scan({ v: { __typename: 'Video', id: '600', videoDeliveryResponseFragment: { videoDeliveryResponseResult: {
    progressive_urls: [{ progressive_url: null, failure_reason: { type: 'NoProgressiveUrlForLive' } }],
  } } } });
  assert.equal(index.get('600').stream.live, true);
});

// A captured video as it came, with its HD and SD files and its manifest.
async function filedVideo(id, line = 0) {
  const lines = await fixtureLines('video-delivery-dash.jsonl');
  return { __typename: 'Video', ...parseLine(lines[line]).data.video, id };
}

// A file whose address carries Facebook's efg parameter, naming the width it was coded at.
const efgFor = (width, extra = {}) => btoa(JSON.stringify({ vencode_tag: `xpv_progressive.FACEBOOK..C2.${width}.progressive_h264-basic-gen2_720p`, ...extra }));
const tagged = (width) => `https://video.example.invalid/f.mp4?efg=${encodeURIComponent(efgFor(width))}&x=1`;

test('beside its file, a video keeps the streamed copies sharper than it, but none blown up past its own size', async () => {
  const { files, stream, sharper } = videoFiles(await filedVideo('6'));
  assert.equal(files[0].quality, 'HD');
  assert.equal(stream, null);
  // Every copy under the 1080p one is coded 720 wide, no bigger than an HD file.
  assert.deepEqual(sharper.video.map((copy) => [copy.width, copy.height]), [[1080, 1920]]);
  assert.equal(sharper.audio.codecs, 'mp4a.40.5');
  assert.equal(sharper.duration, 28.552799);
  assert.equal(sharper.live, false);
  assert.deepEqual(videoFiles(await filedVideo('6', 1)).sharper.video.map((copy) => [copy.width, copy.height]), [[1080, 1440]]);

  const withFile = async (url, quality = 'HD', size = {}) => {
    const value = await filedVideo('6');
    value.videoDeliveryResponseFragment.videoDeliveryResponseResult.progressive_urls = [{ progressive_url: url, failure_reason: null, metadata: { quality } }];
    return { ...value, ...size };
  };
  const sides = (value) => videoFiles(value).sharper?.video.map((copy) => Math.min(copy.width, copy.height)) ?? null;
  const past480 = [1080, 720, 720, 720, 720, 720, 720, 720];
  assert.deepEqual(sides(await withFile(tagged(480))), past480, 'a file coded 480 wide');
  assert.equal(sides(await withFile(tagged(480), 'HD', { original_width: 480, original_height: 854 })), null, 'nothing past the size of the video itself');
  assert.deepEqual(sides(await withFile(tagged(1280))), [1080], 'HD stays at 720 or under with no size to go on');
  assert.deepEqual(sides(await withFile(tagged(1280), 'HD', { original_width: 2560, original_height: 1080 })), past480, 'a very wide video coded 1280 by 540');
  const plus = efgFor(480, { urlgen_source: '~~~' });
  assert.ok(plus.includes('+'));
  assert.deepEqual(sides(await withFile(`https://video.example.invalid/f.mp4?efg=${plus}`)), past480, 'a + left unescaped in the address');
  assert.deepEqual(sides(await withFile('https://video.example.invalid/f.mp4?efg=bm90IGpzb24')), [1080], 'an HD file with no tag');
  assert.deepEqual(sides(await withFile('https://video.example.invalid/f.mp4', 'SD')), past480, 'an SD file with no tag');
  assert.equal(sides(await withFile(tagged(1080), 'HD', { original_width: 1080, original_height: 1920 })), null, 'a file as sharp as the best copy');
  assert.equal(sides(await withFile(tagged(1040), 'HD', { original_width: 1080, original_height: 1920 })), null, 'or one not much smaller');

  const xml = (await filedVideo('6')).videoDeliveryResponseFragment.videoDeliveryResponseResult.dash_manifests[0].manifest_xml;
  const swapManifest = async (text, extra = {}) => {
    const value = await filedVideo('6');
    value.videoDeliveryResponseFragment.videoDeliveryResponseResult.dash_manifests[0].manifest_xml = text;
    return { ...value, ...extra };
  };
  const timeless = xml.replace(/ (?:mediaPresentationDuration|duration)="[^"]*"/g, '');
  assert.equal(videoFiles(await swapManifest(timeless)).sharper, null, "with no length there's no telling the size");
  assert.equal(videoFiles(await swapManifest(timeless, { length_in_second: 28.5 })).sharper.duration, 28.5, "the video's own length will do");
  assert.equal(videoFiles(await swapManifest(xml.replace(/bandwidth="5960517"/, 'bandwidth="0"'))).sharper, null, 'nor with a copy that gives no bandwidth');
  assert.equal(videoFiles(await swapManifest(xml.replace(/<MPD\b/, '<MPD type="dynamic"'))).sharper, null, 'a live manifest has no whole copies');
  assert.equal(videoFiles(await streamedVideo('6')).sharper, null, 'a video with no file uses the stream instead');

  const index = createMediaIndex();
  index.scan({ v: await filedVideo('6') });
  assert.equal(index.get('6').sharper.video[0].width, 1080, 'the index keeps them with the files');
  const bare = await filedVideo('6');
  delete bare.videoDeliveryResponseFragment.videoDeliveryResponseResult.dash_manifests;
  index.scan({ v: bare });
  assert.equal(index.get('6').sharper?.video[0].width, 1080, 'and a later answer with the files but no manifest leaves them');
});

test("a video's own page sends the video as its answer's data with no type, and the index takes it all the same", async () => {
  // The shape seen live on 2026-10-22 on /<page>/videos/<id>/: the server's answer holds the
  // video's fields and its delivery fragment at __bbox.result.data, with no __typename, and the
  // fragment and its result repeat the video's id.
  const page = (data) => ({ require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { require: [['RelayPrefetchedStreamCache', 'next', [],
    ['adp_CometTahoeRootQueryRelayPreloader_1', { __bbox: { complete: true, result: { data } } }]]] } }]]] });
  const untyped = (value) => {
    delete value.__typename;
    value.videoDeliveryResponseFragment.id = value.id;
    value.videoDeliveryResponseFragment.videoDeliveryResponseResult.id = value.id;
    return value;
  };
  const index = createMediaIndex();
  index.scan(page(untyped(await streamedVideo('700'))));
  assert.equal(index.get('700').stream.video.length, 8, 'a streamed one keeps its manifest');
  index.scan(page(untyped(video('701'))));
  assert.deepEqual(index.get('701').files.map((f) => f.quality), ['HD', 'SD'], 'and one with files keeps them');
  index.scan({ s: { ...video('702'), __typename: 'Story' } });
  assert.equal(index.get('702'), null, 'something else carrying a fragment is not the video');
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

test("a verified Page's check mark stays out of the name", () => {
  // Live 2026-10-22 on NASA's Page: one span wraps the name link and the check mark's svg.
  const badge = '<span>&nbsp;<span><svg viewBox="0 0 12 12" role="img" title="Verified account"><title>Verified account</title><path d="M0 0"></path></svg></span></span>';
  const win = page(
    `<div aria-posinset="1" class="linked"><h2><span><span><a href="/NASA"><b><span>NASA</span></b></a></span>${badge}</span></h2><img></div>`
    + `<div aria-posinset="2" class="plain"><h3><span><b>Pat Example</b>${badge}</span> · Follow</h3><img></div>`,
  );
  const q = (selector) => win.document.querySelector(selector);
  assert.equal(authorOf(q('.linked img')), 'NASA');
  assert.equal(authorOf(q('.plain img')), 'Pat Example', 'no link: the words around the check mark, not its title');
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

test("on a video's own page the address names only its player, never a video in a comment or a post below it", () => {
  const index = createMediaIndex();
  index.scan({ main: video('3333333', [['HD', 'main']]), comment: video('9999999', [['HD', 'comment']]) });
  // A comment's time links back to the video it's on, with the comment's id.
  const comment = (label, inner) => `<div role="article"${label ? ` aria-label="${label}"` : ''}><a href="/bob">Bob</a>`
    + `<a href="/watch/?v=3333333&amp;comment_id=5555555">2h</a>${inner}</div>`;
  const win = page(
    '<div class="main"><video></video></div>'
    + comment('Comment by Bob', '<div><video class="labeled"></video></div>')
    + comment('', '<div><video class="unlabeled"></video></div>'
      + '<div role="article"><a href="/ann">Ann</a><div><video class="reply"></video></div></div>')
    + comment('Comment by Bob', '<div><video class="linked"></video><a href="/bob/videos/9999999/">clip</a></div>')
    + '<div aria-posinset="1"><h4><a href="/pat">Pat</a></h4><div><video class="below"></video></div></div>',
    'https://www.facebook.com/watch/?v=3333333',
  );
  const q = (selector) => win.document.querySelector(selector);
  const at = (selector) => findMedia(q(selector), { href: win.location.href, index });
  const main = at('.main video');
  assert.equal(main.id, '3333333');
  assert.equal(planSave(main).url, 'https://video.example.invalid/3333333-main.mp4?x=1');
  for (const selector of ['video.labeled', 'video.unlabeled', 'video.reply', 'video.below']) {
    const found = at(selector);
    assert.equal(found.id, null, selector);
    assert.match(planSave(found).error, /Couldn't tell which video/, selector);
  }
  assert.equal(planSave(at('video.linked')).url, 'https://video.example.invalid/9999999-comment.mp4?x=1', 'a comment video with its own link is still found');

  // Facebook draws the player again, and the new one still gets the address.
  q('.main').innerHTML = '<video class="redrawn"></video>';
  assert.equal(at('video.redrawn').id, '3333333');
  // On a video's own page the player can sit in the post itself, which is no comment.
  const permalink = page('<div role="article"><a href="/pat">Pat</a><div><video></video></div></div>', 'https://www.facebook.com/pat/videos/3333333/');
  assert.equal(findMedia(permalink.document.querySelector('video'), { href: permalink.location.href, index }).id, '3333333');
  const reel = page(comment('Comment by Bob', '<video></video>'), 'https://www.facebook.com/reel/3333333');
  assert.equal(findMedia(reel.document.querySelector('video'), { href: reel.location.href, index }).id, null, 'nor on a reel');
});

test("a video's own page names its file after the video's owner, whose name comes in another answer", () => {
  const tahoe = (data) => ({ require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { require: [['RelayPrefetchedStreamCache', 'next', [],
    ['adp_CometTahoeRootQueryRelayPreloader_1', { __bbox: { complete: true, result: { data } } }]]] } }]]] });
  // The player's own node has no __typename, and its owner no name (live 2026-10-22).
  const node = (id, owner = '61550001') => {
    const value = video(id, [['HD', 'own']], { owner: { __typename: 'User', id: owner, __isVideoOwner: 'User', has_professional_features_for_watch: true } });
    delete value.__typename;
    return value;
  };
  const named = { q: { data: { currentVideo: { id: '3333333', owner: { __typename: 'User', name: ' Harbor Band ', __isVideoOwner: 'User', uri_token: 'harborband', id: '61550001' } } } } };
  const own = page('<div><video></video></div>', 'https://www.facebook.com/harborband/videos/3333333/');
  const save = (index, win = own) => planSave(findMedia(win.document.querySelector('video'), { href: win.location.href, index }));

  const index = createMediaIndex();
  index.scan(tahoe(node('3333333')));
  assert.equal(save(index).name, 'video 3333333 HD.mp4', 'until the name comes, the file has none in front');
  index.scan(named);
  assert.equal(save(index).name, 'Harbor Band video 3333333 HD.mp4');
  const early = createMediaIndex();
  early.scan(named);
  early.scan(tahoe(node('3333333')));
  assert.equal(save(early).name, 'Harbor Band video 3333333 HD.mp4', 'the name can come first');

  // On a video's own page the player can sit in the post itself.
  const inPost = page('<div role="article"><h4><a href="/pat">Pat Example</a></h4><div><video></video></div></div>', 'https://www.facebook.com/harborband/videos/3333333/');
  assert.equal(save(index, inPost).name, 'Pat Example video 3333333 HD.mp4', "a post's own name still wins");
  index.scan(tahoe(node('4444444', '61550002')));
  assert.equal(save(index, page('<video></video>', 'https://www.facebook.com/watch/?v=4444444')).name, 'video 4444444 HD.mp4', "someone else's video doesn't get that name");
  index.scan({ v: video('5555555', [['HD', 'feed']], { owner: { __typename: 'Page', id: '61550003', name: 'Pier Cafe' } }), blank: { owner: { id: '61550002', name: '  ' } } });
  assert.equal(index.ownerName('5555555'), 'Pier Cafe', 'a video that names its owner itself');
  assert.equal(index.ownerName('4444444'), null, 'and a blank name is no name');
  assert.equal(index.ownerName(null), null);
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

test('a video Facebook only streams is saved from its picture and sound copies, unless it is live or too long', async () => {
  const { stream } = videoFiles(await streamedVideo('6'));
  const found = { feature: 'downloadVideos', kind: 'video', id: '6', author: 'Pat', item: { kind: 'video', id: '6', files: [], dash: true, stream } };
  assert.deepEqual(planSave(found), { name: 'Pat video 6 1080p.mp4', quality: '1080p', parts: [stream.video[0].url, stream.audio.url] });
  assert.equal(planSave(found, { quality: 'sd' }).name, 'Pat video 6 480p.mp4');
  const silent = { ...found, item: { ...found.item, stream: { ...stream, audio: null } } };
  assert.deepEqual(planSave(silent), { name: 'Pat video 6 1080p.mp4', quality: '1080p', url: stream.video[0].url }, 'a silent copy is a whole file already');

  // 28.55 seconds: the 240p copy and the sound come to about 1.5 MB, which reads as 2.
  const tooLong = planSave(found, { limit: 1e6 });
  assert.equal(tooLong.error, 'This video is too long to put together in the browser (about {size} MB at its smallest).');
  assert.deepEqual(tooLong.params, { size: 2 });
  assert.match(t(tooLong.error, tooLong.params), /about 2 MB at its smallest/);
  assert.ok(planSave(found).parts, 'the usual limit takes this one whole');

  const timeless = { ...found, item: { ...found.item, stream: { ...stream, duration: null } } };
  assert.equal(planSave(timeless).name, 'Pat video 6 480p.mp4', "with no length there's no estimate, so the smaller copy");

  const live = { ...found, item: { ...found.item, stream: { ...stream, live: true, video: [] } } };
  assert.match(planSave(live).error, /This video is live/);
  const unreadable = { ...found, item: { ...found.item, stream: { ...stream, video: [] } } };
  assert.match(planSave(unreadable).error, /only streams this video in small pieces/, 'a manifest with no whole copies keeps the old answer');
  assert.deepEqual(planSave(found, { quality: 'sharpest' }), planSave(found), 'the sharpest of a streamed video is its best');
});

test('Sharpest joins the streamed copy sharper than the HD file, and saves the file when none is or it would be too big', async () => {
  const { files, sharper } = videoFiles(await filedVideo('6'));
  const found = { feature: 'downloadVideos', kind: 'video', id: '6', author: 'Pat', item: { kind: 'video', id: '6', files, dash: true, stream: null, sharper } };
  assert.deepEqual(planSave(found, { quality: 'sharpest' }), { name: 'Pat video 6 1080p.mp4', quality: '1080p', parts: [sharper.video[0].url, sharper.audio.url] });
  assert.equal(planSave(found).url, files[0].url, 'Best stays with the HD file');
  assert.equal(planSave(found, { quality: 'sd' }).quality, 'SD');
  const silent = { ...found, item: { ...found.item, sharper: { ...sharper, audio: null } } };
  assert.deepEqual(planSave(silent, { quality: 'sharpest' }), { name: 'Pat video 6 1080p.mp4', quality: '1080p', url: sharper.video[0].url });
  // 28.55 seconds of the 1080p copy and its sound come to about 21 MB.
  assert.deepEqual(planSave(found, { quality: 'sharpest', limit: 20e6 }), planSave(found), 'past the limit, the HD file');
  assert.deepEqual(planSave({ ...found, item: { ...found.item, sharper: null } }, { quality: 'sharpest' }), planSave(found), 'nothing sharper, the HD file');

  const offered = [downloadVideos, downloadReels, downloadStories].map((feature) => feature.options.find((option) => option.key === 'quality').choices.map((choice) => choice.value));
  assert.deepEqual(offered, [['best', 'sd', 'sharpest'], ['best', 'sd', 'sharpest'], ['best', 'sd', 'sharpest']]);
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
  // Windows device names, which the downloads refuse.
  assert.equal(fileName(['Con'], 'jpg'), 'Facebook Con.jpg');
  assert.equal(fileName(['nul.txt'], 'mp4'), 'Facebook nul.txt.mp4');
  assert.equal(fileName(['Connie', 'photo'], 'jpg'), 'Connie photo.jpg');
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
  // The extension's download, taken by the browser and then stopped: its reason stands, and the
  // page's fetch (which can't read Facebook's files) isn't tried.
  const fetched = [];
  const stopped = {
    download: (options) => options.onerror({ error: "Facebook's server stopped sending it (SERVER_CONTENT_LENGTH_MISMATCH)", final: true }),
    request: (options) => {
      fetched.push(options.url);
      options.onload({ status: 200, response: new Blob(['x']) });
    },
  };
  await assert.rejects(saveFile({ url: 'https://v.example.invalid/a.mp4', name: 'g.mp4', api: stopped, doc: fakeDoc() }),
    (error) => error.message === "Facebook's server stopped sending it (SERVER_CONTENT_LENGTH_MISMATCH)" && !error.cancelled);
  assert.deepEqual(fetched, [], 'a final error starts no fallback');
});

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('a save has one deadline over every try, and cancel or the deadline stops the try that is running', async (t) => {
  const url = 'https://v.example.invalid/a.mp4';
  const aborted = [];
  const fallbacks = [];
  // Managers report their own abort as an error, which mustn't read as "try the fallback".
  const stoppable = (label) => (options) => ({
    abort: () => {
      aborted.push(label);
      options.onerror({ error: 'aborted' });
    },
  });
  const fallback = (options) => (fallbacks.push(options.url), { abort() {} });
  await nextTurn();
  // A manager that keeps going past the timeout it was given.
  const silent = { download: stoppable('download'), request: fallback };
  await assert.rejects(startSave({ url, name: 'a.mp4', api: silent, doc: fakeDoc(), deadline: 20 }).done, /took too long/);
  await nextTurn();
  assert.deepEqual(aborted, ['download']);
  assert.deepEqual(fallbacks, [], 'the deadline started no fallback');

  // A server that never finishes the file.
  let signal = null;
  const stalled = {
    fetch: (_, options) => {
      ({ signal } = options);
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    },
  };
  const stalledDoc = fakeDoc();
  await assert.rejects(startSave({ url, name: 'b.mp4', api: {}, doc: stalledDoc, win: stalled, deadline: 20 }).done, /took too long/);
  assert.equal(signal.aborted, true, 'the fetch is aborted');
  assert.deepEqual(stalledDoc.clicks, []);

  // Cancel while the manager has it: no fallback.
  const manager = { download: stoppable('manager'), request: fallback };
  const save = startSave({ url, name: 'c.mp4', api: manager, doc: fakeDoc() });
  save.cancel();
  save.cancel();
  await assert.rejects(save.done, (error) => error.cancelled === true && error.message === 'you cancelled it');
  await nextTurn();
  assert.deepEqual(aborted, ['download', 'manager']);
  assert.deepEqual(fallbacks, [], 'a cancel started no fallback');

  // Cancel during the fallback, and the file arrives anyway: nothing is saved or kept.
  const made = [];
  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = (blob) => (made.push(blob), 'blob:x');
  t.after(() => { URL.createObjectURL = createObjectURL; });
  let deliver = null;
  const late = {
    download: (options) => options.onerror({ error: 'not_whitelisted' }),
    request: (options) => {
      deliver = () => options.onload({ status: 200, response: new Blob(['x']) });
      return { abort: () => aborted.push('request') };
    },
  };
  const lateDoc = fakeDoc();
  const fetching = startSave({ url, name: 'd.mp4', api: late, doc: lateDoc });
  await nextTurn();
  fetching.cancel();
  deliver();
  await assert.rejects(fetching.done, /cancelled/);
  await nextTurn();
  assert.deepEqual(lateDoc.clicks, []);
  assert.deepEqual(made, [], 'no object URL for a file nobody wants');
  assert.deepEqual(aborted, ['download', 'manager', 'request']);

  // It settles once: a manager that reports twice, then a cancel, change nothing.
  const twice = {
    download: (options) => {
      options.onload();
      options.onerror({ error: 'late' });
      return { abort: () => aborted.push('twice') };
    },
  };
  const quick = startSave({ url, name: 'e.mp4', api: twice, doc: fakeDoc() });
  assert.equal(await quick.done, 'manager');
  quick.cancel();
  assert.deepEqual(aborted, ['download', 'manager', 'request'], 'nothing aborts a finished save');
});

test('a video in two parts is fetched whole, joined into one MP4 and saved through the link', async (t) => {
  const made = [];
  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = (blob) => (made.push(blob), 'blob:x');
  t.after(() => { URL.createObjectURL = createObjectURL; });
  const files = {
    'https://video.example.invalid/p.mp4': trackFile({ fragments: [[0, 'P0'], [30720, 'P2']] }),
    'https://video.example.invalid/s.mp4': trackFile({ mediaScale: 44100, fragments: [[0, 'S0']] }),
  };
  const parts = Object.keys(files);
  const asked = [];
  const api = {
    download: () => assert.fail("the manager can't join two files"),
    request: (options) => {
      asked.push([options.url, options.responseType]);
      options.onload({ status: 200, response: files[options.url].slice().buffer });
      return { abort() {} };
    },
  };
  const doc = fakeDoc();
  assert.equal(await startSave({ parts, name: 'v.mp4', api, doc }).done, 'link');
  assert.deepEqual(asked, parts.map((url) => [url, 'arraybuffer']));
  assert.deepEqual(doc.clicks, ['v.mp4']);
  assert.equal(made[0].type, 'video/mp4');
  const saved = new Uint8Array(await made[0].arrayBuffer());
  assert.deepEqual(boxes(saved).filter((b) => b.type === 'mdat').map((b) => text(saved, b)), ['P0', 'S0', 'P2']);

  // The extension has no manager request, so the page fetches them.
  const win = { fetch: async (url) => new Response(files[url].slice()) };
  const viaFetch = fakeDoc();
  assert.equal(await startSave({ parts, name: 'w.mp4', api: {}, doc: viaFetch, win }).done, 'link');
  assert.deepEqual(viaFetch.clicks, ['w.mp4']);
});

test('cancelling a two-part save stops both transfers, and one part failing stops the other', async () => {
  const parts = ['https://video.example.invalid/p.mp4', 'https://video.example.invalid/s.mp4'];
  const aborted = [];
  const waiting = {};
  const api = {
    request: (options) => {
      waiting[options.url] = options;
      return { abort: () => aborted.push(options.url) };
    },
  };
  const doc = fakeDoc();
  const save = startSave({ parts, name: 'a.mp4', api, doc });
  save.cancel();
  await assert.rejects(save.done, (error) => error.cancelled === true);
  assert.deepEqual(aborted, parts);

  aborted.length = 0;
  const failing = startSave({ parts, name: 'b.mp4', api, doc });
  waiting[parts[1]].onload({ status: 403, response: null });
  await assert.rejects(failing.done, /answered 403/);
  assert.ok(aborted.includes(parts[0]), 'the picture stops downloading once the sound has failed');

  const mismatched = startSave({ parts, name: 'c.mp4', api: { request: (options) => (options.onload({ status: 200, response: new Uint8Array(64).buffer }), { abort() {} }) }, doc });
  await assert.rejects(mismatched.done, (error) => error.message === "the video and its sound didn't fit together" && /not one fragmented track/.test(error.cause.message));
  assert.deepEqual(doc.clicks, [], 'nothing was saved');

  aborted.length = 0;
  await assert.rejects(startSave({ parts, name: 'd.mp4', api, doc, deadline: 20 }).done, /took too long/);
  assert.deepEqual(aborted, parts, 'the deadline stops both');

  // Both parts in, then a cancel before they're joined: nothing is saved.
  const arriving = startSave({ parts, name: 'e.mp4', api, doc });
  for (const url of parts) waiting[url].onload({ status: 200, response: trackFile().buffer });
  arriving.cancel();
  await assert.rejects(arriving.done, (error) => error.cancelled === true);
  await nextTurn();
  assert.deepEqual(doc.clicks, []);
});

test('a transfer well past twenty seconds still saves, and the deadline is ten minutes for the whole save', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const url = 'https://v.example.invalid/a.mp4';
  const ends = [];
  let finish = null;
  const slow = startSave({ url, name: 'a.mp4', api: { download: (options) => { finish = options.onload; return { abort() {} }; } }, doc: fakeDoc() });
  slow.done.then((how) => ends.push(how), (error) => ends.push(error.message));
  t.mock.timers.tick(25000);
  await nextTurn();
  assert.deepEqual(ends, []);
  finish();
  await nextTurn();
  assert.deepEqual(ends, ['manager']);

  const stuck = startSave({ url, name: 'b.mp4', api: { download: () => ({ abort() {} }) }, doc: fakeDoc() });
  stuck.done.catch((error) => ends.push(error.message));
  t.mock.timers.tick(599999);
  await nextTurn();
  assert.deepEqual(ends, ['manager']);
  t.mock.timers.tick(1);
  await nextTurn();
  assert.deepEqual(ends, ['manager', 'it took too long']);
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

const press = (win, target, name, init = {}) => {
  const event = new win.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

test('Tab to a photo brings its Download button up, steps onto it and moves on past it', async () => {
  const win = page('<a class="before" href="/x">x</a><div class="post" tabindex="0"><a class="photo" href="/photo/?fbid=1"><img></a><div class="like" tabindex="0">Like</div></div><a class="other" href="/photo/?fbid=2"><img class="two"></a>');
  const doc = win.document;
  const [post, link, img, like, other, two] = ['.post', 'a.photo', 'a.photo img', '.like', 'a.other', 'img.two'].map((s) => doc.querySelector(s));
  box(post, [100, 0, 600, 900]);
  box(link, [100, 100, 600, 400]);
  box(img, [100, 100, 600, 400]);
  box(like, [100, 510, 100, 30]);
  // An inline link's box can be empty around the photo it holds.
  box(other, [0, 0, 0, 0]);
  box(two, [100, 1000, 600, 400]);
  let on = false;
  const saved = [];
  const button = createDownloadButton({ doc, win, active: () => on, find: (element) => ({ what: element.className || 'one' }), run: async (found) => saved.push(found.what) });
  press(win, doc.body, 'Tab');
  link.focus();
  assert.equal(button.state().shown, false, 'switched off, focus brings nothing up');
  on = true;
  post.focus();
  assert.equal(button.state().shown, false, 'a whole post is not the photo in it, even with its middle on the photo');
  link.focus();
  assert.equal(button.state().shown, true, 'no pointer move needed');
  assert.equal(button.state().top, '110px');
  const host = doc.querySelector('[data-hushfacebook-web="download"]');

  assert.equal(press(win, link, 'Tab', { ctrlKey: true }).defaultPrevented, false, 'Ctrl+Tab is the browser\'s');
  const trap = (event) => event.preventDefault();
  win.addEventListener('keydown', trap, true);
  press(win, link, 'Tab');
  assert.ok(doc.activeElement === link, 'a Tab the page already took is left alone');
  win.removeEventListener('keydown', trap, true);
  assert.equal(press(win, link, 'Tab').defaultPrevented, true);
  assert.ok(doc.activeElement === host, 'Tab lands on the button next');
  button.click();
  await frame();
  assert.deepEqual(saved, ['one']);
  assert.equal(press(win, host, 'Tab').defaultPrevented, false, "the browser's own Tab moves on");
  assert.ok(doc.activeElement === link, 'from the element focus reached');
  press(win, link, 'Tab');
  assert.equal(press(win, host, 'Tab', { shiftKey: true }).defaultPrevented, true);
  assert.ok(doc.activeElement === link, 'Shift+Tab goes back to it');
  assert.equal(press(win, link, 'Tab', { shiftKey: true }).defaultPrevented, false);

  like.focus();
  assert.equal(button.state().shown, false, 'a Like button under the photo is not the photo');
  press(win, like, 'Tab', { shiftKey: true });
  link.focus();
  assert.ok(doc.activeElement === host, 'coming back up with Shift+Tab, the button comes before its photo');
  assert.equal(press(win, host, 'Tab', { shiftKey: true }).defaultPrevented, true);
  assert.ok(doc.activeElement === link);
  link.focus();
  assert.equal(button.state().shown, true);
  doc.dispatchEvent(new win.PointerEvent('pointerdown'));
  like.focus();
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(button.state().shown, false, 'a click that moves focus away lets the button go');
  other.focus();
  assert.equal(button.state().shown, false, 'focus a click gave leaves the button to the pointer');
  press(win, other, 'Tab', { shiftKey: true });
  like.focus();
  press(win, like, 'Tab');
  other.focus();
  assert.ok(doc.activeElement === other, 'going forward, focus stays where the browser put it');
  button.click();
  await frame();
  assert.deepEqual(saved, ['one', 'two'], 'a link with an empty box still holds its photo');

  // Shift+Tab ends on an element with no photo, and the page moves focus to the photo later.
  like.focus();
  press(win, like, 'Tab', { shiftKey: true });
  doc.querySelector('a.before').focus();
  link.focus();
  assert.ok(doc.activeElement === link, 'focus the page moves afterwards is not Shift+Tab coming up');
  button.stop();
});

test('Download and Pop out on a focused player step in row order and hold through scroll and redraws', async () => {
  const win = page('<div class="player"><video class="first"></video><div class="controls"><div class="play" tabindex="0" role="button"></div><div class="mute" tabindex="0" role="button"></div></div></div><a class="after" href="/y">y</a><video class="elsewhere"></video>');
  const doc = win.document;
  const [first, play, mute, elsewhere] = ['video.first', '.play', '.mute', 'video.elsewhere'].map((s) => doc.querySelector(s));
  box(first, [0, 0, 640, 360]);
  box(play, [10, 320, 30, 30]);
  box(mute, [50, 320, 30, 30]);
  box(elsewhere, [0, 400, 640, 360]);
  doc.elementsFromPoint = () => [elsewhere];
  let on = true;
  const saved = [];
  const find = (element) => (on ? { what: element.className } : null);
  const download = createDownloadButton({ doc, win, active: () => on, find, run: async (found) => saved.push(found.what) });
  const pop = createDownloadButton({ doc, win, active: () => on, find, run: async () => {}, name: 'picture-in-picture', text: 'Pop out', row: 1 });
  const [downloadHost, popHost] = ['download', 'picture-in-picture'].map((name) => doc.querySelector(`[data-hushfacebook-web="${name}"]`) ?? name);
  press(win, doc.body, 'Tab');
  play.focus();
  assert.equal(download.state().shown && pop.state().shown, true);
  const hosts = () => [doc.querySelector('[data-hushfacebook-web="download"]'), doc.querySelector('[data-hushfacebook-web="picture-in-picture"]')];
  assert.equal(typeof downloadHost, 'string', 'no box before anything needed one');
  assert.equal(typeof popHost, 'string');
  const [dl, pp] = hosts();

  press(win, play, 'Tab');
  assert.ok(doc.activeElement === dl);
  press(win, dl, 'Tab');
  assert.ok(doc.activeElement === pp, 'rows in order');
  assert.equal(press(win, pp, 'Tab').defaultPrevented, false);
  assert.ok(doc.activeElement === play);
  mute.focus();
  assert.equal(pop.state().shown, true, 'the next control of the same player keeps the buttons');
  assert.equal(press(win, mute, 'Tab').defaultPrevented, false, 'and Tab from it is the browser\'s');
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 100, clientY: 500 }));
  await frame();
  assert.equal(download.state().top, '10px', 'focus on a control of the player holds the buttons there');
  play.focus();
  press(win, play, 'Tab');
  press(win, dl, 'Tab');
  assert.equal(press(win, pp, 'Tab', { shiftKey: true }).defaultPrevented, true);
  assert.ok(doc.activeElement === dl);
  const after = doc.querySelector('a.after');
  box(after, [0, 380, 50, 20]);
  after.focus();
  assert.equal(download.state().shown, false, 'past the player, the buttons go');
  press(win, after, 'Tab', { shiftKey: true });
  mute.focus();
  assert.ok(doc.activeElement === pp, 'Shift+Tab back into the player comes to its last button first');
  press(win, pp, 'Tab', { shiftKey: true });
  assert.ok(doc.activeElement === dl);
  press(win, dl, 'Tab', { shiftKey: true });
  assert.ok(doc.activeElement === mute, 'then to the control focus came up to');
  press(win, mute, 'Tab');
  assert.ok(doc.activeElement === dl);

  // The pointer wanders over another video while focus is on the button.
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 100, clientY: 500 }));
  await frame();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(download.state().shown, true, 'the pointer does not take a focused button away');
  box(first, [0, -500, 640, 360]);
  win.dispatchEvent(new win.Event('scroll'));
  await frame();
  assert.equal(download.state().shown, true, 'scrolled off screen, it stays');
  assert.deepEqual([download.state().top, pop.state().top], ['10px', '54px']);
  box(first, [0, 2000, 640, 360]);
  win.dispatchEvent(new win.Event('scroll'));
  await frame();
  assert.deepEqual([download.state().top, pop.state().top], [`${win.innerHeight - 88}px`, `${win.innerHeight - 44}px`], 'below the screen, both stay in view, in order');

  // Facebook draws the player's video again as a new element.
  const second = doc.createElement('video');
  second.className = 'second';
  box(second, [0, 0, 640, 360]);
  first.replaceWith(second);
  download.click();
  await frame();
  assert.deepEqual(saved, ['second'], 'the video the focused player holds now, not the one under the pointer');
  const third = doc.createElement('video');
  third.className = 'third';
  box(third, [0, 100, 640, 360]);
  second.replaceWith(third);
  win.dispatchEvent(new win.Event('scroll'));
  await frame();
  assert.equal(download.state().top, '110px', 'the button moves to the new video on its own');

  on = false;
  assert.equal(press(win, dl, 'Tab').defaultPrevented, false, 'paused, Tab is the browser\'s');
  assert.equal(download.state().shown || pop.state().shown, false, 'and the buttons left up go');
  on = true;
  play.focus();
  assert.equal(download.state().shown, true);
  on = false;
  win.dispatchEvent(new win.Event('scroll'));
  await frame();
  assert.equal(download.state().shown, false, 'paused, a held button goes at the next scroll too');
  download.click();
  await frame();
  assert.deepEqual(saved, ['second'], 'switched off, nothing saves');
  on = true;
  const removed = [];
  const remove = doc.removeEventListener.bind(doc);
  doc.removeEventListener = (type, listener, options) => {
    removed.push(options === true || options?.capture ? `${type} capture` : type);
    return remove(type, listener, options);
  };
  download.stop();
  assert.equal(removed.includes('keydown capture'), false, 'Pop out still needs the page\'s Tab');
  pop.stop();
  assert.deepEqual(['keydown capture', 'pointerdown capture', 'focusin'].map((type) => removed.includes(type)), [true, true, true], 'the last one out takes the listeners');
  assert.ok(hosts().every((found) => found === null), 'both boxes go');
  play.focus();
  assert.equal(press(win, play, 'Tab').defaultPrevented, false, 'stopped buttons leave Tab alone');
  assert.ok(hosts().every((found) => found === null), 'and focus brings nothing back');
});

test('a focused button stays while the mouse passes over it, and a clicked one still goes with its video', async () => {
  const win = page('<a class="photo" href="/photo/?fbid=1"><img></a><video></video>');
  const doc = win.document;
  const [link, img, videoEl] = ['a.photo', 'img', 'video'].map((s) => doc.querySelector(s));
  box(link, [0, 0, 600, 400]);
  box(img, [0, 0, 600, 400]);
  box(videoEl, [0, 500, 600, 400]);
  doc.elementsFromPoint = () => [videoEl];
  // The button's shadow root is closed. Kept open here so the test can reach the button.
  const attach = win.HTMLElement.prototype.attachShadow;
  win.HTMLElement.prototype.attachShadow = function (init) {
    return attach.call(this, { ...init, mode: 'open' });
  };
  const button = createDownloadButton({ doc, win, active: () => true, find: () => ({}), run: async () => {} });
  press(win, doc.body, 'Tab');
  link.focus();
  press(win, link, 'Tab');
  const inner = doc.querySelector('[data-hushfacebook-web="download"]').shadowRoot.querySelector('button');
  inner.dispatchEvent(new win.PointerEvent('pointerenter'));
  inner.dispatchEvent(new win.PointerEvent('pointerleave'));
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(button.state().shown, true, 'the mouse going by does not take a focused button away');

  link.remove();
  assert.equal(press(win, inner, 'Tab', { shiftKey: true, composed: true }).defaultPrevented, false, 'with the photo gone, Shift+Tab is the browser\'s');

  // A click on the page takes focus off the button.
  doc.dispatchEvent(new win.PointerEvent('pointerdown'));
  inner.blur();
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 100, clientY: 600 }));
  await frame();
  assert.equal(button.state().top, '510px', 'the pointer has it now');
  inner.focus();
  box(videoEl, [0, -900, 600, 400]);
  win.dispatchEvent(new win.Event('scroll'));
  await frame();
  assert.equal(button.state().shown, false, 'a button the mouse brought up goes with its video, focused or not');
  button.stop();
  win.HTMLElement.prototype.attachShadow = attach;
});

test("on a reel the buttons start below Facebook's Pause, Unmute and More options, and other buttons don't move them", async () => {
  // A reel as drawn live on 2026-10-22: its controls 20 px down the video's top right corner, in a
  // box 8 levels up, and its Like column beside the video. Pause is a real button here, and the
  // tallest, and the Menu starts above the video and reaches into it.
  const win = page(`<div class="card"><div><div class="bar"><button aria-label="Pause"></button><div role="button" aria-label="Unmute"></div>
    <div role="button" aria-label="More options"></div></div><div role="button" aria-label="Menu" class="above"></div>
    <div role="button" aria-label="Like" class="side"></div><div role="button" aria-label="Captions" class="low"></div>
    <div role="button" aria-label="Follow" class="left"></div><div role="button" aria-label="Wide" class="wide"></div><div role="button" class="flat"></div>
    <div><div><div><div><div><div><div><div><video></video></div></div></div></div></div></div></div></div></div></div>`);
  const doc = win.document;
  const video = doc.querySelector('video');
  box(video, [100, 50, 500, 900]);
  const at = (selector, rect) => box(doc.querySelector(selector), rect);
  at('[aria-label="Pause"]', [512, 70, 28, 24]);
  at('[aria-label="Unmute"]', [540, 70, 28, 20]);
  at('[aria-label="More options"]', [568, 70, 28, 20]);
  at('.above', [560, 20, 20, 100]);
  at('.side', [620, 60, 40, 40]);
  at('.low', [560, 130, 30, 30]);
  at('.left', [380, 60, 20, 60]);
  at('.wide', [100, 50, 501, 60]);
  at('.flat', [560, 120, 30, 0]);
  doc.elementsFromPoint = () => [video];
  const download = createDownloadButton({ doc, win, active: () => true, find: () => ({}), run: async () => {} });
  const pop = createDownloadButton({ doc, win, active: () => true, find: () => ({}), run: async () => {}, name: 'pip', text: 'Pop out', row: 1 });
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 300, clientY: 500 }));
  await frame();
  assert.deepEqual([download.state().top, pop.state().top], ['99px', '143px'], 'below the lowest of the controls, 44 px down, in row order');
  assert.equal(download.state().right, `${win.innerWidth - 600 + 10}px`);
  assert.equal(cornerControls(video), 44);
  for (const selector of ['[aria-label="Unmute"]', '[aria-label="More options"]']) doc.querySelector(selector).remove();
  at('[aria-label="Pause"]', [512, 70, 28, 2]);
  assert.equal(cornerControls(video), 22, 'its lowest edge counts');
  doc.querySelector('[aria-label="Pause"]').remove();
  assert.equal(cornerControls(video), 0, 'a menu above it, the Like column beside it, a button lower down or further left, a wider one and an empty one count for nothing');
  win.dispatchEvent(new win.Event('resize'));
  await frame();
  assert.deepEqual([download.state().top, pop.state().top], ['60px', '104px'], 'with nothing in the corner, 10 px down as before');
  const far = page(`<div><div role="button" class="far"></div>${'<div>'.repeat(9)}<video></video>${'</div>'.repeat(9)}</div>`);
  const farVideo = far.document.querySelector('video');
  box(farVideo, [0, 0, 400, 400]);
  box(far.document.querySelector('.far'), [360, 10, 30, 30]);
  assert.equal(cornerControls(farVideo), 0, "a button more than nine levels up isn't the player's");
  const near = page(`<div><div role="button" class="near"></div>${'<div>'.repeat(8)}<video></video>${'</div>'.repeat(8)}</div>`);
  const nearVideo = near.document.querySelector('video');
  box(nearVideo, [0, 0, 400, 400]);
  box(near.document.querySelector('.near'), [360, 10, 30, 30]);
  assert.equal(cornerControls(nearVideo), 40, 'nine levels up still is');
  download.stop();
  pop.stop();
});

test('floating controls follow resized media without another pointer move', async () => {
  const win = page('<video></video>');
  const doc = win.document;
  const video = doc.querySelector('video');
  box(video, [100, 50, 600, 400]);
  doc.elementsFromPoint = () => [video];
  const button = createDownloadButton({ doc, win, active: () => true, find: () => ({}), run: async () => {} });
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 200, clientY: 100 }));
  await frame();
  box(video, [20, 80, 300, 200]);
  win.dispatchEvent(new win.Event('resize'));
  await frame();
  assert.equal(button.state().top, '90px');
  assert.equal(button.state().right, `${win.innerWidth - 320 + 10}px`);
  box(video, [20, win.innerHeight - 20, 300, 200]);
  win.dispatchEvent(new win.Event('resize'));
  await frame();
  assert.equal(button.state().top, `${win.innerHeight - 10}px`, 'the pointer\'s button stays on its media near the bottom edge');
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
  assert.equal(rule.observe, true, 'it reads what the page gets, after the rules that edit');
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
  assert.deepEqual(toasts, ['Saved Pat Example photo 9999999.jpg'], 'a quick save gets no notice while it runs');
  // Cancelled in the manager: a plain note, not an error.
  api.download = (options) => options.onerror({ error: 'not_succeeded', details: 'USER_CANCELED' });
  toasts.length = 0;
  await shared.run(found, doc.body);
  assert.deepEqual(toasts, ['Cancelled Pat Example photo 9999999.jpg']);
});

test('a save still going after a moment says so, and its Cancel stops the transfer and clears the notice', async (t) => {
  const win = page(POST('<a href="/photo/?fbid=9999999"><img></a>'));
  const doc = win.document;
  const rules = [];
  const toasts = [];
  const aborted = [];
  let finish = null;
  const api = {
    download: ({ onload }) => {
      finish = onload;
      return { abort: () => aborted.push('download') };
    },
    request: () => assert.fail('a cancel started a fallback'),
  };
  downloadPhotos.setup({
    win, doc, api, net: { transformResponses: (rule) => rules.push(rule) }, router: { current: () => ({ href: win.location.href }) },
    log: { error() {}, warn() {}, info() {} },
    toast: (message, options) => {
      const entry = { message, options, dismissed: false };
      toasts.push(entry);
      return { dismiss: () => { entry.dismissed = true; } };
    },
    enabled: () => true,
    option: () => 'best',
  });
  rules[0].transform({ p: photo('9999999') });
  const shared = downloads({ doc });
  const found = findMedia(doc.querySelector('img'), { href: win.location.href, index: shared.index });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const slow = shared.run(found, doc.body);
  t.mock.timers.tick(1499);
  assert.deepEqual(toasts, []);
  t.mock.timers.tick(1);
  assert.equal(toasts.length, 1);
  const [notice] = toasts;
  assert.equal(notice.message, 'Saving Pat Example photo 9999999.jpg');
  assert.equal(notice.options.duration, Infinity, 'it stays while the save runs');
  assert.equal(notice.options.action.label, 'Cancel');
  notice.options.action.run();
  await slow;
  assert.deepEqual(aborted, ['download'], "the manager's transfer is stopped");
  assert.equal(notice.dismissed, true);
  assert.deepEqual(toasts.map((entry) => entry.message), ['Saving Pat Example photo 9999999.jpg', 'Cancelled Pat Example photo 9999999.jpg']);
  finish();

  // One that finishes after the notice is up clears it and says Saved.
  toasts.length = 0;
  const later = shared.run(found, doc.body);
  t.mock.timers.tick(5000);
  finish();
  await later;
  assert.equal(toasts[0].dismissed, true);
  assert.deepEqual(toasts.map((entry) => entry.message), ['Saving Pat Example photo 9999999.jpg', 'Saved Pat Example photo 9999999.jpg']);
});

// The panel turns every error-level entry into a notice of its own, so a save that already
// says why it failed logs a warning: one notice, and the details still in Diagnostics.
test('a failed save says why in one notice and keeps the details for Diagnostics', async () => {
  const win = page(POST('<a href="/photo/?fbid=9999999"><img></a>'));
  const doc = win.document;
  const rules = [];
  const toasts = [];
  const logged = [];
  const api = {
    download: ({ onerror }) => {
      onerror({ error: 'not_whitelisted' });
      return {};
    },
    request: ({ onerror }) => {
      onerror();
      return {};
    },
  };
  downloadPhotos.setup({
    win, doc, api, net: { transformResponses: (rule) => rules.push(rule) }, router: { current: () => ({ href: win.location.href }) },
    log: Object.fromEntries(['error', 'warn', 'info'].map((level) => [level, (message) => logged.push([level, message])])),
    toast: (message, options) => {
      toasts.push([message, options?.tone]);
      return { dismiss() {} };
    },
    enabled: () => true,
    option: () => 'best',
  });
  rules[0].transform({ p: photo('9999999') });
  const shared = downloads({ doc });
  await shared.run(findMedia(doc.querySelector('img'), { href: win.location.href, index: shared.index }), doc.body);
  assert.deepEqual(toasts, [["Couldn't save it: the file couldn't be fetched.", 'error']]);
  assert.deepEqual(logged, [['warn', "Couldn't save a photo or video"]]);

  // A streamed video ten hours long says how big it would be.
  toasts.length = 0;
  const stream = { live: false, duration: 36000, video: [{ url: 'https://video.example.invalid/7.mp4', quality: 240, bandwidth: 2e6 }], audio: null };
  await shared.run({ feature: 'downloadPhotos', kind: 'video', id: '7', author: 'Pat', item: { kind: 'video', id: '7', files: [], dash: true, stream } }, doc.body);
  assert.deepEqual(toasts, [['This video is too long to put together in the browser (about 9000 MB at its smallest).', 'error']]);

  // One that fits asks for its picture and its sound.
  toasts.length = 0;
  const asked = [];
  api.request = ({ url, onerror }) => {
    asked.push(url);
    onerror();
    return {};
  };
  const joinable = { ...stream, duration: 10, audio: { url: 'https://video.example.invalid/7-sound.mp4', bandwidth: 64000 } };
  await shared.run({ feature: 'downloadPhotos', kind: 'video', id: '7', author: 'Pat', item: { kind: 'video', id: '7', files: [], dash: true, stream: joinable } }, doc.body);
  assert.deepEqual(asked, ['https://video.example.invalid/7.mp4', 'https://video.example.invalid/7-sound.mp4']);
});
