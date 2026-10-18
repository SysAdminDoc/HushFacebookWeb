// Trim the share menu, against the share sheet as drawn live (runs 54 and 57). Contact names are
// made up.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import shareSheet, { createShareSheetMarker, linkHost, MARK, markShareSheets, shareSheetCss, TARGETS, targetOf } from '../src/features/links/share-sheet.js';

const contact = (name) => `<div role="listitem"><div role="button" aria-label="Send to ${name} via Messenger"><span>${name}</span></div></div>`;
const target = (inner) => `<div role="listitem">${inner}</div>`;

const SHEET = (labels = {}) => `
  <div role="dialog">
    <div class="body">
      <div><span>Links you share are unique to you.</span></div>
      <div><div role="textbox" contenteditable="true"></div><div role="button">Share now</div></div>
      <div><div></div></div>
      <div id="bug"><div role="button" aria-label="Report Bug"></div></div>
      <div id="heading"><h3><span>Send in Messenger</span></h3></div>
      <div id="contacts"><div><div>
        <div role="button" aria-label="Previous items"></div>
        <div role="list" aria-label="Send this to your Messenger contacts"><div>
          ${contact('Pat Example')}${contact('Sam Sample')}
          <div role="listitem"><div role="button" aria-label="More Messenger contacts"><span>More</span></div></div>
        </div></div>
        <div role="button" aria-label="Next items"></div>
      </div></div></div>
      <div id="share-to"><h3><span>Share to</span></h3></div>
      <div id="targets"><div><div role="list">
        ${target(`<div role="button"><i></i><span>${labels.messenger ?? 'Messenger'}</span></div>`)}
        ${target(`<a role="link" href="https://l.facebook.com/l.php?u=https%3A%2F%2Fwa.me%2F%3Ftext%3Dhttps%253A%252F%252Fwww.facebook.com%252Fx&amp;h=AT1"><i></i><span>${labels.whatsapp ?? 'WhatsApp'}</span></a>`)}
        ${target(`<div role="button"><i></i><span>${labels.story ?? 'Your story'}</span></div>`)}
        ${target('<div role="button"><i></i><span>Copy link</span></div>')}
        ${target(`<div role="button" aria-label="${labels.groupLabel ?? 'Share to a group'}"><i></i><span>${labels.group ?? 'Group'}</span></div>`)}
        ${target(`<div role="button" aria-label="Share to a friend’s profile"><i></i><span>Friend’s profile</span></div>`)}
        ${target(`<a role="link" href="https://l.facebook.com/l.php?u=https%3A%2F%2Ftwitter.com%2Fintent%2Ftweet%3Furl%3Dx"><i></i><span>${labels.x ?? 'X'}</span></a>`)}
      </div></div></div>
    </div>
  </div>`;

function page(html) {
  const win = testWindow('https://www.facebook.com/');
  win.document.body.innerHTML = html;
  return win.document;
}

const marks = (doc) => [...doc.querySelectorAll(`[${MARK}]`)].map((el) => el.getAttribute(MARK));
const defaults = Object.fromEntries(TARGETS.map((t) => [`shareSheet.${t.option}`, t.default]));

test('every target in the sheet is marked, the contacts row as a whole, and Copy link never', () => {
  const doc = page(SHEET());
  assert.equal(markShareSheets(doc), 9);
  assert.deepEqual(marks(doc), ['contacts', 'contacts', 'contacts', 'messenger', 'whatsapp', 'story', 'group', 'friend', 'x']);
  assert.equal(doc.getElementById('contacts').getAttribute(MARK), 'contacts', 'the row goes with its Previous and Next buttons');
  assert.equal(doc.getElementById('heading').getAttribute(MARK), 'contacts', 'and with its heading');
  assert.equal(doc.getElementById('bug').getAttribute(MARK), 'contacts', 'and with the button drawn beside the heading');
  assert.equal(doc.getElementById('share-to').hasAttribute(MARK), false, 'the targets keep their heading');
  assert.equal(markShareSheets(doc), 0, 'marking again adds nothing');
});

test('with the default choices WhatsApp, Your story and X go, and the rest stay', () => {
  const doc = page(SHEET());
  markShareSheets(doc);
  const css = shareSheetCss((key) => defaults[key]);
  const selectors = css.slice(0, css.indexOf('{')).split(',').map((part) => part.trim());
  const hidden = selectors.flatMap((selector) => [...doc.querySelectorAll(selector)]).map((el) => el.getAttribute(MARK));
  assert.deepEqual(hidden.sort(), ['story', 'whatsapp', 'x']);
  assert.match(css, /display: none !important/);
  assert.equal(shareSheetCss(() => false), '');
});

test('WhatsApp and X are found by where their links go, in any language', () => {
  const doc = page(SHEET({ messenger: 'Enviar por Messenger', whatsapp: 'Enviar por WhatsApp', story: 'Tu historia', group: 'Grupo', groupLabel: 'Compartir en un grupo', x: 'Publicar en X' }));
  markShareSheets(doc);
  assert.deepEqual(marks(doc), ['contacts', 'contacts', 'contacts', 'whatsapp', 'friend', 'x'], 'the rest go by their English words for now');
});

test('only a heading with no list or text box in it goes with the contacts row', () => {
  const noHeading = page(SHEET().replace('<h3><span>Send in Messenger</span></h3>', '<span>Send in Messenger</span>'));
  markShareSheets(noHeading);
  assert.equal(noHeading.getElementById('heading').hasAttribute(MARK), false);
  assert.equal(noHeading.getElementById('bug').hasAttribute(MARK), false, 'the box before it stays too');
  const withList = page(SHEET().replace('<h3><span>Send in Messenger</span></h3>', '<h3>Send in Messenger</h3><div role="list"></div>'));
  markShareSheets(withList);
  assert.equal(withList.getElementById('heading').hasAttribute(MARK), false);
  const withText = page(SHEET().replace('aria-label="Report Bug"></div>', 'aria-label="Report Bug"></div><span>Some words</span>'));
  markShareSheets(withText);
  assert.equal(withText.getElementById('heading').getAttribute(MARK), 'contacts');
  assert.equal(withText.getElementById('bug').hasAttribute(MARK), false, 'a box with words in it is not just a button');
});

test('a list of comments or posts, or a list with one target, is not the share sheet', () => {
  const comment = (inner) => `<div role="listitem"><div role="article" aria-label="Comment by Pat Example">${inner}</div></div>`;
  const doc = page(`
    <div role="dialog"><div role="list">
      ${comment('<a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fx.com%2Fpat">x.com/pat</a> worth a read')}
      ${comment('<a href="https://wa.me/15555550100">WhatsApp me</a>')}
      <div role="listitem"><div role="button">Group</div></div>
    </div></div>
    <div role="dialog"><div role="list">
      <div role="listitem"><div role="button">Messenger</div></div>
      <div role="listitem"><div role="button">Some other thing</div></div>
    </div></div>
    <div role="dialog"><div role="list">
      <div role="listitem"><a href="https://x.com/pat">A long line of words that reads like a post someone wrote about X</a></div>
      <div role="listitem"><a href="https://wa.me/1">Another long line of words that reads like a post someone wrote</a></div>
    </div></div>`);
  assert.equal(markShareSheets(doc), 0);
  assert.deepEqual(marks(doc), []);
});

test('a long list of short items is skipped before its words are read', () => {
  const short = (word) => `<div role="listitem"><div role="button">${word}</div></div>`;
  const words = ['Messenger', 'Group', 'Your story', 'X'];
  const list = (count) => `<div role="dialog"><div role="list">${Array.from({ length: count }, (_, i) => short(words[i % words.length])).join('')}</div></div>`;
  assert.equal(markShareSheets(page(list(16))), 16, 'a row as long as the limit is still read');
  assert.equal(markShareSheets(page(list(17))), 0);
});

test('the contacts row is a labeled list of buttons above the targets, and its heading holds no control', () => {
  const after = page(SHEET());
  after.getElementById('targets').after(after.getElementById('contacts'));
  markShareSheets(after);
  assert.equal(after.querySelectorAll(`[${MARK}="contacts"]`).length, 0, 'a labeled list below the targets is not the contacts row');
  const noButtons = page(SHEET());
  for (const button of noButtons.querySelectorAll('#contacts [role="listitem"] [role="button"]')) button.removeAttribute('role');
  markShareSheets(noButtons);
  assert.equal(noButtons.getElementById('contacts').hasAttribute(MARK), false, 'a labeled list with nothing to click is not it either');
  const titled = page(SHEET().replace('<h3><span>Send in Messenger</span></h3>', '<h3><span>Share</span></h3><div role="button" aria-label="Close"></div>'));
  markShareSheets(titled);
  assert.equal(titled.getElementById('contacts').getAttribute(MARK), 'contacts');
  assert.equal(titled.getElementById('heading').hasAttribute(MARK), false, 'a heading with a button beside it, like the title bar, stays');
  const twoButtons = page(SHEET().replace('aria-label="Report Bug"></div>', 'aria-label="Report Bug"></div><div role="button" aria-label="Close"></div>'));
  markShareSheets(twoButtons);
  assert.equal(twoButtons.getElementById('bug').hasAttribute(MARK), false, 'only a box with a single button goes');
});

test('a dialog with no share targets, and lists outside dialogs, are left alone', () => {
  const doc = page(`
    <div role="dialog"><div role="list" aria-label="Comments"><div role="listitem">Pat Example wrote something</div></div>
      <div role="list"><div role="listitem"><div role="button">Like</div></div></div></div>
    <div role="list"><div role="listitem"><div role="button">Messenger</div></div></div>`);
  assert.equal(markShareSheets(doc), 0);
  assert.deepEqual(marks(doc), []);
});

test('linkHost reads through Facebook\'s link redirect', () => {
  assert.equal(linkHost('https://l.facebook.com/l.php?u=https%3A%2F%2Fwa.me%2F%3Ftext%3Dx&h=AT1'), 'wa.me');
  assert.equal(linkHost('https://wa.me/?text=x'), 'wa.me');
  assert.equal(linkHost('/l.php?u=https%3A%2F%2Fx.com%2Fintent'), 'x.com');
  assert.equal(linkHost('https://l.facebook.com.example.invalid/l.php?u=https%3A%2F%2Fwa.me'), 'l.facebook.com.example.invalid');
  assert.equal(linkHost('not a url', 'not a base'), '');
  const doc = page(target('<a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fapi.whatsapp.com%2Fsend">Share</a>'));
  assert.equal(targetOf(doc.querySelector('[role="listitem"]')), 'whatsapp');
});

test('a sheet that opens later is marked once the page settles, and nothing is marked with the switch off', () => {
  const doc = page('<div id="layer"></div>');
  const timers = [];
  let on = true;
  const marker = createShareSheetMarker({ doc, enabled: () => on, setTimer: (fn) => timers.push(fn) });
  marker.start();
  doc.getElementById('layer').innerHTML = SHEET();
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
    assert.equal(timers.length, 1);
    timers.shift()();
    assert.equal(marker.marked(), 9);
    on = false;
    doc.getElementById('layer').innerHTML = SHEET();
    return new Promise((resolve) => setTimeout(resolve, 0));
  }).then(() => {
    assert.equal(timers.length, 0);
    marker.sync();
    assert.deepEqual(marks(doc), []);
  });
});

test('the switch starts off, sits under Links and works without the page', () => {
  assert.equal(shareSheet.default, false);
  assert.equal(shareSheet.section, 'links');
  assert.equal(shareSheet.needsPage, undefined);
  assert.equal(shareSheet.android, 'Share sheet items');
  assert.deepEqual(shareSheet.options.map((option) => option.key), ['contacts', 'messenger', 'whatsapp', 'story', 'group', 'friend', 'x']);
});
