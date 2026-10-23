// Hide the video comment box against the video viewer as drawn live on 2026-10-22, signed out on a
// NASA video: the WatchPermalinkVideo pagelet with the description under it, and beside them the
// column with the post and its comments. Signed in that column also holds the comment box, the
// form[role=presentation] around a text box that posts use (comment-stickers.test.js).

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import hideVideoCommentBox, { MARK, commentColumns, createVideoCommentBoxHider, markVideoCommentBoxes } from '../src/features/comments/hide-video-comment-box.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const box = (id) => `<form role="presentation" id="${id}"><div><div role="textbox" contenteditable="true" aria-label="Write a comment…"></div></div></form>`;

const viewer = ({ comments = true } = {}) => `
<div id="row">
  <div id="left">
    <div data-pagelet="WatchPermalinkVideo"><div><video></video></div></div>
    <div id="description">The aircraft lineup just keeps getting bigger.</div>
  </div>
  <div id="column">
    <div>NASA</div>
    ${comments ? '<div role="article" aria-label="Comment by Someone"></div>' : ''}
    <form role="presentation" id="no-box"><div role="button">Search</div></form>
    ${box('viewer')}
    <div id="thread">${box('reply')}</div>
  </div>
</div>
<div role="main">
  <div aria-posinset="1">${box('more')}</div>
</div>`;

function page(html, url = 'https://www.facebook.com/NASA/videos/1557618349384047/') {
  const win = testWindow(url);
  windows.push(win);
  win.document.body.innerHTML = html;
  return win;
}

const marked = (doc) => [...doc.querySelectorAll(`[${MARK}]`)].map((form) => form.id);

test('the boxes in the column beside the video hide, and none anywhere else', () => {
  const doc = page(`${viewer()}
    <div aria-posinset="2">${box('feed')}</div>
    <div role="dialog"><div role="article"></div>${box('dialog')}</div>
    <div role="dialog">${box('chat')}</div>`).document;
  assert.deepEqual(commentColumns(doc).map((column) => column.id), ['column']);
  assert.equal(markVideoCommentBoxes(doc), 2);
  assert.deepEqual(marked(doc), ['viewer', 'reply'], 'the video\'s own boxes, and not the search form, the more-videos post, the feed, a post dialog or a chat');
  assert.equal(markVideoCommentBoxes(doc), 0, 'counted once');
});

test('a video with no comments yet still has its box found by the box itself', () => {
  const doc = page(viewer({ comments: false })).document;
  markVideoCommentBoxes(doc);
  assert.deepEqual(marked(doc), ['viewer', 'reply']);
});

test('without the video viewer, or with nothing beside the video close by, nothing hides', () => {
  // Home's own pagelets sit right beside posts.
  const posts = page(`<div role="main"><div data-pagelet="Stories"></div>
    <div data-pagelet="FeedUnit_0"><div aria-posinset="1"><div role="article"></div>${box('feed')}</div></div></div>`, 'https://www.facebook.com/').document;
  assert.equal(markVideoCommentBoxes(posts), 0);
  // A post four levels up from the video isn't its column.
  const far = page(`<div id="d1">
    <div id="d2"><div id="d3"><div id="d4"><div id="d5"><div data-pagelet="WatchPermalinkVideo"><video></video></div></div></div></div></div>
    <div aria-posinset="1"><div role="article"></div>${box('far')}</div>
  </div>`).document;
  assert.deepEqual([commentColumns(far).length, markVideoCommentBoxes(far)], [0, 0]);
  // Signed out the column has comments and no box: it's still the column, so the search goes no
  // higher, to the more-videos post.
  const signedOut = page(viewer().replace(box('viewer'), '').replace(box('reply'), '')).document;
  assert.deepEqual([commentColumns(signedOut).map((column) => column.id), markVideoCommentBoxes(signedOut)], [['column'], 0]);
});

test('a box that leaves the column is let go, and boxes drawn later are caught', async () => {
  const win = page(viewer());
  const doc = win.document;
  let on = true;
  const hider = createVideoCommentBoxHider({ doc, enabled: () => on, setTimer: (fn) => win.setTimeout(fn, 0) });
  hider.start();
  assert.deepEqual(marked(doc), ['viewer', 'reply']);
  doc.querySelector('[role="main"]').append(doc.getElementById('reply'));
  doc.getElementById('thread').insertAdjacentHTML('beforeend', box('later'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(marked(doc), ['viewer', 'later']);
  assert.equal(hider.hidden(), 3);
  on = false;
  hider.sync();
  assert.deepEqual(marked(doc), [], 'switching off brings them back');
});

test('the feature starts off, hides only its own marks and reports to Diagnostics', () => {
  const win = page(viewer());
  const rows = [];
  hideVideoCommentBox.setup({ doc: win.document, enabled: () => true, diagnostics: { add: (label, read) => rows.push([label, read]) } });
  assert.deepEqual([rows[0][0], rows[0][1]()], ['Video comment boxes hidden', '2']);
  assert.deepEqual([hideVideoCommentBox.id, hideVideoCommentBox.section, hideVideoCommentBox.default], ['hideVideoCommentBox', 'comments', false]);
  assert.equal(hideVideoCommentBox.css, `[${MARK}] { display: none !important; }`);
});
