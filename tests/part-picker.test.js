// The part picker (src/ui/part-picker.js) with the rules Hide parts of the page gives it: Facebook
// hears none of the clicks and hovers while it runs, a click picks the part under it and shows it
// hidden, and Save, Cancel, Escape, Bigger, Smaller and Pick another do what they say. Where the
// outline lands and what the CSS hides need real layout, so tests/browser/hide-parts-fixture.html
// checks those in Chromium and Firefox.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { describeRule, partsCss } from '../src/features/appearance/part-rules.js';
import { pickerRules } from '../src/features/appearance/hide-parts.js';
import { startPartPicker } from '../src/ui/part-picker.js';

const PAGE = `
  <div role="navigation" id="left"><ul>
    <li id="market"><div id="market-box"><a href="/marketplace/"><span id="market-word">Marketplace</span></a></div></li>
    <li id="groups"><div><a href="/groups/feed/"><span>Groups</span></a></div></li>
  </ul></div>
  <div role="main" id="main"><div role="feed"><div aria-posinset="1"><a id="in-post" href="/someone"><span id="post-word">Post</span></a></div></div></div>
  <div role="complementary"><div id="right"><div id="birthdays"><h3 id="birthdays-title">Birthdays</h3></div></div></div>`;

const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const PAGE_EVENTS = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'mouseover', 'mousemove', 'contextmenu', 'auxclick', 'dblclick'];

function setup() {
  const win = testWindow('https://www.facebook.com/');
  // h() builds with the page's globals, as it does in the userscript.
  const saved = ['document', 'Node'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  for (const [name] of saved) Object.defineProperty(globalThis, name, { value: win[name], configurable: true, writable: true });
  cleanups.push(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    win.happyDOM.close();
  });
  const doc = win.document;
  // A browser's own default, which happy-dom leaves out (it reports '' for both).
  doc.head.innerHTML = '<style>a, span { display: inline; }</style>';
  doc.body.innerHTML = PAGE;
  const host = doc.createElement('div');
  host.dataset.hushfacebookWeb = 'ui';
  const shadow = host.attachShadow({ mode: 'open' });
  const root = doc.createElement('div');
  root.className = 'root';
  shadow.append(root);
  doc.body.append(host);
  // What Facebook would hear: every pointer and mouse event that reaches the page.
  const heard = [];
  for (const type of PAGE_EVENTS) doc.addEventListener(type, () => heard.push(type));
  const saves = [];
  const ends = [];
  const picker = startPartPicker({
    root, host, doc, win, rules: pickerRules,
    onSave: (line) => saves.push(line),
    onEnd: (result) => ends.push(result),
  });
  cleanups.push(() => picker.stop());
  const fire = (target, type, init = {}) => {
    const Event = type.startsWith('pointer') && win.PointerEvent ? win.PointerEvent : win.MouseEvent;
    return target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, composed: true, ...init }));
  };
  const button = (key) => shadow.querySelector(`[data-key="picker:${key}"]`);
  const preview = () => doc.querySelector('style[data-hushfacebook-web="part-preview"]');
  const text = () => shadow.querySelector('.picker-text')?.textContent ?? null;
  return { win, doc, shadow, root, host, picker, heard, saves, ends, fire, button, preview, text };
}

test('while picking, Facebook hears no click or hover, and a click picks the part and shows it hidden', () => {
  const { doc, shadow, picker, heard, saves, ends, fire, button, preview, text } = setup();
  const word = doc.getElementById('market-word');
  assert.equal(picker.state().state, 'pointing');
  assert.ok(shadow.activeElement === shadow.querySelector('.picker'), 'the bar has focus');
  assert.match(preview().textContent, /cursor: crosshair/);
  assert.deepEqual(['save', 'bigger', 'smaller', 'again', 'cancel'].map((key) => button(key).hidden), [true, true, true, true, false], 'only Cancel shows while pointing');

  for (const type of ['pointermove', 'pointerover', 'mouseover', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'contextmenu', 'auxclick', 'dblclick']) {
    assert.equal(fire(word, type), false, `${type} is cancelled`);
  }
  assert.equal(fire(word, 'click'), false, 'the link is not followed');
  assert.deepEqual(heard, [], 'none of it reached the page');

  // The word is in a link, so the pick is the block holding both.
  assert.deepEqual(picker.state(), { state: 'picked', line: 'navigation link /marketplace/ up 1', refused: null });
  assert.equal(preview().textContent, partsCss('navigation link /marketplace/ up 1'), 'shown hidden as a preview');
  assert.ok(text().startsWith(describeRule('navigation link /marketplace/ up 1')));
  assert.equal(button('save').hidden, false);
  assert.equal(button('save').disabled, false);
  assert.ok(shadow.activeElement === button('save'), 'focus moves to Save');
  assert.deepEqual(saves, []);

  // A second click on the page while a pick shows is still kept from Facebook, and changes nothing.
  assert.equal(fire(doc.getElementById('birthdays-title'), 'click'), false);
  assert.equal(picker.state().line, 'navigation link /marketplace/ up 1');

  button('save').click();
  assert.deepEqual(saves, ['navigation link /marketplace/ up 1']);
  assert.deepEqual(ends, [{ saved: true }]);
  assert.equal(preview(), null, 'the preview goes, and the saved setting takes over');
  assert.equal(shadow.querySelector('.picker, .picker-outline'), null);
  heard.length = 0;
  assert.equal(fire(word, 'click'), true, 'clicks reach Facebook again');
  assert.deepEqual(heard, ['click']);
});

test('the script\'s own buttons keep working while picking, and Escape or Cancel ends it with nothing saved', () => {
  const { doc, root, picker, heard, saves, ends, fire, button, preview } = setup();
  let ownClicks = 0;
  const own = doc.createElement('button');
  own.addEventListener('click', () => ownClicks++);
  root.append(own);
  own.click();
  assert.equal(ownClicks, 1);
  assert.equal(picker.state().state, 'pointing', 'a click on our own element picks nothing');
  assert.deepEqual(heard, ['click'], 'and goes on its way like any click on the panel');
  heard.length = 0;

  fire(doc.getElementById('birthdays-title'), 'click');
  assert.equal(picker.state().state, 'picked');
  doc.body.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.deepEqual(saves, []);
  assert.deepEqual(ends, [{ saved: false }]);
  assert.equal(preview(), null);
  assert.equal(button('cancel'), null);
  assert.deepEqual(heard, []);

  const second = setup();
  second.button('cancel').click();
  assert.deepEqual(second.ends, [{ saved: false }]);
  assert.deepEqual(second.saves, []);
  second.picker.stop();
  assert.equal(second.ends.length, 1, 'ending twice reports once');
});

test('a pick in a post is refused with a pointer to Hide posts by words, and Pick another starts over', () => {
  const { doc, shadow, picker, fire, button, preview, text } = setup();
  fire(doc.getElementById('post-word'), 'click');
  assert.deepEqual(picker.state(), { state: 'picked', line: null, refused: 'feed' });
  assert.match(text(), /Hide posts by words/);
  assert.equal(button('save').disabled, true);
  assert.equal(preview().textContent, '', 'nothing shows hidden');
  assert.ok(shadow.activeElement === button('again'), 'focus moves to Pick another');

  button('again').click();
  assert.equal(picker.state().state, 'pointing');
  assert.match(preview().textContent, /cursor: crosshair/);
  assert.equal(button('save').hidden, true);
  fire(doc.getElementById('birthdays-title'), 'click');
  assert.deepEqual(picker.state(), { state: 'picked', line: 'complementary at 1 1 1', refused: null });
});

test('Bigger takes the part around the pick, and Smaller goes back', () => {
  const { doc, picker, fire, button, preview } = setup();
  fire(doc.getElementById('market-word'), 'click');
  assert.equal(picker.state().line, 'navigation link /marketplace/ up 1');
  assert.equal(button('smaller').disabled, true, 'nothing smaller yet');
  button('bigger').click();
  assert.equal(picker.state().line, 'navigation link /marketplace/ up 2', 'the list item');
  assert.equal(preview().textContent, partsCss('navigation link /marketplace/ up 2'));
  button('bigger').click();
  assert.equal(picker.state().line, 'navigation link /marketplace/ up 3', 'the list');
  button('bigger').click();
  assert.equal(picker.state().line, 'page link /marketplace/ up 4', 'the whole left column');
  assert.equal(button('bigger').disabled, true, 'the next step up is the page itself');
  for (const line of ['navigation link /marketplace/ up 3', 'navigation link /marketplace/ up 2', 'navigation link /marketplace/ up 1']) {
    button('smaller').click();
    assert.equal(picker.state().line, line);
  }
  assert.equal(button('smaller').disabled, true);
});
