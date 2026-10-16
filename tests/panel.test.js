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
import menuEntry from '../src/features/menu/menu-entry.js';

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

function setup({ features = [], actions = null, unavailable = new Set(), storage = createMemoryStorage(), update } = {}) {
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
  const settings = createSettings({ storage, features, log });
  const hider = createHider({ doc: win.document, log });
  const diagnostics = createDiagnostics();
  const panel = mountPanel({
    settings, features, log, hider, diagnostics, actions, unavailable,
    environment: { version: '0.0.1', manager: 'Tampermonkey', managerVersion: '5.4.1', mode: 'page', pageAccess: 'page', update },
  });
  return { win, shadow, panel, settings, hider, diagnostics, copied, unavailable, log, post: win.document.querySelector('[aria-posinset]') };
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

test('Diagnostics lists why posts were hidden, newest first, and the report carries them oldest first', async () => {
  const { shadow, panel, diagnostics, copied } = setup();
  panel.open('diagnostics');
  const listed = () => {
    const heading = [...shadow.querySelectorAll('h3')].find((h3) => h3.textContent === 'Why posts were hidden');
    const box = heading.nextElementSibling.nextElementSibling;
    return box.classList.contains('log') ? [...box.children].map((line) => line.textContent) : box.textContent;
  };
  assert.equal(listed(), 'Nothing hidden yet.');
  diagnostics.decide({ post: 'UzpfSTEyMw', rule: 'Sponsored', signal: 'th_dat_spo', layer: 'data' });
  diagnostics.decide({ post: null, rule: 'Filter', signal: 'crypto', layer: 'page' });
  await tick();
  const lines = listed();
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d\d:\d\d:\d\d page no id yet Filter: crypto$/);
  assert.match(lines[1], /^\d\d:\d\d:\d\d data #[0-9a-z]{6} Sponsored: th_dat_spo$/);
  assert.ok(!lines[1].includes('UzpfSTEyMw'), 'the id itself never shows');
  [...shadow.querySelectorAll('button')].find((button) => button.textContent === 'Copy report').click();
  await tick();
  const report = copied[0].split('\n');
  const start = report.indexOf('Why posts were hidden, oldest first:');
  assert.ok(start > 0);
  assert.match(report[start + 1], /Sponsored: th_dat_spo$/);
  assert.match(report[start + 2], /Filter: crypto$/);
  assert.ok(!copied[0].includes('UzpfSTEyMw'));
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

test('General ends with the Ko-fi row', () => {
  const { shadow, panel } = setup();
  panel.open('general');
  const cards = [...shadow.querySelectorAll('.settings-group > .card')];
  const row = cards.at(-1);
  assert.equal(row.dataset.key, 'kofi');
  assert.equal(row.querySelector('.title').textContent, 'Buy me a coffee');
  assert.equal(row.querySelector('.desc').textContent, 'Hush is free. A coffee on Ko-fi helps me keep testing patches.');
  assert.equal(row.getAttribute('href'), 'https://ko-fi.com/X8K126YVER');
  assert.equal(row.getAttribute('target'), '_blank');
  assert.equal(row.getAttribute('rel'), 'noopener');
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
  button('Show them').focus();
  button('Show them').click();
  await tick();
  assert.equal(showing, true);
  assert.ok(button('Hide them again'), 'the label follows the state');
  assert.equal(shadow.activeElement, button('Hide them again'), 'focus follows the replacement action');
  settings.set('demo', false);
  await tick();
  assert.equal(button('Hide them again'), undefined, 'no buttons while the switch is off');
});

test('the corner button hides when Settings in your account menu stands in for it, or when General says so', () => {
  const { shadow, settings } = setup({ features: [menuEntry] });
  const launcher = shadow.querySelector('.launcher');
  assert.equal(launcher.hidden, false, 'shown by default, the menu row is on with its hide option off');
  settings.set('menuEntry.hideButton', true);
  assert.equal(launcher.hidden, true);
  settings.set('menuEntry', false);
  assert.equal(launcher.hidden, false, 'back while the menu row is off');
  settings.set('menuEntry', true);
  settings.set('paused', true);
  assert.equal(launcher.hidden, false, 'back while the script is paused, since the menu row is gone then');
  settings.set('paused', false);
  settings.set('menuEntry.hideButton', false);
  settings.set('ui.launcher', false);
  assert.equal(launcher.hidden, true);
});

test('the corner button comes back when the menu row stops working', () => {
  const { shadow, settings, panel, unavailable } = setup({ features: [menuEntry] });
  const launcher = shadow.querySelector('.launcher');
  settings.set('menuEntry.hideButton', true);
  assert.equal(launcher.hidden, true);
  unavailable.add('menuEntry');
  panel.refresh();
  assert.equal(launcher.hidden, false);
});

test("no page rule can hide the panel, and a long text box stops at its setting's limit", () => {
  const box = { id: 'demo', section: 'feed', title: 'Demo', description: 'A demo box.', default: true, options: [{ key: 'css', type: 'text', label: 'CSS', default: '', maxLength: 50000, code: true }], setup() {} };
  const { win, shadow, panel } = setup({ features: [box] });
  const host = win.document.querySelector('[data-hushfacebook-web="ui"]');
  assert.equal(host.getAttribute('style'), 'all: initial !important');
  panel.open('feed');
  assert.equal(shadow.querySelector('textarea[data-key="demo.css"]').maxLength, 50000);
});

test('closing settings returns focus to the control that opened them', async () => {
  const { win, shadow, panel } = setup();
  const opener = win.document.createElement('button');
  opener.textContent = 'Account settings';
  win.document.body.append(opener);
  opener.focus();
  panel.open('general');
  assert.equal(shadow.querySelector('dialog').open, true);
  assert.equal(shadow.activeElement.getAttribute('aria-label'), 'Close settings');
  panel.close();
  await tick();
  assert.equal(shadow.querySelector('dialog').open, false);
  assert.equal(win.document.activeElement, opener);
});

test('reset and Undo preserve settings and a reachable focus target', async () => {
  const { shadow, panel, settings } = setup();
  settings.set('ui.hiddenNote', true);
  panel.open('general');
  const reset = () => shadow.querySelector('[data-key="reset"]');
  reset().focus();
  reset().click();
  assert.equal(settings.get('ui.hiddenNote'), false);
  assert.equal(shadow.activeElement, reset());
  const undo = [...shadow.querySelectorAll('.toast button')].find((button) => button.textContent === 'Undo');
  assert.equal(undo.closest('dialog').open, true, 'the toast action stays in the modal');
  undo.focus();
  undo.click();
  await tick();
  assert.equal(settings.get('ui.hiddenNote'), true);
  assert.equal(shadow.activeElement, reset());
});

test('an unavailable section request keeps the existing settings page usable', () => {
  const { shadow, panel } = setup();
  panel.open('missing');
  assert.equal(shadow.querySelector('#hfw-section-title').textContent, 'General');
  assert.equal(shadow.querySelector('dialog').open, true);
});

test('a failed toggle save restores the visible switch and gives recovery feedback', () => {
  const storage = createMemoryStorage();
  const { win, shadow, panel, settings } = setup({ storage });
  storage.set = () => { throw new Error('Disk full'); };
  panel.open('general');
  const input = shadow.querySelector('[data-key="ui.hiddenNote"]');
  input.checked = true;
  input.dispatchEvent(new win.Event('change'));
  assert.equal(settings.get('ui.hiddenNote'), false);
  assert.equal(shadow.querySelector('[data-key="ui.hiddenNote"]').checked, false);
  assert.match(shadow.querySelector('.toast.error').textContent, /save|storage/i);
});

test('invalid numeric edits stay in the field with an associated error and can be corrected', () => {
  const features = [{ id: 'demo', section: 'feed', title: 'Demo', default: true, options: [{ key: 'days', type: 'number', label: 'Days', default: 7, min: 1, max: 30 }] }];
  const { win, shadow, panel, settings } = setup({ features });
  panel.open('feed');
  let input = shadow.querySelector('[data-key="demo.days"]');
  input.value = '50';
  input.dispatchEvent(new win.Event('change'));
  input = shadow.querySelector('[data-key="demo.days"]');
  assert.equal(input.value, '50');
  assert.equal(settings.get('demo.days'), 7);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.match(shadow.getElementById(input.getAttribute('aria-describedby')).textContent, /1.*30/);
  input.value = '12';
  input.dispatchEvent(new win.Event('change'));
  assert.equal(settings.get('demo.days'), 12);
  assert.equal(shadow.querySelector('[data-key="demo.days"]').getAttribute('aria-invalid'), null);
});

test('async feature actions show busy state, prevent duplicates and recover from rejection', async () => {
  const actions = createActions();
  let reject;
  let calls = 0;
  actions.for('demo').add('Run check', () => { calls++; return new Promise((_resolve, fail) => { reject = fail; }); });
  const { shadow, panel } = setup({ features: [{ id: 'demo', section: 'feed', title: 'Demo', default: true }], actions });
  panel.open('feed');
  const button = () => shadow.querySelector('[data-key="action:demo:0"]');
  button().focus();
  button().click();
  assert.equal(button().getAttribute('aria-busy'), 'true');
  button().click();
  assert.equal(calls, 1);
  reject(new Error('Network unavailable'));
  await tick();
  assert.equal(button().getAttribute('aria-busy'), null);
  assert.equal(shadow.activeElement, button());
  assert.match(shadow.querySelector('.toast.error').textContent, /Run check/);
});

test('oversized restore files are rejected before their contents are read', async () => {
  const { win, shadow, panel, settings } = setup();
  panel.open('general');
  let reads = 0;
  const file = { size: 1024 * 1024 + 1, text: async () => { reads++; return '{}'; } };
  const input = shadow.querySelector('input[type="file"]');
  Object.defineProperty(input, 'files', { value: [file] });
  input.dispatchEvent(new win.Event('change'));
  await tick();
  assert.equal(reads, 0);
  assert.deepEqual(settings.snapshot(), {});
  assert.match(shadow.querySelector('.toast.error').textContent, /1 MB/);
});

test('a preference refresh preserves an unfinished draft, caret and scroll position', () => {
  const features = [{ id: 'demo', section: 'feed', title: 'Demo', default: true, options: [{ key: 'words', type: 'text', label: 'Words', default: '' }] }];
  const { win, shadow, panel, settings } = setup({ features });
  panel.open('feed');
  const input = shadow.querySelector('textarea');
  input.value = 'unfinished words';
  input.dispatchEvent(new win.Event('input'));
  input.focus();
  input.setSelectionRange(4, 8);
  shadow.querySelector('main').scrollTop = 90;
  settings.set('ui.hiddenNote', true);
  const replacement = shadow.querySelector('textarea');
  assert.equal(replacement.value, 'unfinished words');
  assert.equal(shadow.activeElement, replacement);
  assert.deepEqual([replacement.selectionStart, replacement.selectionEnd], [4, 8]);
  assert.equal(shadow.querySelector('main').scrollTop, 90);
  assert.equal(settings.get('demo.words'), '');
});

test('search finds settings by their words, opens the section at the switch, and clears back to the sections', () => {
  const features = [
    { id: 'quiet', section: 'feed', android: 'Quiet', title: 'Hide sponsored posts', description: 'Ads leave the feed.', default: false },
    { id: 'speedy', section: 'playback', android: 'Speedy', title: 'Keep your video speed', description: 'The speed you pick stays.', default: false,
      options: [{ key: 'step', type: 'select', label: 'Speed step', default: 1, choices: [{ value: 1, label: 'Quarter steps' }] }] },
  ];
  const { shadow, panel, win } = setup({ features });
  panel.open('feed');
  const search = shadow.querySelector('[data-key="search"]');
  const type = (text) => {
    search.value = text;
    search.dispatchEvent(new win.Event('input', { bubbles: true }));
  };
  type('quarter');
  assert.equal(shadow.querySelector('#hfw-section-title').textContent, 'Search');
  assert.deepEqual([...shadow.querySelectorAll('.result .title')].map((node) => node.textContent), ['Keep your video speed'], 'choice names count');
  assert.equal(shadow.querySelector('nav [aria-current="page"]'), null, 'no section is current while searching');
  assert.ok(shadow.querySelector('.result [data-key="speedy"]'), 'the switch works from the results');
  type('zebra');
  assert.match(shadow.querySelector('main .empty').textContent, /No setting matches "zebra"/);
  type('SPEED keep');
  shadow.querySelector('[data-key="show:speedy"]').click();
  assert.equal(shadow.querySelector('#hfw-section-title').textContent, 'Playback');
  assert.equal(shadow.activeElement?.dataset.key, 'speedy', "the feature's switch has focus");
  assert.equal(search.value, '');
  type('sponsored');
  shadow.querySelector('[data-key="nav:general"]').click();
  assert.equal(shadow.querySelector('#hfw-section-title').textContent, 'General', 'a section button clears the search');
  assert.equal(search.value, '');
});

test("the extension's update notice heads General while a newer release is out, and links to it", () => {
  let found = { version: '0.0.9', url: 'https://github.com/SysAdminDoc/HushFacebookWeb/releases/tag/v0.0.9' };
  const { shadow, panel } = setup({ update: () => found });
  panel.open('general');
  const card = shadow.querySelector('[data-key="update"]');
  assert.ok(card, 'the card shows');
  assert.equal(card.querySelector('.title').textContent, 'HushFacebook Web 0.0.9 is out');
  assert.match(card.querySelector('.desc').textContent, /^You have 0\.0\.1\. /);
  const link = card.querySelector('a.button');
  assert.equal(link.getAttribute('href'), found.url);
  assert.equal(link.getAttribute('target'), '_blank');
  found = null;
  panel.refresh();
  assert.ok(!shadow.querySelector('[data-key="update"]'), 'gone once there is nothing newer');
});

test('without an update source General has no notice', () => {
  const { shadow, panel } = setup();
  panel.open('general');
  assert.ok(!shadow.querySelector('[data-key="update"]'));
  assert.ok(!shadow.querySelector('main, .main')?.textContent.includes('null'), 'no stray text');
});
