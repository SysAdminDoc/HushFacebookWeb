// The settings panel in happy-dom. The panel reads browser globals (document, Node, CSS,
// requestAnimationFrame, navigator, setTimeout), so each test lends it a happy-dom window's and puts the
// originals back afterwards. Its shadow root is closed, so attachShadow is wrapped to keep it.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { createActions } from '../src/core/actions.js';
import { createDiagnostics } from '../src/core/diagnostics.js';
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

function setup({ features = [], actions = null } = {}) {
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
  const settings = createSettings({ storage: createMemoryStorage(), features, log });
  const hider = createHider({ doc: win.document, log });
  const diagnostics = createDiagnostics();
  const panel = mountPanel({
    settings, features, log, hider, diagnostics, actions, unavailable: new Set(),
    environment: { version: '0.0.1', manager: 'Tampermonkey', managerVersion: '5.4.1', mode: 'page', pageAccess: 'page' },
  });
  return { win, shadow, panel, settings, hider, diagnostics, copied, post: win.document.querySelector('[aria-posinset]') };
}

const tick = () => new Promise((resolve) => nodeSetTimeout(resolve, 5));

function row(shadow, label) {
  const term = [...shadow.querySelectorAll('dt')].find((dt) => dt.textContent === label);
  return term?.nextElementSibling?.textContent;
}
const hiddenRow = (shadow) => row(shadow, 'Posts hidden since the page loaded');

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

test('rows a feature adds show in Diagnostics, follow its changes and go in the report', async () => {
  const { shadow, panel, diagnostics, copied } = setup();
  let hits = 0;
  diagnostics.add('Ads hidden on the page', () => (hits ? `header label ${hits}` : 'None yet'));
  diagnostics.add('Broken row', () => { throw new Error('nope'); });
  panel.open('diagnostics');
  assert.equal(row(shadow, 'Ads hidden on the page'), 'None yet');
  assert.equal(row(shadow, 'Broken row'), 'unavailable (nope)');
  hits = 2;
  diagnostics.changed();
  await tick();
  assert.equal(row(shadow, 'Ads hidden on the page'), 'header label 2');
  [...shadow.querySelectorAll('button')].find((button) => button.textContent === 'Copy report').click();
  await tick();
  assert.match(copied[0], /^Ads hidden on the page: header label 2$/m);
});

test("a feature's own buttons show on its card while it's on, follow its state and run when clicked", async () => {
  const feature = { id: 'demo', section: 'feed', title: 'Demo', description: 'A demo switch.', default: true, setup() {} };
  const actions = createActions();
  let showing = false;
  actions.for('demo').add(() => (showing ? 'Hide them again' : 'Show them'), () => { showing = !showing; });
  actions.for('other').add('Not mine', () => {});
  const { shadow, panel, settings } = setup({ features: [feature], actions });
  panel.open('feed');
  const button = (text) => [...shadow.querySelectorAll('button')].find((b) => b.textContent === text);
  assert.ok(button('Show them'));
  assert.equal(button('Not mine'), undefined, "another feature's button isn't on this card");
  button('Show them').click();
  await tick();
  assert.equal(showing, true);
  assert.ok(button('Hide them again'), 'the label follows the state');
  settings.set('demo', false);
  await tick();
  assert.equal(button('Hide them again'), undefined, 'no buttons while the switch is off');
});
