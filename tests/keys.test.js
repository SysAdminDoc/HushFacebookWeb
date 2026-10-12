// Keys typed in the settings panel never reach Facebook's keyboard shortcuts.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { keepKeysInPanel } from '../src/ui/keys.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

test("a key aimed at the panel stops before the page's listeners; other keys go through", () => {
  const win = new Window({ url: 'https://www.facebook.com/' });
  windows.push(win);
  keepKeysInPanel(win);
  // Facebook's shortcuts, added after the script's listener, as they are on a real page.
  const shortcuts = [];
  win.addEventListener('keydown', (event) => shortcuts.push(`window ${event.key}`), true);
  win.document.addEventListener('keydown', (event) => shortcuts.push(`document ${event.key}`));
  const host = win.document.createElement('div');
  host.dataset.hushfacebookWeb = 'ui';
  const shadow = host.attachShadow({ mode: 'open' });
  const input = win.document.createElement('input');
  shadow.append(input);
  win.document.body.append(host);
  const press = (target, key) => {
    const event = new win.KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  const typed = press(input, 'l');
  assert.deepEqual(shortcuts, [], 'Facebook never sees it');
  assert.equal(typed.defaultPrevented, false, 'the letter still types');
  press(win.document.body, 'j');
  assert.deepEqual(shortcuts, ['window j', 'document j'], 'keys on the page are untouched');
});
