// The settings panel in happy-dom. The panel reads browser globals (document, Node, CSS,
// requestAnimationFrame, navigator, setTimeout), so each test lends it a happy-dom window's and puts the
// originals back afterwards. Its shadow root is closed, so attachShadow is wrapped to keep it.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { createHider } from '../src/core/dom/hide.js';
import { createLog } from '../src/core/log.js';
import { createSettings } from '../src/core/settings.js';
import { createMemoryStorage } from '../src/core/storage.js';
import { mountPanel } from '../src/ui/panel.js';

const GLOBALS = ['document', 'Node', 'CSS', 'requestAnimationFrame', 'navigator', 'setTimeout'];
const nodeSetTimeout = globalThis.setTimeout;
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function lendGlobals(win) {
  const saved = GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  for (const name of GLOBALS) {
    const value = name === 'requestAnimationFrame' ? (fn) => win.setTimeout(fn, 0) : win[name];
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  cleanups.push(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
}

function setup() {
  const win = new Window({ url: 'https://www.facebook.com/' });
  cleanups.push(() => win.happyDOM.close());
  lendGlobals(win);
  const copied = [];
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async (text) => copied.push(text) }, configurable: true });
  let shadow = null;
  const attach = win.HTMLElement.prototype.attachShadow;
  win.HTMLElement.prototype.attachShadow = function (init) {
    shadow = attach.call(this, init);
    return shadow;
  };
  win.document.body.innerHTML = '<div role="main"><div class="feed"><div aria-posinset="1"><div>Post</div></div></div></div>';
  const log = createLog({ sink: { info() {}, warn() {}, error() {} } });
  const settings = createSettings({ storage: createMemoryStorage(), features: [], log });
  const hider = createHider({ doc: win.document, log });
  const panel = mountPanel({
    settings, features: [], log, hider, unavailable: new Set(),
    environment: { version: '0.0.1', manager: 'Tampermonkey', managerVersion: '5.4.1', mode: 'page', pageAccess: 'page' },
  });
  return { win, shadow, panel, settings, hider, copied, post: win.document.querySelector('[aria-posinset]') };
}

const tick = () => new Promise((resolve) => nodeSetTimeout(resolve, 5));

function hiddenRow(shadow) {
  const term = [...shadow.querySelectorAll('dt')].find((dt) => dt.textContent === 'Posts hidden since the page loaded');
  return term?.nextElementSibling?.textContent;
}

test('Diagnostics shows hidden posts per reason and keeps up while it is open', async () => {
  const { shadow, panel, hider, post } = setup();
  panel.open('diagnostics');
  assert.equal(hiddenRow(shadow), 'None yet');
  hider.hide(post, 'Sponsored');
  await tick();
  assert.equal(hiddenRow(shadow), 'Sponsored 1');
});

test('the copied report carries the hidden counts', async () => {
  const { shadow, panel, hider, post, copied } = setup();
  hider.hide(post, 'Suggested');
  panel.open('diagnostics');
  [...shadow.querySelectorAll('button')].find((button) => button.textContent === 'Copy report').click();
  await tick();
  assert.equal(copied.length, 1);
  assert.match(copied[0], /^Hidden since the page loaded: Suggested 1$/m);
});

test('General has the switch for leaving a note where a post was hidden', () => {
  const { shadow, panel, settings } = setup();
  panel.open('general');
  const toggle = shadow.querySelector('input[data-key="ui.hiddenNote"]');
  assert.ok(toggle, 'the switch is there');
  assert.equal(toggle.checked, false);
  toggle.checked = true;
  toggle.dispatchEvent(new toggle.ownerDocument.defaultView.Event('change'));
  assert.equal(settings.get('ui.hiddenNote'), true);
});
