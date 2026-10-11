// Hide GIF and sticker buttons against a comment box as drawn live on 2026-10-11
// (captures/2026-10-11-run13, Page and group posts opened over Home): a form[role=presentation]
// around the text box, with avatar sticker, GIF and sticker buttons that draw a sprite <i>, an
// emoji button that draws an svg, and Post comment without a pop-up.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import hideCommentStickers, { MARK, createStickerHider, isCommentForm, markStickerButtons } from '../src/features/comments/hide-comment-stickers.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const sprite = (y) => `<i style="background-image: url(&quot;/rsrc.php/yH/r/sprite.webp&quot;); background-position: 0px ${y}px;"></i>`;
const commentBox = (label = 'Write a comment…') => `
<form role="presentation"><div><div>
  <div role="textbox" contenteditable="true" aria-label="${label}" data-lexical-editor="true"></div>
  <div>
    <div role="button" aria-haspopup="menu" aria-expanded="false" aria-label="Comment with an avatar sticker" data-k="avatar">${sprite(-588)}</div>
    <div role="button" aria-haspopup="menu" aria-expanded="false" aria-label="Insert an emoji" data-k="emoji"><svg><path d="M10.75 8a1.25 1.25 0 1 0 0-2.5"></path></svg></div>
    <div role="button" aria-haspopup="menu" aria-expanded="false" aria-label="Comment with a GIF" data-k="gif">${sprite(-639)}</div>
    <div role="button" aria-haspopup="menu" aria-expanded="false" aria-label="Comment with a sticker" data-k="sticker">${sprite(-707)}</div>
  </div>
  <div role="button" aria-disabled="true" aria-label="Post comment" data-k="post"><svg><path d="M1.32 6.2"></path></svg></div>
</div></div></form>`;

function page(html) {
  const win = new Window({ url: 'https://www.facebook.com/' });
  windows.push(win);
  win.document.body.innerHTML = html;
  return win;
}

const marked = (doc) => [...doc.querySelectorAll(`[${MARK}]`)].map((el) => el.dataset.k).sort();

test('avatar sticker, GIF and sticker go, emoji and Post comment stay, in any language', () => {
  const english = page(`<div role="dialog"><div role="article" aria-label="Comment by Pat Example"></div>${commentBox()}</div>`);
  assert.equal(markStickerButtons(english.document), 3);
  assert.deepEqual(marked(english.document), ['avatar', 'gif', 'sticker']);
  const spanish = page(`<div role="dialog"><div role="article"></div>${commentBox('Escribe un comentario…').replace(/aria-label="[^"]*"/g, 'aria-label="x"')}</div>`);
  assert.deepEqual((markStickerButtons(spanish.document), marked(spanish.document)), ['avatar', 'gif', 'sticker']);
});

test('only comment boxes on a post count', () => {
  const doc = page(`
    <div role="main" id="permalink">${commentBox()}</div>
    <div aria-posinset="1" id="feed">${commentBox()}</div>
    <div role="dialog" id="post-dialog"><div role="article"></div>${commentBox()}</div>
    <div role="dialog" id="chat">${commentBox('Aa')}</div>
    <div id="loose">${commentBox()}</div>
    <form role="presentation" id="no-box"><div role="button" aria-haspopup="menu">${sprite(-1)}</div></form>`).document;
  const forms = [...doc.querySelectorAll('form')].map((form) => [form.parentElement.id || form.id, isCommentForm(form)]);
  assert.deepEqual(forms, [['permalink', true], ['feed', true], ['post-dialog', true], ['chat', false], ['loose', false], ['no-box', false]]);
});

test('boxes drawn later are caught, and switching off brings the buttons back', async () => {
  const win = page('<div role="main"></div>');
  const doc = win.document;
  let on = true;
  const hider = createStickerHider({ doc, enabled: () => on, setTimer: (fn) => win.setTimeout(fn, 0) });
  hider.start();
  doc.querySelector('[role="main"]').insertAdjacentHTML('beforeend', commentBox());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(marked(doc), ['avatar', 'gif', 'sticker']);
  assert.equal(hider.hidden(), 3);
  on = false;
  hider.sync();
  assert.deepEqual(marked(doc), []);
});

test('the feature starts off, hides only its own marks and reports to Diagnostics', () => {
  const win = page(`<div role="main">${commentBox()}</div>`);
  const rows = [];
  hideCommentStickers.setup({ doc: win.document, enabled: () => true, diagnostics: { add: (label, read) => rows.push([label, read]) } });
  assert.equal(rows[0][0], 'Comment box buttons hidden');
  assert.equal(rows[0][1](), '3');
  assert.equal(hideCommentStickers.default, false);
  assert.equal(hideCommentStickers.css, `[${MARK}] { display: none !important; }`);
});
