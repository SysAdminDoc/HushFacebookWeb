// Open Messenger as a full page: the top bar's Messenger button, as drawn live (run 50).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import messengerPage, { MESSAGES_PATH, messengerTarget } from '../src/features/opening/messenger-page.js';

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

function page(on = true) {
  const window = new Window({ url: 'https://www.facebook.com/' });
  const doc = window.document;
  doc.body.innerHTML = TOP_BAR;
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
  let enabled = on;
  messengerPage.setup({ doc, win, enabled: () => enabled, diagnostics: { add: (name, read) => rows.set(name, read), changed() {} } });
  const button = doc.querySelector('[role="banner"] [aria-label="Messenger"][tabindex="0"]');
  const fire = (target, type, init = {}) => {
    const Kind = type === 'keydown' ? window.KeyboardEvent : type.startsWith('pointer') ? window.PointerEvent : window.MouseEvent;
    return target.dispatchEvent(new Kind(type, { bubbles: true, cancelable: true, button: 0, ...init }));
  };
  return { window, doc, button, opened, went, fire, sent: () => rows.get('Messenger button presses sent to Messages')(), turn: (value) => { enabled = value; } };
}

test('a click on the Messenger button goes to the Messages page, and the dropdown never hears it', () => {
  const { button, opened, went, fire, sent } = page();
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) assert.equal(fire(button, type), false);
  assert.equal(fire(button.querySelector('path'), 'click'), false);
  assert.deepEqual(opened, []);
  assert.deepEqual(went, [['here', MESSAGES_PATH]]);
  assert.equal(sent(), '1');
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

test('the switch starts off and works without the page', () => {
  assert.equal(messengerPage.default, false);
  assert.equal(messengerPage.needsPage, false);
  assert.equal(messengerPage.section, 'opening');
  assert.equal(messengerPage.android, 'Open Messenger from the top bar');
});
