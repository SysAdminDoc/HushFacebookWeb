// Open Messenger as a full page: the top bar's Messenger button, as drawn live (run 50).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import messengerPage, { ARIA_MARK, MESSAGES_PATH, messengerTarget, quietButton, restoreButton } from '../src/features/opening/messenger-page.js';

// The account controls as captured, with Facebook's own click handler on the root standing in
// for React's, which opens the dropdown.
const TOP_BAR = `
  <div id="root">
    <div role="banner">
      <div role="navigation" aria-label="Account Controls and Settings">
        <div role="button" aria-label="Facebook menu" aria-haspopup="dialog" aria-expanded="false" tabindex="0"><svg></svg></div>
        <span><div><div role="button" aria-label="Messenger" aria-haspopup="dialog" aria-expanded="false" tabindex="0"><svg><path d="m1 1"></path></svg></div></div></span>
        <div role="button" aria-label="Messenger" aria-haspopup="dialog" aria-expanded="false" tabindex="-1" style="width:0;height:0"></div>
        <div role="button" aria-label="Notifications" aria-haspopup="dialog" aria-expanded="false" tabindex="0"><svg></svg></div>
      </div>
    </div>
    <div role="main"><div role="button" aria-label="Messenger">a post's button</div></div>
  </div>`;

function page(on = true, bar = TOP_BAR) {
  const window = testWindow('https://www.facebook.com/');
  const doc = window.document;
  doc.body.innerHTML = bar;
  const opened = [];
  for (const type of ['pointerdown', 'mousedown', 'click', 'keydown']) {
    doc.getElementById('root').addEventListener(type, (event) => {
      const button = event.target.closest('[aria-haspopup]');
      if (button) opened.push(`${type}:${button.getAttribute('aria-label')}`);
    });
  }
  const went = [];
  const win = {
    location: { assign: (url) => went.push(['here', url]) },
    open: (url, target, features) => went.push(['tab', url, target, features]),
  };
  const rows = new Map();
  const listeners = [];
  let enabled = on;
  const settings = { subscribe: (listener) => listeners.push(listener) };
  messengerPage.setup({ doc, win, settings, enabled: () => enabled, diagnostics: { add: (name, read) => rows.set(name, read), changed() {} } });
  const button = doc.querySelector('[role="banner"] [aria-label="Messenger"][tabindex="0"]');
  const fire = (target, type, init = {}) => {
    const Kind = type === 'keydown' ? window.KeyboardEvent : type.startsWith('pointer') ? window.PointerEvent : window.MouseEvent;
    return target.dispatchEvent(new Kind(type, { bubbles: true, cancelable: true, button: 0, ...init }));
  };
  const turn = (value) => {
    enabled = value;
    for (const listener of listeners) listener();
  };
  return { window, doc, button, opened, went, fire, sent: () => rows.get('Messenger button presses sent to Messages')(), turn };
}

// aria-haspopup and aria-expanded on every Messenger button and the others in the top bar.
const aria = (doc) => [...doc.querySelectorAll('[role="banner"] [role="button"]')].map((el) => `${el.getAttribute('aria-label')}:${el.getAttribute('aria-haspopup')}:${el.getAttribute('aria-expanded')}`);
const FACEBOOK = ['Facebook menu:dialog:false', 'Messenger:dialog:false', 'Messenger:dialog:false', 'Notifications:dialog:false'];
const QUIETED = ['Facebook menu:dialog:false', 'Messenger:false:null', 'Messenger:false:null', 'Notifications:dialog:false'];

test('a click on the Messenger button goes to the Messages page, and the dropdown never hears it', () => {
  const { button, opened, went, fire, sent } = page();
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) assert.equal(fire(button, type), false);
  assert.equal(fire(button.querySelector('path'), 'click'), false);
  assert.deepEqual(opened, []);
  assert.deepEqual(went, [['here', MESSAGES_PATH]]);
  assert.equal(sent(), '1');
});

test('with chats unread the button says how many, and a click still goes to Messages', () => {
  const unread = TOP_BAR.replaceAll('aria-label="Messenger" aria-haspopup', 'aria-label="Messenger, 2 unread" aria-haspopup')
    .replace('</div>\n    </div>', '<a role="button" aria-label="See all in Messenger" aria-haspopup="dialog" href="/messages/t/">See all</a><div role="button" aria-label="Messenger settings" aria-haspopup="menu"></div></div>\n    </div>');
  const { doc, opened, went, fire } = page(true, unread);
  assert.deepEqual(aria(doc), ['Facebook menu:dialog:false', 'Messenger, 2 unread:false:null', 'Messenger, 2 unread:false:null', 'Notifications:dialog:false', 'See all in Messenger:dialog:null', 'Messenger settings:menu:null']);
  const button = doc.querySelector('[role="banner"] [aria-label="Messenger, 2 unread"][tabindex="0"]');
  fire(button, 'mousedown');
  fire(button, 'click');
  // Other labels that only name Messenger are left alone.
  fire(doc.querySelector('[aria-label="See all in Messenger"]'), 'click');
  fire(doc.querySelector('[aria-label="Messenger settings"]'), 'click');
  assert.deepEqual(went, [['here', MESSAGES_PATH]]);
  assert.deepEqual(opened, ['click:See all in Messenger', 'click:Messenger settings']);
});

test('Ctrl, Cmd or Shift with the click, or the middle button, opens Messages in a new tab', () => {
  const { button, went, fire } = page();
  fire(button, 'click', { ctrlKey: true });
  fire(button, 'click', { metaKey: true });
  fire(button, 'click', { shiftKey: true });
  fire(button, 'auxclick', { button: 1 });
  assert.deepEqual(went.map((entry) => entry[0]), ['tab', 'tab', 'tab', 'tab']);
  assert.deepEqual(went[0], ['tab', MESSAGES_PATH, '_blank', 'noopener']);
});

test('Enter or Space on the focused button goes there too, and other keys pass through', () => {
  const { button, opened, went, fire } = page();
  fire(button, 'keydown', { key: 'Enter' });
  fire(button, 'keydown', { key: ' ' });
  assert.equal(fire(button, 'keydown', { key: 'Tab' }), true);
  assert.deepEqual(went.map((entry) => entry[0]), ['here', 'here']);
  assert.deepEqual(opened, ['keydown:Messenger'], 'only the key it leaves alone reaches the page');
});

test('the other top bar buttons, a Messenger label outside the top bar, and the switch off are left alone', () => {
  const { doc, opened, went, fire, turn } = page();
  fire(doc.querySelector('[aria-label="Notifications"]'), 'click');
  fire(doc.querySelector('[role="main"] [aria-label="Messenger"]'), 'click');
  assert.deepEqual(went, []);
  assert.deepEqual(opened, ['click:Notifications']);
  turn(false);
  fire(doc.querySelector('[role="banner"] [aria-label="Messenger"][tabindex="0"]'), 'mousedown');
  fire(doc.querySelector('[role="banner"] [aria-label="Messenger"][tabindex="0"]'), 'click');
  assert.deepEqual(went, []);
  assert.deepEqual(opened, ['click:Notifications', 'mousedown:Messenger', 'click:Messenger']);
});

test('which presses navigate and where', () => {
  assert.equal(messengerTarget({ type: 'click', button: 0 }), 'here');
  assert.equal(messengerTarget({ type: 'click', button: 2 }), null);
  assert.equal(messengerTarget({ type: 'auxclick', button: 2 }), null);
  assert.equal(messengerTarget({ type: 'keydown', key: 'a' }), null);
});

test('while on, the Messenger button stops saying it opens a dialog, and gets it back when turned off', () => {
  const { doc, button, turn } = page();
  assert.deepEqual(aria(doc), QUIETED);
  // The settings gear finds the top bar's round buttons by aria-haspopup.
  assert.ok(button.matches('[aria-haspopup]'));
  assert.equal(doc.querySelector('[role="main"] [aria-label="Messenger"]').hasAttribute(ARIA_MARK), false);
  turn(false);
  assert.deepEqual(aria(doc), FACEBOOK);
  assert.equal(doc.querySelectorAll(`[${ARIA_MARK}]`).length, 0);
  turn(true);
  assert.deepEqual(aria(doc), QUIETED);
  const off = page(false);
  assert.deepEqual(aria(off.doc), FACEBOOK);
  assert.equal(off.doc.querySelectorAll(`[${ARIA_MARK}]`).length, 0);
});

test('a Messenger button Facebook draws again, or sets back, is quieted on the next frame', async () => {
  const { window, doc, button, turn } = page();
  await window.happyDOM.waitUntilComplete();
  // React builds new nodes off the page and puts them in whole.
  const built = (html) => {
    const box = doc.createElement('div');
    box.innerHTML = html;
    return [...box.childNodes];
  };
  button.closest('span').replaceChildren(...built('<div><div role="button" aria-label="Messenger" aria-haspopup="dialog" aria-expanded="false" tabindex="0"></div></div>'));
  await window.happyDOM.waitUntilComplete();
  assert.deepEqual(aria(doc), QUIETED);
  const drawn = doc.querySelector('[role="banner"] [aria-label="Messenger"][tabindex="0"]');
  drawn.setAttribute('aria-expanded', 'false');
  drawn.setAttribute('aria-haspopup', 'dialog');
  await window.happyDOM.waitUntilComplete();
  assert.deepEqual(aria(doc), QUIETED);
  // A whole new top bar, as when React draws the page over.
  doc.body.replaceChildren(...built(TOP_BAR));
  await window.happyDOM.waitUntilComplete();
  assert.deepEqual(aria(doc), QUIETED);
  // Turned off with a look still to come, that look leaves Facebook's values alone.
  const frames = [];
  window.requestAnimationFrame = (fn) => frames.push(fn);
  doc.querySelector('[role="banner"] [aria-label="Messenger"][tabindex="0"]').setAttribute('aria-expanded', 'true');
  await window.happyDOM.waitUntilComplete();
  assert.equal(frames.length, 1);
  turn(false);
  for (const fn of frames) fn();
  assert.deepEqual(aria(doc), FACEBOOK);
});

test("a button keeps Facebook's own values to go back to, missing ones included", () => {
  const window = testWindow('https://www.facebook.com/');
  const doc = window.document;
  const el = doc.createElement('div');
  el.setAttribute('aria-haspopup', 'menu');
  const heard = new window.MutationObserver(() => {});
  heard.observe(el, { attributes: true });
  quietButton(el);
  assert.ok(heard.takeRecords().length > 0);
  // A second look writes nothing, or the keeper would hear itself and look again every frame.
  quietButton(el);
  assert.equal(heard.takeRecords().length, 0);
  heard.disconnect();
  assert.equal(el.getAttribute('aria-haspopup'), 'false');
  restoreButton(el);
  assert.equal(el.getAttribute('aria-haspopup'), 'menu');
  assert.equal(el.hasAttribute('aria-expanded'), false);
  assert.equal(el.hasAttribute(ARIA_MARK), false);
});

test("a tap's touchstart is left alone, since stopping it cancels the click that goes to Messages", () => {
  // The tap itself runs in a real browser: tests/browser messenger-tap.
  const added = [];
  const { document: doc } = testWindow('https://www.facebook.com/');
  const listen = doc.addEventListener.bind(doc);
  doc.addEventListener = (type, listener, options) => {
    added.push([type, options]);
    listen(type, listener, options);
  };
  messengerPage.setup({ doc, win: {}, enabled: () => true });
  assert.equal(added.some(([type]) => type.startsWith('touch')), false);
  assert.ok(['pointerdown', 'pointerup'].every((type) => added.some(([added]) => added === type)), 'the pointer events hold the touch back');
  assert.ok(added.every(([, options]) => options === true), 'in the capture phase');
});

test('the switch starts off and works without the page', () => {
  assert.equal(messengerPage.default, false);
  assert.equal(messengerPage.needsPage, false);
  assert.equal(messengerPage.section, 'opening');
  assert.equal(messengerPage.android, 'Open Messenger from the top bar');
});
