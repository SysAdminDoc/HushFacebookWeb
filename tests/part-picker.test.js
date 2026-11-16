// The part picker (src/ui/part-picker.js) with the rules Hide parts of the page gives it: Facebook
// hears none of the clicks, hovers, touches and keys while it runs, not even through the script's
// own window listeners, a click picks the part under it and shows it hidden, and Save, Cancel,
// Escape, Tab, Bigger, Smaller and Pick another do what they say. Where the outline lands and what
// the CSS hides need real layout, so tests/browser/fixtures/hide-parts.js checks those in Chromium
// and Firefox.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { describeRule, partsCss } from '../src/features/appearance/part-rules.js';
import { pickerRules } from '../src/features/appearance/hide-parts.js';
import { guardForPicking, startPartPicker } from '../src/ui/part-picker.js';
import { keepKeysInPanel } from '../src/ui/keys.js';

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

// before(win): runs ahead of the picker, the way boot adds its window listeners first.
// view(win): the window the picker gets, when it isn't the one boot used.
function setup({ before, view = (win) => win } = {}) {
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
  // main.js stamps the running version on <html>, so the whole page sits inside that mark.
  doc.documentElement.setAttribute('data-hushfacebook-web', '0.0.47');
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
  before?.(win);
  const picker = startPartPicker({
    root, host, doc, win: view(win), rules: pickerRules,
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

test("the picker hears the page ahead of the script's own window listeners, and keepKeysInPanel leaves it Escape", () => {
  const featureHeard = [];
  const { win, doc, host, root, picker, heard, ends, fire, button } = setup({
    before: (page) => {
      guardForPicking(page);
      keepKeysInPanel(page);
      // Like Following feed's and Marketplace only's click listeners, added as the script starts.
      for (const type of ['click', 'pointerdown', 'mousedown', 'keydown']) page.addEventListener(type, (event) => featureHeard.push(event.type), true);
    },
  });
  const title = doc.getElementById('birthdays-title');
  assert.equal(fire(title, 'pointerdown'), false);
  assert.equal(fire(title, 'click'), false);
  assert.equal(picker.state().state, 'picked');
  assert.deepEqual(featureHeard, [], "the script's own listeners never act on a pick");
  assert.deepEqual(heard, []);

  // Escape on the bar, where keepKeysInPanel stops every key before the page hears it.
  const escape = new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true });
  assert.equal(button('save').dispatchEvent(escape), false);
  assert.deepEqual(ends, [{ saved: false }]);
  assert.deepEqual(featureHeard, []);

  // Once it ends, the guard passes everything on.
  assert.equal(fire(title, 'click'), true);
  assert.deepEqual(featureHeard, ['click']);
  assert.deepEqual(heard, ['click']);

  // The next picker in the window goes through the same listeners.
  featureHeard.length = 0;
  heard.length = 0;
  const again = startPartPicker({ root, host, doc, win, rules: pickerRules, onSave: () => {} });
  cleanups.push(() => again.stop());
  assert.equal(fire(title, 'click'), false);
  assert.equal(again.state().state, 'picked');
  assert.deepEqual(featureHeard, []);
  assert.deepEqual(heard, []);
});

test("a picker handed another object for boot's window still goes through boot's listeners", () => {
  const featureHeard = [];
  // A userscript's pageWindow and document.defaultView can be two objects for one window.
  const other = (win) => new Proxy(win, {
    get(target, name) {
      const value = Reflect.get(target, name, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const { win, picker, ends, fire, button, doc } = setup({
    before: (page) => {
      guardForPicking(page);
      keepKeysInPanel(page);
      page.addEventListener('click', (event) => featureHeard.push(event.type), true);
    },
    view: other,
  });
  fire(doc.getElementById('birthdays-title'), 'click');
  assert.equal(picker.state().state, 'picked');
  assert.deepEqual(featureHeard, []);
  const escape = new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true });
  assert.equal(button('save').dispatchEvent(escape), false);
  assert.deepEqual(ends, [{ saved: false }], "keepKeysInPanel doesn't eat the Escape");
});

test('Tab and Shift+Tab go around the bar, and a key aimed at the page waits while focus comes back to the bar', () => {
  const { win, doc, shadow, fire, button } = setup();
  const keysHeard = [];
  for (const type of ['keydown', 'keypress', 'keyup']) doc.addEventListener(type, (event) => keysHeard.push(`${event.type} ${event.key}`));
  const press = (target, init, type = 'keydown') => target.dispatchEvent(new win.KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, ...init }));
  const bar = shadow.querySelector('.picker');

  // While pointing, Cancel is the one button.
  assert.equal(press(bar, { key: 'Tab', shiftKey: true }), false);
  assert.ok(shadow.activeElement === button('cancel'), 'Shift+Tab from the bar goes to the last button');
  assert.equal(press(button('cancel'), { key: 'Tab' }), false);
  assert.ok(shadow.activeElement === button('cancel'), 'and Tab keeps to it');

  fire(doc.getElementById('market-word'), 'click');
  assert.ok(shadow.activeElement === button('save'));
  assert.equal(press(button('save'), { key: 'Tab' }), true, 'between buttons the browser moves focus as usual');
  button('cancel').focus();
  assert.equal(press(button('cancel'), { key: 'Tab' }), false);
  assert.ok(shadow.activeElement === button('save'), 'Tab from the last button goes to the first');
  assert.equal(press(button('save'), { key: 'Tab', shiftKey: true }), false);
  assert.ok(shadow.activeElement === button('cancel'), 'Shift+Tab from the first goes to the last');

  // Focus left on Facebook from before the picker: none of its keys reach the page.
  keysHeard.length = 0;
  const link = doc.querySelector('#groups a');
  for (const type of ['keydown', 'keypress', 'keyup']) assert.equal(press(link, { key: 'l' }, type), false, `${type} is held back`);
  assert.deepEqual(keysHeard, []);
  assert.ok(shadow.activeElement === bar, 'focus comes back to the bar');
  assert.equal(press(link, { key: 'Escape' }), false);
  assert.equal(button('cancel'), null, 'Escape ends it from anywhere');
});

test('a touch on the page is kept from Facebook but not cancelled, so the tap still picks', () => {
  const { win, doc, picker, fire, button } = setup();
  const touches = [];
  const TOUCHES = ['touchstart', 'touchmove', 'touchend', 'touchcancel'];
  for (const type of TOUCHES) doc.addEventListener(type, () => touches.push(type));
  const touch = (target, type) => target.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true, composed: true }));
  const title = doc.getElementById('birthdays-title');
  for (const type of TOUCHES) assert.equal(touch(title, type), true, `${type} isn't cancelled`);
  assert.deepEqual(touches, []);
  fire(title, 'click');
  assert.equal(picker.state().state, 'picked');
  assert.equal(touch(button('save'), 'touchstart'), true);
  assert.deepEqual(touches, ['touchstart'], 'touches on the bar go through');
});

test("a pick on something of the script's own on the page says so", () => {
  const { doc, picker, fire, button, text } = setup();
  const mark = doc.createElement('div');
  mark.dataset.hushfacebookWeb = 'note';
  doc.getElementById('right').append(mark);
  fire(mark, 'click');
  assert.deepEqual(picker.state(), { state: 'picked', line: null, refused: 'ours' });
  assert.match(text(), /HushFacebook Web's own/);
  assert.equal(button('save').disabled, true);

  // A word of the script's own inside a Facebook box isn't a way to pick that box.
  button('again').click();
  const word = doc.createElement('span');
  word.dataset.hushfacebookWeb = 'download';
  word.textContent = 'Download';
  doc.getElementById('birthdays-title').append(word);
  fire(word, 'click');
  assert.deepEqual(picker.state(), { state: 'picked', line: null, refused: 'ours' });

  // A link of the script's own in a shadow root on Facebook's box, as View profile on a seller.
  button('again').click();
  const box = doc.getElementById('birthdays');
  const inside = box.attachShadow({ mode: 'open' });
  const link = doc.createElement('a');
  link.setAttribute('data-hushfacebook-web', 'seller-profile');
  link.setAttribute('href', '/profile.php?id=1');
  link.textContent = 'View profile';
  inside.append(doc.createElement('slot'), link);
  fire(link, 'click');
  assert.deepEqual(picker.state(), { state: 'picked', line: null, refused: 'ours' });
  assert.match(text(), /HushFacebook Web's own/);
});
