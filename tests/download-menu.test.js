// Download in post menus against a post's three-dot menu as drawn live on 2026-10-22, signed out
// on NASA's Page: the menu is a role=menu ("Feed story") in a layer of its own, with role=button
// rows (Embed, then Report post with a second line) split by an hr. Other Facebook menus use
// role=menuitem rows, so both are covered.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import downloadMenu, { ROW_MARK, buildRow, createMenuDownload, mediaOf, openPost } from '../src/features/downloads/download-menu.js';
import downloadPhotos from '../src/features/downloads/download-photos.js';
import { DOWNLOAD_ICON } from '../src/features/downloads/button.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const dots = (id, label) => `<div role="button" aria-haspopup="menu" aria-expanded="false" aria-label="${label}" id="${id}"></div>`;
const photo = (id, fbid) => `<a href="/photo/?fbid=${fbid}&amp;set=a.1"><img id="${id}" src="https://scontent.example.invalid/${fbid}.jpg"></a>`;

const PAGE = `
<div aria-posinset="1" id="post">
  <h3><a href="/NASA"><strong>NASA</strong></a></h3>
  ${dots('dots', 'Actions for this post by NASA')}
  <img id="emoji" src="https://static.example.invalid/emoji.png">
  ${photo('photo', '1234567')}
  ${photo('second', '2345678')}
  <div role="article" aria-label="Comment by Someone" id="comment">
    ${dots('report', 'Report this')}
    ${photo('comment-photo', '7654321')}
  </div>
</div>
<div aria-posinset="2" id="text-post">
  <h3><a href="/NASA">NASA</a></h3>
  ${dots('text-dots', 'Actions for this post by NASA')}
  <div>Just words.</div>
</div>
<div id="layers"></div>`;

const row = (id, role, words, tabindex) => `<div role="${role}" tabindex="${tabindex}" id="${id}" aria-label="${words[0]}">
  <div><svg aria-hidden="true" width="20" height="20"><path d="M0 0"></path></svg></div>
  <div><div>${words.map((w) => `<div><span>${w}</span></div>`).join('')}</div></div>
  <div role="none"></div>
</div>`;

const MENU = (role = 'button') => `<div role="menu" aria-label="Feed story"><div><div><div aria-hidden="false"><div><div><div id="rows">
  ${row('embed', role, ['Embed'], 0)}
  <hr>
  ${row('report-post', role, ['Report post', "We won't let NASA know who reported this."], -1)}
</div></div></div></div></div></div></div>`;

function page(html = PAGE) {
  const win = testWindow('https://www.facebook.com/NASA');
  windows.push(win);
  win.document.body.innerHTML = html;
  return win;
}

// Facebook's three-dot buttons: a click opens the menu in the layers, a second closes it.
function wireMenus(doc, role = 'button', { later = 0 } = {}) {
  for (const button of doc.querySelectorAll('[aria-haspopup="menu"]')) {
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') === 'true';
      for (const other of doc.querySelectorAll('[aria-expanded="true"]')) other.setAttribute('aria-expanded', 'false');
      doc.getElementById('layers').replaceChildren();
      if (open) return;
      button.setAttribute('aria-expanded', 'true');
      const draw = () => {
        if (button.getAttribute('aria-expanded') === 'true') doc.getElementById('layers').innerHTML = MENU(role);
      };
      if (later) doc.defaultView.setTimeout(draw, later);
      else draw();
    });
  }
}

// Saves photos, as Download any photo does, by the photo's link.
const findPhoto = (on = () => true) => (media) => {
  const href = media.closest('a[href]')?.getAttribute('href') ?? '';
  const id = href.match(/fbid=(\d+)/)?.[1];
  return on() && media.tagName === 'IMG' && id ? { feature: 'downloadPhotos', kind: 'photo', id } : null;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
// Every row the open menu shows, top to bottom.
const ROWS = '[role="menuitem"], [role="button"]';
const ids = (doc) => [...doc.querySelector('[role="menu"]').querySelectorAll(ROWS)].filter((el) => !el.parentElement.closest(ROWS))
  .map((el) => el.id || (el.hasAttribute(ROW_MARK) ? 'download' : '?'));
const topRow = (doc) => doc.querySelector('[role="menu"]')?.querySelector(`[${ROW_MARK}]`);

test("the open menu belongs to a post only through the post's own three-dot button", () => {
  const doc = page().document;
  assert.ok(!openPost(doc));
  doc.getElementById('report').setAttribute('aria-expanded', 'true');
  assert.ok(!openPost(doc), "a comment's Report this menu isn't the post's");
  doc.getElementById('dots').setAttribute('aria-expanded', 'true');
  assert.equal(openPost(doc)?.id, 'post');
});

test("a post's first photo the switches cover is the one saved, never one in a comment", () => {
  const doc = page().document;
  const find = findPhoto();
  assert.equal(mediaOf(doc.getElementById('post'), find)?.media.id, 'photo', 'the emoji is skipped');
  assert.equal(mediaOf(doc.getElementById('post'), find)?.found.id, '1234567');
  assert.ok(!mediaOf(doc.getElementById('text-post'), find));
  doc.getElementById('photo').closest('a').remove();
  doc.getElementById('second').closest('a').remove();
  assert.ok(!mediaOf(doc.getElementById('post'), find), "the comment's photo is the comment's");
  assert.ok(!mediaOf(page().document.getElementById('post'), findPhoto(() => false)), 'nothing when the switch is off');
});

test("the row is a copy of the menu's first row reading Download, with nothing pointing back at the original", () => {
  const doc = page(MENU()).document;
  const built = buildRow(doc.getElementById('report-post'), doc);
  assert.equal(built.textContent.replace(/\s+/g, ' ').trim(), 'Download');
  assert.deepEqual([built.id, built.getAttribute('aria-label'), built.getAttribute('role'), built.getAttribute('tabindex'), built.hasAttribute(ROW_MARK)], ['', null, 'button', '0', true]);
  assert.equal(built.querySelectorAll('svg path').length, 1);
  assert.equal(built.querySelector('svg path').getAttribute('d'), DOWNLOAD_ICON);
  assert.deepEqual([built.querySelector('svg').getAttribute('width'), built.querySelectorAll('img').length], ['20', 0], 'the picture is swapped at its size');
  assert.ok(!buildRow(doc.createElement('div'), doc), 'no words, no row');
});

for (const role of ['button', 'menuitem']) {
  test(`opening a photo post's menu puts Download on top, and clicking it closes the menu and saves (${role} rows)`, async () => {
    const win = page();
    const doc = win.document;
    wireMenus(doc, role);
    const runs = [];
    const entry = createMenuDownload({ doc, enabled: () => true, find: findPhoto(), run: (found, container) => runs.push([found.id, container]), missing: () => runs.push('missing'), setTimer: (fn) => win.setTimeout(fn, 0) });
    entry.apply();
    doc.getElementById('dots').click();
    await tick();
    assert.deepEqual(ids(doc), ['download', 'embed', 'report-post']);
    const seen = [];
    doc.querySelector('[role="menu"]').addEventListener('click', () => seen.push('menu'));
    const allowed = topRow(doc).dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.deepEqual([allowed, seen], [false, []], "Facebook's menu never sees the click");
    assert.ok(!doc.querySelector('[role="menu"]'), 'the menu closes the way its button does');
    assert.equal(doc.getElementById('dots').getAttribute('aria-expanded'), 'false');
    assert.deepEqual(runs, [['1234567', null]]);
    assert.deepEqual(entry.state(), { added: 1, clicked: 1 });
  });
}

test("a comment's menu, a post with nothing to save and a switch that's off get no row", async () => {
  const win = page();
  const doc = win.document;
  wireMenus(doc);
  let on = true;
  let photos = true;
  const entry = createMenuDownload({ doc, enabled: () => on, find: findPhoto(() => photos), run: () => {}, setTimer: (fn) => win.setTimeout(fn, 0) });
  entry.apply();
  doc.getElementById('report').click();
  await tick();
  assert.deepEqual(ids(doc), ['embed', 'report-post'], "a comment's menu");
  doc.getElementById('text-dots').click();
  await tick();
  assert.deepEqual(ids(doc), ['embed', 'report-post'], 'a post with only words');
  photos = false;
  doc.getElementById('dots').click();
  await tick();
  assert.deepEqual(ids(doc), ['embed', 'report-post'], 'Download any photo is off');
  photos = true;
  on = false;
  doc.getElementById('dots').click();
  doc.getElementById('dots').click();
  await tick();
  assert.deepEqual(ids(doc), ['embed', 'report-post'], 'this switch is off');
  on = true;
  entry.sync();
  assert.deepEqual(ids(doc), ['download', 'embed', 'report-post']);
  on = false;
  entry.sync();
  assert.deepEqual(ids(doc), ['embed', 'report-post'], 'switching off takes it out of an open menu');
  assert.equal(entry.state().added, 1);
});

test('a redrawn menu gets the row back, and a menu reused for another post saves from that one', async () => {
  const win = page(PAGE.replace('<div>Just words.</div>', photo('other', '5555555')));
  const doc = win.document;
  wireMenus(doc);
  const runs = [];
  const entry = createMenuDownload({ doc, enabled: () => true, find: findPhoto(), run: (found) => runs.push(found.id), setTimer: (fn) => win.setTimeout(fn, 0) });
  entry.apply();
  doc.getElementById('dots').click();
  await tick();
  const rows = doc.getElementById('rows');
  rows.replaceChildren(...[...rows.children].filter((el) => !el.hasAttribute(ROW_MARK)).map((el) => el.cloneNode(true)));
  assert.deepEqual(ids(doc), ['embed', 'report-post'], 'the redraw dropped it');
  await tick();
  assert.deepEqual(ids(doc), ['download', 'embed', 'report-post']);
  // Facebook moves the open state to the other post's button and keeps the same menu.
  doc.getElementById('dots').setAttribute('aria-expanded', 'false');
  doc.getElementById('text-dots').setAttribute('aria-expanded', 'true');
  await tick();
  assert.deepEqual(ids(doc), ['download', 'embed', 'report-post']);
  topRow(doc).click();
  assert.deepEqual(runs, ['5555555']);
  assert.equal(entry.state().added, 3);
});

test('a post gone by the time of the click says there is nothing to save, and Enter works like a click', async () => {
  const win = page();
  const doc = win.document;
  wireMenus(doc);
  const runs = [];
  const entry = createMenuDownload({ doc, enabled: () => true, find: findPhoto(), run: (found) => runs.push(found.id), missing: () => runs.push('missing'), setTimer: (fn) => win.setTimeout(fn, 0) });
  entry.apply();
  doc.getElementById('dots').click();
  await tick();
  const Keyboard = win.KeyboardEvent;
  topRow(doc).dispatchEvent(new Keyboard('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  doc.getElementById('dots').click();
  await tick();
  topRow(doc).dispatchEvent(new Keyboard('keydown', { key: ' ', bubbles: true, cancelable: true }));
  doc.getElementById('dots').click();
  await tick();
  topRow(doc).dispatchEvent(new Keyboard('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.deepEqual(runs, ['1234567', '1234567'], 'Tab only moves on');
  const menu = doc.querySelector('[role="menu"]');
  menu.addEventListener('keydown', (event) => runs.push(event.key));
  const download = topRow(doc);
  doc.getElementById('post').remove();
  download.click();
  assert.deepEqual(runs, ['1234567', '1234567', 'Escape', 'missing'], 'with its button gone too, Escape closes the menu');
  assert.equal(entry.state().clicked, 2);
});

test('a menu drawn a moment after its button opens still gets the row', async () => {
  const win = page();
  const doc = win.document;
  wireMenus(doc, 'button', { later: 100 });
  const entry = createMenuDownload({ doc, enabled: () => true, find: findPhoto(), run: () => {}, setTimer: (fn, ms) => win.setTimeout(fn, ms) });
  entry.apply();
  doc.getElementById('dots').click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(ids(doc), ['download', 'embed', 'report-post']);
  assert.equal(entry.state().added, 1, 'added once over all the tries');
});

test('a first row with no words gets no copy, and a save that fails is logged', async () => {
  const win = page();
  const doc = win.document;
  wireMenus(doc);
  const errors = [];
  const log = { error: (words) => errors.push(words) };
  const entry = createMenuDownload({ doc, enabled: () => true, find: findPhoto(), run: () => Promise.reject(new Error('boom')), log, setTimer: (fn) => win.setTimeout(fn, 0) });
  entry.apply();
  doc.getElementById('dots').click();
  await tick();
  doc.getElementById('embed').querySelectorAll('span').forEach((span) => span.remove());
  topRow(doc).remove();
  await tick();
  assert.deepEqual([ids(doc), errors], [['embed', 'report-post'], []]);
  doc.getElementById('dots').click();
  doc.getElementById('dots').click();
  await tick();
  topRow(doc).click();
  await tick();
  assert.deepEqual(errors, ['The download failed']);
});

test('the feature starts off and saves the photo the Download button would, through its switch', async () => {
  const win = page();
  const doc = win.document;
  wireMenus(doc);
  const files = [];
  const toasts = [];
  const rows = [];
  const ctx = {
    doc, win,
    api: { download: (options) => { files.push(options.name); options.onload(); } },
    toast: (words) => toasts.push(words),
    diagnostics: { add: (label, read) => rows.push([label, read]), changed: () => {} },
  };
  downloadPhotos.setup({ ...ctx, enabled: () => true });
  downloadMenu.setup({ ...ctx, enabled: () => true });
  doc.getElementById('dots').click();
  await new Promise((resolve) => setTimeout(resolve, 80));
  topRow(doc).click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(files, ['NASA photo 1234567.jpg']);
  const read = Object.fromEntries(rows.map(([label, fn]) => [label, fn()]));
  assert.equal(read['Post menu downloads'], 'Added to 1 menu, clicked 1');
  assert.deepEqual([downloadMenu.id, downloadMenu.section, downloadMenu.default, downloadMenu.android], ['downloadMenu', 'downloads', false, 'Download first in post menus']);
});
