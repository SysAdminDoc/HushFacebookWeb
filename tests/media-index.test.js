// The downloads index observes Facebook's parsed answers through the real network hooks.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { installNetworkHooks } from '../src/core/net/hooks.js';
import { downloads } from '../src/features/downloads/shared.js';
import downloadPhotos from '../src/features/downloads/download-photos.js';
import downloadVideos from '../src/features/downloads/download-videos.js';

const PICTURE = 'https://video.xx.fbcdn.net/picture.mp4';
const SOUND = 'https://video.xx.fbcdn.net/sound.mp4';
const MANIFEST = `<MPD type="static" mediaPresentationDuration="PT10S"><Period>
  <AdaptationSet contentType="video"><Representation bandwidth="100000" width="640" height="360">
    <BaseURL>${PICTURE}</BaseURL><SegmentBase indexRange="0-1"/>
  </Representation></AdaptationSet>
  <AdaptationSet contentType="audio"><Representation bandwidth="64000">
    <BaseURL>${SOUND}</BaseURL><SegmentBase indexRange="0-1"/>
  </Representation></AdaptationSet>
</Period></MPD>`;

function setup(t, feature, html, href) {
  const win = testWindow(href);
  const doc = win.document;
  doc.body.innerHTML = html;
  const errors = [];
  const log = { error: (...args) => errors.push(args), warn() {}, info() {} };
  const net = installNetworkHooks({ win, log });
  const saved = [];
  feature.setup({
    win, doc, net, log, enabled: () => true, option: () => 'best',
    api: { download: ({ url, onload }) => { saved.push(url); onload(); } },
    router: { current: () => ({ href: win.location.href }) },
  });
  t.after(async () => {
    net.teardown();
    await win.happyDOM.close();
    assert.equal(errors.length, 0, 'the registered observer reported no errors');
  });
  return { win, doc, saved, shared: downloads({ doc }) };
}

for (const format of ['legacy', 'modern']) {
  test(`the registered observer indexes a ${format} manifest without progressive file fields`, (t) => {
    const { win, doc, shared } = setup(t, downloadVideos, '<video></video>', 'https://www.facebook.com/watch/?v=1234567');
    const delivery = format === 'legacy'
      ? { dash_manifest: MANIFEST }
      : { videoDeliveryResponseFragment: { videoDeliveryResponseResult: { dash_manifests: [{ manifest_xml: MANIFEST }] } } };
    win.JSON.parse(JSON.stringify({ data: { video: { __typename: 'Video', id: '1234567', ...delivery } } }));
    const found = shared.find(doc.querySelector('video'));
    assert.equal(found.item?.stream?.video[0]?.url, PICTURE);
    assert.equal(found.item?.stream?.audio?.url, SOUND);
  });
}

test('a photo save uses its refreshed signed URL at the same size and keeps it over a smaller copy', async (t) => {
  const fresh = 'https://scontent.xx.fbcdn.net/photo.jpg?oe=fresh';
  const { win, doc, shared, saved } = setup(t, downloadPhotos,
    `<a href="/photo/?fbid=1234567"><img src="${fresh}"></a>`, 'https://www.facebook.com/');
  const receive = (url, width, height) => win.JSON.parse(JSON.stringify({ data: { photo: {
    __typename: 'Photo', id: '1234567', viewer_image: { uri: url, width, height },
  } } }));
  receive('https://scontent.xx.fbcdn.net/photo.jpg?oe=expired', 2048, 1536);
  receive(fresh, 2048, 1536);
  receive('https://scontent.xx.fbcdn.net/photo-small.jpg?oe=fresh', 1024, 768);
  await shared.run(shared.find(doc.querySelector('img')), doc.body);
  assert.deepEqual(saved, [fresh]);
});
