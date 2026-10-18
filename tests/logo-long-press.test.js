import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { installLogoLongPress } from '../src/ui/logo-long-press.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(markup = '<div role="banner"><a href="/" aria-label="Facebook"><svg><path></path></svg></a></div>') {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  win.document.body.innerHTML = markup;
  return { win, doc: win.document, logo: win.document.querySelector('a') };
}

function scheduler() {
  let nextId = 0;
  const pending = new Map();
  const delays = [];
  return {
    delays,
    set(run, delay) {
      const id = nextId++;
      delays.push(delay);
      pending.set(id, run);
      return id;
    },
    clear(id) {
      pending.delete(id);
    },
    fire() {
      for (const [id, run] of [...pending]) {
        pending.delete(id);
        run();
      }
    },
  };
}

function pointer(win, target, type, { x = 20, y = 20, button = 0, pointerId = 1, pointerType = 'mouse', isPrimary = true } = {}) {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  for (const [name, value] of Object.entries({ clientX: x, clientY: y, button, pointerId, pointerType, isPrimary })) {
    Object.defineProperty(event, name, { value });
  }
  const allowed = target.dispatchEvent(event);
  return { allowed, event };
}

function completion(win, target, type, { pointerId = 1, pointerType = 'mouse' } = {}) {
  const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, detail: 1 });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
  });
  const allowed = target.dispatchEvent(event);
  return { allowed, event };
}

test('holding the logo opens settings after 500 ms and swallows only the resulting click', () => {
  const { win, doc, logo } = page();
  const clock = scheduler();
  let opened = 0;
  let facebookClicks = 0;
  installLogoLongPress({ doc, openSettings: () => opened++, setTimer: clock.set, clearTimer: clock.clear });
  logo.addEventListener('click', () => facebookClicks++);

  pointer(win, logo.querySelector('path'), 'pointerdown');
  assert.deepEqual(clock.delays, [500]);
  clock.fire();
  assert.equal(opened, 1);
  const heldClick = completion(win, logo.querySelector('path'), 'click');
  assert.equal(heldClick.allowed, false);
  assert.equal(heldClick.event.defaultPrevented, true);
  assert.equal(facebookClicks, 0);

  assert.equal(logo.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true })), true);
  assert.equal(facebookClicks, 1, 'the suppression is one shot');
});

test('a short press leaves Facebook logo clicks untouched, and non-primary presses do nothing', () => {
  const { win, doc, logo } = page();
  const clock = scheduler();
  let opened = 0;
  let facebookClicks = 0;
  installLogoLongPress({ doc, openSettings: () => opened++, setTimer: clock.set, clearTimer: clock.clear });
  logo.addEventListener('click', () => facebookClicks++);

  pointer(win, logo, 'pointerdown');
  pointer(win, logo, 'pointerup');
  clock.fire();
  assert.equal(logo.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true })), true);
  pointer(win, logo, 'pointerdown', { button: 2 });
  pointer(win, logo, 'pointerdown', { pointerId: 2, isPrimary: false });
  pointer(win, logo, 'pointerdown', { pointerId: 3, pointerType: 'pen' });
  const home = doc.createElement('a');
  home.href = '/';
  home.setAttribute('aria-label', 'Home');
  doc.querySelector('[role="banner"]').append(home);
  pointer(win, home, 'pointerdown', { pointerId: 4 });
  clock.fire();
  assert.equal(opened, 0);
  assert.equal(facebookClicks, 1);
});

test('movement, pointer cancellation, and leaving the logo cancel the hold', () => {
  for (const cancel of ['move', 'pointercancel', 'pointerleave']) {
    const { win, doc, logo } = page();
    const clock = scheduler();
    let opened = 0;
    installLogoLongPress({ doc, openSettings: () => opened++, setTimer: clock.set, clearTimer: clock.clear });
    pointer(win, logo, 'pointerdown', { x: 10, y: 10 });
    if (cancel === 'move') pointer(win, logo, 'pointermove', { x: 11, y: 10 });
    else pointer(win, logo, cancel);
    clock.fire();
    assert.equal(opened, 0, cancel);
  }
});

test('delegation follows a redrawn banner and suppresses retargeted touch completion events', () => {
  const { win, doc } = page();
  const clock = scheduler();
  let opened = 0;
  installLogoLongPress({
    doc,
    openSettings: () => opened++,
    setTimer: clock.set,
    clearTimer: clock.clear,
  });
  doc.querySelector('[role="banner"]').outerHTML = '<header role="banner"><a href="/home.php" aria-label="Facebook">New logo</a></header>';
  const replacement = doc.querySelector('[role="banner"] a');
  pointer(win, replacement, 'pointerdown', { pointerType: 'touch' });
  clock.fire();
  pointer(win, doc.body, 'pointerup', { pointerType: 'touch' });
  const menu = completion(win, doc.body, 'contextmenu', { pointerType: 'touch' });
  assert.equal(menu.allowed, false, 'a context menu retargeted after the panel opens is suppressed');
  assert.equal(opened, 1);
  assert.equal(completion(win, doc.body, 'click', { pointerType: 'touch' }).allowed, false,
    'the release click is suppressed even when the open modal changes its target');
});

test('completion suppression stays with its pointer and leaves later activations alone', () => {
  const { win, doc, logo } = page();
  const clock = scheduler();
  let laterClicks = 0;
  installLogoLongPress({ doc, openSettings() {}, setTimer: clock.set, clearTimer: clock.clear });
  doc.body.addEventListener('click', () => laterClicks++);

  pointer(win, logo, 'pointerdown', { pointerType: 'touch' });
  clock.fire();
  pointer(win, doc.body, 'pointerup', { pointerType: 'touch' });
  completion(win, doc.body, 'contextmenu', { pointerType: 'touch' });
  assert.equal(completion(win, doc.body, 'contextmenu', { pointerType: 'mouse' }).allowed, true,
    'a keyboard context menu can reuse the mouse pointer id without belonging to the touch hold');
  const independentClick = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  assert.equal(doc.body.dispatchEvent(independentClick), true);
  assert.equal(independentClick.defaultPrevented, false);
  assert.equal(laterClicks, 1);

  pointer(win, logo, 'pointerdown', { pointerId: 2 });
  pointer(win, logo, 'pointerup', { pointerId: 2 });
  assert.equal(completion(win, logo, 'click', { pointerId: 2 }).allowed, true);
  assert.equal(laterClicks, 2);
});

test('touch click and context menu are each suppressed once only for the held pointer', () => {
  const { win, doc, logo } = page();
  const clock = scheduler();
  installLogoLongPress({ doc, openSettings() {}, setTimer: clock.set, clearTimer: clock.clear });

  pointer(win, logo, 'pointerdown', { pointerId: 7, pointerType: 'touch' });
  clock.fire();
  assert.equal(completion(win, doc.body, 'click', { pointerId: 7, pointerType: 'touch' }).allowed, false);
  assert.equal(completion(win, doc.body, 'click', { pointerId: 7, pointerType: 'touch' }).allowed, true);
  assert.equal(completion(win, doc.body, 'contextmenu', { pointerId: 7, pointerType: 'touch' }).allowed, false);
  assert.equal(completion(win, doc.body, 'contextmenu', { pointerId: 7, pointerType: 'touch' }).allowed, true);
  assert.equal(completion(win, doc.body, 'contextmenu', { pointerId: 8, pointerType: 'touch' }).allowed, true);
});
