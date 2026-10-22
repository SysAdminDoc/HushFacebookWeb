// The settings panel in happy-dom. The panel reads browser globals (document, Node, CSS,
// requestAnimationFrame, navigator, setTimeout, clearTimeout), so each test lends it a happy-dom window's and puts the
// originals back afterwards. Its shadow root is closed, so attachShadow is wrapped to keep it.

import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { createActions } from '../src/core/actions.js';
import { activityKeyFor, createActivityStorage } from '../src/core/activity.js';
import { createDiagnostics } from '../src/core/diagnostics.js';
import { createHider } from '../src/core/dom/hide.js';
import { setLanguage, t } from '../src/core/i18n.js';
import { createLog } from '../src/core/log.js';
import { createSettings } from '../src/core/settings.js';
import { applyObjectMutation, createMemoryStorage } from '../src/core/storage.js';
import { features as allFeatures } from '../src/features/index.js';
import { startFeatures } from '../src/core/start-features.js';
import { mountPanel } from '../src/ui/panel.js';
import { SEEN_SETTINGS_KEY } from '../src/ui/new-dots.js';
import { QUICK_SETUPS } from '../src/ui/quick-setups.js';
import menuEntry from '../src/features/menu/menu-entry.js';

const GLOBALS = ['document', 'Node', 'CSS', 'requestAnimationFrame', 'navigator', 'setTimeout', 'clearTimeout'];
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

function setup({ features = [], actions = null, unavailable = new Map(), storage = createMemoryStorage(), update, environment = {}, beforeMount, migrations, tabPaused } = {}) {
  const win = testWindow('https://www.facebook.com/');
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
  const settings = createSettings({ storage, features, log, migrations, tabPaused });
  beforeMount?.(settings);
  const hider = createHider({ doc: win.document, log });
  const diagnostics = createDiagnostics();
  const panel = mountPanel({
    settings, features, log, hider, diagnostics, actions, unavailable,
    environment: { version: '0.0.1', manager: 'Tampermonkey', managerVersion: '5.4.1', mode: 'page', pageAccess: 'page', update, ...environment },
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
  diagnostics.decide({ post: null, rule: 'Filter', detail: 'crypto', layer: 'page' });
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
  assert.match(report[start + 2], /page no id yet Filter$/, 'the filter phrase stays in the panel');
  assert.ok(!copied[0].includes('crypto'));
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

test('the language under General redraws the panel in it, mirrors it for right to left and keeps the report English', async () => {
  const { win, shadow, panel, settings, copied } = setup({ features: allFeatures });
  cleanups.push(() => setLanguage('en'));
  panel.open('general');
  const root = shadow.querySelector('.root');
  const choose = (value) => {
    const select = shadow.querySelector('select[data-key="ui.language"]');
    select.value = value;
    select.dispatchEvent(new win.Event('change'));
  };
  const titleOf = () => shadow.querySelector('select[data-key="ui.language"]').closest('.card').querySelector('.title').textContent;
  assert.deepEqual([root.getAttribute('lang'), root.getAttribute('dir')], ['en', 'ltr']);
  assert.equal(titleOf(), 'Language');
  choose('long-test');
  assert.equal(settings.get('ui.language'), 'long-test');
  assert.equal(titleOf(), `${t('Language')} (Language)`, 'the English name stays next to the shown one');
  assert.match(titleOf(), /^\[\S+ /);
  assert.deepEqual([...shadow.querySelector('select[data-key="ui.language"]').options].map((option) => option.textContent), ['English', 'Test: long text', 'Test: right to left'], 'each language keeps its own name');
  assert.equal(shadow.querySelector('[data-key="search"]').placeholder, t('Find a setting'));
  assert.equal(shadow.querySelector('nav').getAttribute('aria-label'), t('Settings sections'));
  panel.toast(() => t('Saved {name}', { name: 'photo.jpg' }));
  assert.match(shadow.querySelector('.toast span').textContent, /^\[\S+ photo\.jpg .+\]$/, 'a notice made as a function is worded when it shows');

  const search = shadow.querySelector('[data-key="search"]');
  search.value = 'locale';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.ok(shadow.querySelector('select[data-key="ui.language"]'), 'its English words still find the row');
  search.value = '';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));

  panel.open('diagnostics');
  const labels = [...shadow.querySelectorAll('dt')].map((dt) => dt.textContent);
  assert.ok(labels.length && labels.every((label) => label.startsWith('[')), 'every Diagnostics label is shown in the language');
  assert.ok([...shadow.querySelectorAll('.log')].every((box) => box.getAttribute('dir') === 'ltr'), 'the log reads left to right');
  [...shadow.querySelectorAll('button')].find((button) => button.textContent === t('Copy report')).click();
  await tick();
  assert.equal(copied.length, 1);
  assert.doesNotMatch(copied[0], /[À-ɏḀ-ỿ]/, 'Copy report stays in English');

  panel.open('general');
  choose('rtl-test');
  assert.deepEqual([root.getAttribute('lang'), root.getAttribute('dir')], ['en', 'rtl']);
  assert.equal(titleOf(), 'Language', 'right to left keeps the English');
  choose('en');
  assert.deepEqual([root.getAttribute('dir'), titleOf()], ['ltr', 'Language']);
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

test('General puts a privacy-safe filled problem report directly above Ko-fi', () => {
  const { shadow, panel, settings } = setup({ features: allFeatures });
  settings.set('hideTyping', true);
  panel.open('general');
  const cards = [...shadow.querySelectorAll('.settings-group > .card')];
  const report = cards.at(-2);
  assert.equal(report.dataset.key, 'report-problem');
  assert.equal(report.nextElementSibling.dataset.key, 'kofi');
  assert.equal(report.querySelector('.title').textContent, 'Report a problem');
  assert.equal(report.querySelector('.desc').textContent, 'Opens a GitHub report with your versions and settings filled in. Add what happened.');
  assert.equal(report.getAttribute('target'), '_blank');
  assert.equal(report.getAttribute('rel'), 'noopener noreferrer');
  const url = new URL(report.getAttribute('href'));
  assert.equal(`${url.origin}${url.pathname}`, 'https://github.com/SysAdminDoc/HushFacebookWeb/issues/new');
  assert.equal(url.searchParams.get('title'), 'HushFacebook Web 0.0.1 problem');
  const body = url.searchParams.get('body');
  assert.match(body, /^Userscript manager: Tampermonkey 5\.4\.1$/m);
  assert.match(body, /^- Show the settings button on Facebook$/m);
  assert.match(body, /^- Hide typing indicator$/m);
  assert.match(body, /What happened:\n\n\nWhat I expected:\n$/);
  assert.ok(body.length <= 6000);
});

test('Quick setups report their changed count and Back to defaults raises Reload when needed', () => {
  const quiet = QUICK_SETUPS.find((setup) => setup.id === 'quiet');
  const privacy = QUICK_SETUPS.find((setup) => setup.id === 'privacy');
  const first = setup({ features: allFeatures });
  first.panel.open('general');
  const clickSetup = (label) => [...first.shadow.querySelectorAll('[data-key="quick-setups"] button')].find((button) => button.textContent === label).click();
  const expectedQuiet = quiet.keys.filter((key) => first.settings.get(key) !== true).length;
  clickSetup('Quiet');
  assert.equal(first.shadow.querySelector('.toast:last-child span').textContent, `Changed ${expectedQuiet} settings`);
  assert.ok(quiet.keys.every((key) => first.settings.get(key) === true));
  const expectedPrivacy = privacy.keys.filter((key) => first.settings.get(key) !== true).length;
  clickSetup('Privacy');
  assert.equal(first.shadow.querySelector('.toast:last-child span').textContent, `Changed ${expectedPrivacy} settings`);
  assert.ok(privacy.keys.every((key) => first.settings.get(key) === true));

  const storage = createMemoryStorage({ settings: { blockInstantGamesAds: true } });
  const second = setup({ features: allFeatures, storage });
  second.panel.open('general');
  [...second.shadow.querySelectorAll('[data-key="quick-setups"] button')].find((button) => button.textContent === 'Back to defaults').click();
  assert.equal(second.settings.get('blockInstantGamesAds'), false);
  assert.ok(second.shadow.querySelector('[data-key="reload-facebook"]'), 'resetting a reload-gated page-load choice raises Reload');
});

test('Back to defaults clears invalid drafts even when saved settings already use their defaults', () => {
  const features = [{ id: 'demo', section: 'feed', title: 'Demo', default: true, options: [{ key: 'days', type: 'number', label: 'Days', default: 7, min: 1, max: 30 }] }];
  const { win, shadow, panel, settings } = setup({ features });
  panel.open('feed');
  let input = shadow.querySelector('[data-key="demo.days"]');
  input.value = '99';
  input.dispatchEvent(new win.Event('change'));
  input = shadow.querySelector('[data-key="demo.days"]');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(settings.get('demo.days'), 7);

  panel.open('general');
  [...shadow.querySelectorAll('[data-key="quick-setups"] button')].find((button) => button.textContent === 'Back to defaults').click();
  panel.open('feed');
  input = shadow.querySelector('[data-key="demo.days"]');
  assert.equal(input.value, '7');
  assert.equal(input.getAttribute('aria-invalid'), null);
});

test('Quick setups wait for extension storage and preserve unrelated saved choices', () => {
  const data = new Map();
  const atLoad = new Map();
  const ready = [];
  const storage = {
    kind: 'extension',
    get: (key, fallback) => (data.has(key) ? structuredClone(data.get(key)) : fallback),
    getAtLoad: (key, fallback) => (atLoad.has(key) ? structuredClone(atLoad.get(key)) : fallback),
    set: (key, value) => void data.set(key, structuredClone(value)),
    remove: (key) => void data.delete(key),
    onChange() {},
    whenReady: (run) => ready.push(run),
  };
  const quiet = QUICK_SETUPS.find((setup) => setup.id === 'quiet');
  const { shadow, panel, settings } = setup({ features: allFeatures, storage });
  panel.open('general');
  shadow.querySelector('[data-key="quick:quiet"]').click();
  assert.equal(shadow.querySelector('[data-key="quick:quiet"]').getAttribute('aria-busy'), 'true');
  assert.equal(settings.get('cleanUpReels'), false, 'the setup has not used unloaded defaults');
  const laterToggle = shadow.querySelector('[data-key="ui.hiddenNote"]');
  assert.equal(laterToggle.disabled, true, 'later preference actions wait behind the deferred setup');
  laterToggle.click();
  assert.equal(settings.get('ui.hiddenNote'), false);

  data.set('settings', { forceDarkMode: true });
  atLoad.set('settings', { forceDarkMode: true });
  for (const run of ready.splice(0)) run();

  assert.equal(settings.get('forceDarkMode'), true);
  assert.ok(quiet.keys.every((key) => settings.get(key) === true));
  assert.equal(data.get('settings').forceDarkMode, true);
  assert.equal(shadow.querySelector('[data-key="quick:quiet"]').getAttribute('aria-busy'), null);
  assert.equal(shadow.querySelector('[data-key="ui.hiddenNote"]').disabled, false);
  assert.match(shadow.querySelector('.toast:last-child').textContent, /^Changed \d+ settings$/);
});

test('a Quick setup waiting on failed startup storage leaves Retry available', async () => {
  const data = new Map();
  const atLoad = new Map();
  const ready = [];
  const statusListeners = new Set();
  let state = 'loading';
  const storage = {
    kind: 'extension',
    get: (key, fallback) => (data.has(key) ? structuredClone(data.get(key)) : fallback),
    getAtLoad: (key, fallback) => (atLoad.has(key) ? structuredClone(atLoad.get(key)) : fallback),
    set: (key, value) => void data.set(key, structuredClone(value)),
    remove: (key) => void data.delete(key),
    onChange() {},
    whenReady: (run) => ready.push(run),
    status: () => ({ state, error: state === 'error' ? new Error('bridge unavailable') : null }),
    onStatus(listener) {
      statusListeners.add(listener);
      listener(this.status());
    },
    async retry() {
      state = 'loading';
      for (const listener of statusListeners) listener(this.status());
      for (const run of ready.splice(0)) run();
      state = 'ready';
      for (const listener of statusListeners) listener(this.status());
      return true;
    },
  };
  const { shadow, panel } = setup({ features: allFeatures, storage, environment: { storage } });
  panel.open('general');
  shadow.querySelector('[data-key="quick:privacy"]').click();

  state = 'error';
  for (const listener of statusListeners) listener(storage.status());
  const retry = shadow.querySelector('[data-key="storage:retry"]');
  assert.equal(retry.disabled, false);
  retry.click();
  await tick();

  assert.equal(shadow.querySelector('[data-key="storage-recovery"]'), null);
  assert.equal(shadow.querySelector('[data-key="quick:privacy"]').getAttribute('aria-busy'), null);
});

test('a reload-required change shows the top row and remembers its settings page through reload', () => {
  const feature = { id: 'restartMe', section: 'feed', title: 'Restart me', description: 'Needs a reload.', default: false, reload: true, setup() {} };
  const values = new Map();
  const sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  let reloads = 0;
  const first = setup({ features: [feature], environment: { sessionStorage, now: () => 1_000, reload: () => reloads++ } });
  first.panel.open('feed');
  assert.equal(first.shadow.querySelector('[data-key="reload-facebook"]'), null);
  const toggle = first.shadow.querySelector('input[data-key="restartMe"]');
  toggle.checked = true;
  toggle.dispatchEvent(new toggle.ownerDocument.defaultView.Event('change'));
  const row = first.shadow.querySelector('[data-key="reload-facebook"]');
  assert.equal(row.parentElement.children[1], row, 'the reload row follows the page heading');
  assert.equal(row.querySelector('.title').textContent, 'Reload Facebook to apply this change');
  row.querySelector('button').click();
  assert.equal(reloads, 1);
  const marker = JSON.parse([...values.values()][0]);
  assert.deepEqual(marker, { page: 'feed', timestamp: 1_000 });

  const second = setup({ features: [feature], environment: { sessionStorage, now: () => 1_001, reload() {} } });
  assert.equal(second.shadow.querySelector('dialog').open, true);
  assert.equal(second.shadow.querySelector('#hfw-section-title').textContent, 'News feed');
  assert.equal(values.size, 0, 'the marker is one shot');

  const changedLate = setup({
    features: [feature],
    beforeMount: (settings) => settings.set('restartMe', true),
    environment: { sessionStorage, now: () => 1_001, reload() {} },
  });
  changedLate.panel.open('feed');
  assert.ok(changedLate.shadow.querySelector('[data-key="reload-facebook"]'), 'a change made before panel mount still compares with page load');
  changedLate.settings.set('restartMe', false);
  assert.equal(changedLate.shadow.querySelector('[data-key="reload-facebook"]'), null, 'returning to the page-load value clears the row');
});

test('reload returns to the active Search page and query', () => {
  const feature = { id: 'restartMe', section: 'feed', title: 'Restart me', description: 'Needs a reload.', default: false, reload: true, setup() {} };
  const values = new Map();
  const sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const first = setup({ features: [feature], environment: { sessionStorage, now: () => 2_000, reload() {} } });
  first.panel.open('feed');
  const search = first.shadow.querySelector('[data-key="search"]');
  search.value = 'restart';
  search.dispatchEvent(new search.ownerDocument.defaultView.Event('input'));
  const toggle = first.shadow.querySelector('input[data-key="restartMe"]');
  toggle.checked = true;
  toggle.dispatchEvent(new toggle.ownerDocument.defaultView.Event('change'));
  first.shadow.querySelector('[data-key="reload-facebook"] button').click();
  assert.deepEqual(JSON.parse([...values.values()][0]), {
    page: 'find', section: 'feed', query: 'restart', timestamp: 2_000,
  });

  const second = setup({ features: [feature], environment: { sessionStorage, now: () => 2_001, reload() {} } });
  assert.equal(second.shadow.querySelector('dialog').open, true);
  assert.equal(second.shadow.querySelector('#hfw-section-title').textContent, 'Search');
  assert.equal(second.shadow.querySelector('[data-key="search"]').value, 'restart');
  assert.equal(values.size, 0);
});

test('reload distinguishes the Search section from finding a setting', () => {
  const feature = { id: 'restartMe', section: 'search', title: 'Restart me', description: 'Needs a reload.', default: false, reload: true, setup() {} };
  const values = new Map();
  const sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const first = setup({ features: [feature], environment: { sessionStorage, now: () => 3_000, reload() {} } });
  first.panel.open('search');
  first.settings.set('restartMe', true);
  first.shadow.querySelector('[data-key="reload-facebook"] button').click();
  assert.deepEqual(JSON.parse([...values.values()][0]), { page: 'search', timestamp: 3_000 });

  const second = setup({ features: [feature], environment: { sessionStorage, now: () => 3_001, reload() {} } });
  assert.equal(second.shadow.querySelector('dialog').open, true);
  assert.equal(second.shadow.querySelector('[data-key="nav:search"]').getAttribute('aria-current'), 'page');
  assert.equal(second.shadow.querySelector('[data-key="search"]').value, '');
  assert.equal(values.size, 0);
});

test('a reload-required change waits for acknowledgement and keeps the startup baseline', () => {
  const feature = { id: 'restartMe', section: 'feed', title: 'Restart me', description: 'Needs a reload.', default: false, reload: true, setup() {} };
  const data = new Map();
  const ready = [];
  const storage = {
    kind: 'extension',
    get: (key, fallback) => (data.has(key) ? structuredClone(data.get(key)) : fallback),
    set: (key, value) => void data.set(key, structuredClone(value)),
    remove: (key) => void data.delete(key),
    onChange() {},
    whenReady: (run) => ready.push(run),
  };
  const { panel, settings, shadow } = setup({ features: [feature], storage, environment: { sessionStorage: null } });
  panel.open('feed');
  settings.set('restartMe', true);
  assert.equal(shadow.querySelector('[data-key="reload-facebook"]'), null, 'an unsaved draft is not presented as active');
  assert.match(shadow.querySelector('[data-key="save-state"]').textContent, /Saving/);
  for (const run of ready.splice(0)) run();
  assert.equal(settings.pageLoadValue('restartMe'), false);
  assert.ok(shadow.querySelector('[data-key="reload-facebook"]'), 'storage readiness does not absorb the change');
  settings.set('restartMe', false);
  assert.equal(shadow.querySelector('[data-key="reload-facebook"]'), null);
});

test('an expired reload marker is cleared without opening settings', () => {
  const values = new Map([['hfw:settings-reload', JSON.stringify({ page: 'general', timestamp: 1_000 })]]);
  const sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const { shadow } = setup({ environment: { sessionStorage, now: () => 91_001, reload() {} } });
  assert.equal(shadow.querySelector('dialog').open, false);
  assert.equal(values.size, 0);
});

test('malformed reload markers are consumed without opening settings', () => {
  for (const marker of [
    { page: 'general', timestamp: '1000' },
    { page: 'missing', timestamp: 1_000 },
  ]) {
    const values = new Map([['hfw:settings-reload', JSON.stringify(marker)]]);
    const sessionStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
    const { shadow } = setup({ environment: { sessionStorage, now: () => 1_001, reload() {} } });
    assert.equal(shadow.querySelector('dialog').open, false);
    assert.equal(values.size, 0);
  }
});

test('a blocked browser storage getter does not stop settings from mounting', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() { throw new Error('blocked'); },
  });
  cleanups.push(() => {
    if (saved) Object.defineProperty(globalThis, 'sessionStorage', saved);
    else delete globalThis.sessionStorage;
  });
  const { shadow, log } = setup();
  assert.ok(shadow.querySelector('dialog'));
  assert.match(log.entries().at(-1).message, /Couldn't access reload recovery storage/);
});

test('settings do not reopen when the one-shot reload marker cannot be cleared', () => {
  const sessionStorage = {
    getItem: () => JSON.stringify({ page: 'general', timestamp: 1_000 }),
    setItem() {},
    removeItem() { throw new Error('denied'); },
  };
  const { shadow, log } = setup({ environment: { sessionStorage, now: () => 1_001, reload() {} } });
  assert.equal(shadow.querySelector('dialog').open, false, 'clear happens before open');
  assert.match(log.entries().at(-1).message, /Couldn't reopen settings/);
});

test('rows a feature adds show in Diagnostics, follow its changes and go in the report', async () => {
  const { shadow, panel, diagnostics, copied } = setup();
  let hits = 0;
  diagnostics.add('Ads hidden on the page', () => (hits ? `header label ${hits}` : 'None yet'), { shareable: true });
  diagnostics.add('Broken row', () => { throw new Error('nope'); });
  diagnostics.add('Filter hits', () => (hits ? `cats ${hits}` : 'None yet'));
  diagnostics.add('Videos', () => String(hits));
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
  assert.equal(row(shadow, 'Filter hits'), 'cats 2', 'the panel shows the text');
  assert.match(copied[0], /^Filter hits: left out$/m, 'a row that may hold your text goes as left out');
  assert.match(copied[0], /^Videos: 2$/m, 'a count goes as it is');
  assert.match(copied[0], /^Broken row: left out$/m);
});

test('Copy report leaves out setting text, row text, log details and post ids', async () => {
  const feature = { id: 'demo', section: 'feed', title: 'Demo', description: 'A demo switch.', default: true, options: [{ key: 'words', type: 'text', default: '', label: 'Words' }], setup() {} };
  const { shadow, panel, settings, diagnostics, log, copied } = setup({ features: [feature] });
  settings.set('demo.words', 'PRIVATE-WORDS');
  diagnostics.add('Words matched', () => 'PRIVATE-ROW');
  diagnostics.status('demo', () => 'PRIVATE-STATUS');
  diagnostics.decide({ post: 'PRIVATE-POST', rule: 'Filter', detail: 'PRIVATE-PHRASE', layer: 'page' });
  log.warn('A line was skipped', 'PRIVATE-DETAIL');
  panel.open('diagnostics');
  [...shadow.querySelectorAll('button')].find((button) => button.textContent === 'Copy report').click();
  await tick();
  assert.equal(copied.length, 1);
  assert.ok(!copied[0].includes('PRIVATE'), copied[0]);
  assert.match(copied[0], /^Text settings filled in, text left out: demo\.words$/m);
  assert.match(copied[0], /warn A line was skipped \[string\]$/m);
});

test("a feature's own buttons show on its card while it's on, follow its state and run when clicked", async () => {
  const feature = { id: 'demo', section: 'feed', title: 'Demo', description: 'A demo switch.', default: true, setup() {} };
  const actions = createActions();
  let showing = false;
  actions.for('demo').add(() => (showing ? '' : 'Show nothing'), () => {});
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
  assert.equal(shadow.querySelectorAll('[data-key^="action:demo:"]').length, 1, 'an empty label leaves its button off the card');
  assert.equal(button('Hide them again').dataset.key, 'action:demo:1', 'and the next button keeps its place');
  assert.equal(shadow.activeElement, button('Hide them again'), 'focus follows the replacement action');
  settings.set('demo', false);
  await tick();
  assert.equal(button('Hide them again'), undefined, 'no buttons while the switch is off');
});

test("a feature's status line shows on its card while it's on and changes without taking focus", async () => {
  const feature = { id: 'demo', section: 'feed', title: 'Demo', description: 'A demo switch.', default: true, options: [{ key: 'words', type: 'text', default: '', label: 'Words' }], setup() {} };
  const { shadow, panel, settings, diagnostics } = setup({ features: [feature] });
  let text = 'Counted 1 post';
  diagnostics.status('demo', () => text);
  panel.open('feed');
  const line = () => shadow.querySelector('[data-status-for="demo"]');
  assert.equal(line().textContent, 'Counted 1 post');
  assert.equal(line().hidden, false);
  const field = shadow.querySelector('[data-key="demo.words"]');
  field.focus();
  text = 'Counted 2 posts';
  diagnostics.changed();
  await tick();
  assert.equal(line().textContent, 'Counted 2 posts');
  assert.equal(shadow.activeElement, field, 'the list being typed in keeps its focus');
  text = null;
  diagnostics.changed();
  await tick();
  assert.equal(line().hidden, true, 'no line while the feature has nothing to say');
  text = 'Back';
  settings.set('demo', false);
  await tick();
  assert.equal(line(), null, 'no line while the switch is off');
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
  unavailable.set('menuEntry', 'failed');
  panel.refresh();
  assert.equal(launcher.hidden, false);
});

const describedText = (shadow, control) => (control.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
  .map((id) => [...shadow.querySelectorAll('[id]')].find((node) => node.id === id)?.textContent ?? `missing #${id}`);

test('each switch reads its help, why it is unavailable and the reload note, in sections and search', async () => {
  const features = [
    { id: 'quiet', section: 'feed', title: 'Quiet', description: 'Quiet help.', default: false },
    { id: 'needy', section: 'feed', title: 'Needy', description: 'Needy help.', default: false, reload: true },
    { id: 'popper', section: 'feed', title: 'Popper', description: 'Popper help.', default: false },
    { id: 'broken', section: 'feed', title: 'Broken', description: 'Broken help.', default: true },
  ];
  const unavailable = new Map([['needy', 'page'], ['popper', 'api'], ['broken', 'failed']]);
  const { win, shadow, panel, copied } = setup({ features, unavailable });
  panel.open('feed');
  const control = (key) => shadow.querySelector(`main [data-key="${key}"]`);
  assert.deepEqual(describedText(shadow, control('quiet')), ['Quiet help.']);
  const [needyHelp, needyNote, needyReload] = describedText(shadow, control('needy'));
  assert.equal(needyHelp, 'Needy help.');
  assert.match(needyNote, /has to run in Facebook's page, and your userscript manager runs the script outside it/);
  assert.equal(needyReload, 'Applies after Facebook reloads.');
  assert.match(describedText(shadow, control('popper'))[1], /^Your browser or userscript manager doesn't offer what this one needs\.$/);
  assert.match(describedText(shadow, control('broken'))[1], /couldn't start on this page, or stopped working.*You can still turn it off\.$/);
  for (const key of ['needy', 'popper']) {
    assert.equal(control(key).getAttribute('aria-disabled'), 'true', `${key} can't turn on`);
    assert.equal(control(key).disabled, false, `${key} stays focusable, so its note is read`);
  }
  assert.equal(control('broken').getAttribute('aria-disabled'), null, 'an unavailable switch that is on can turn off');
  assert.equal(shadow.querySelectorAll('[id]').length, new Set([...shadow.querySelectorAll('[id]')].map((node) => node.id)).size, 'ids are unique');

  const search = shadow.querySelector('[data-key="search"]');
  search.value = 'needy';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.deepEqual(describedText(shadow, shadow.querySelector('.result [data-key="needy"]')).slice(0, 2), [needyHelp, needyNote], 'a search result reads the same notes');
  search.value = 'settings button';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.match(describedText(shadow, shadow.querySelector('.result [data-key="ui.launcher"]'))[0], /^The sliders button in Facebook's bottom-left corner/);

  panel.open('general');
  assert.match(describedText(shadow, control('ui.hiddenNote'))[0], /^A short line that says why a post was hidden/);
  panel.open('diagnostics');
  assert.equal(row(shadow, "Features that didn't start"), 'Needy (needs page access), Popper (missing from this browser or manager), Broken (see the log)');
  shadow.querySelector('[data-key="copy-report"]').click();
  await tick();
  assert.ok(copied[0].split('\n').includes('Unavailable: needy (page), popper (api), broken (failed)'), copied[0]);
});

test('a switch that cannot turn on ignores clicks and keys but keeps focus', () => {
  const needy = { id: 'needy', section: 'feed', title: 'Needy', description: 'Needy help.', default: false };
  const { win, shadow, panel, settings } = setup({ features: [needy], unavailable: new Map([['needy', 'page']]) });
  panel.open('feed');
  const control = shadow.querySelector('main [data-key="needy"]');
  control.focus();
  control.click();
  control.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(control.checked, false);
  assert.equal(settings.get('needy'), false);
  assert.equal(shadow.activeElement?.dataset.key, 'needy');
});

test('switching off a feature that failed partway stops the part that started, without Reset or Pause', () => {
  // The first hook works and the second throws, the way a Facebook change breaks one of two.
  const flaky = {
    id: 'flaky', section: 'feed', title: 'Flaky', description: 'Two hooks.', default: true,
    setup({ doc, enabled, settings }) {
      const survivor = () => doc.body.classList.toggle('flaky-on', enabled());
      survivor();
      settings.subscribe(survivor);
      throw new Error('the second hook found nothing');
    },
  };
  let late = null;
  const later = { id: 'later', section: 'feed', title: 'Later', description: 'Stops later.', default: true, setup({ markUnavailable }) { late = markUnavailable; } };
  const needy = { id: 'needy', section: 'feed', title: 'Needy', description: 'Needs the page.', default: false, needsPage: true, setup() { throw new Error('must not run'); } };
  const features = [flaky, later, needy];
  const { win, shadow, panel, settings, unavailable, log } = setup({ features });
  startFeatures({ features, net: null, settings, log, unavailable, context: () => ({ doc: win.document }), changed: () => panel.refresh() });
  assert.deepEqual([...unavailable], [['flaky', 'failed'], ['needy', 'page']]);
  assert.ok(log.entries().some((entry) => entry.message === "Flaky couldn't start"));
  const body = win.document.body.classList;
  assert.equal(body.contains('flaky-on'), true, 'the first hook survived the failed setup');

  panel.open('feed');
  const flakySwitch = () => shadow.querySelector('main [data-key="flaky"]');
  assert.equal(flakySwitch().checked, true);
  flakySwitch().click();
  assert.equal(settings.get('flaky'), false);
  assert.equal(body.contains('flaky-on'), false, 'switching it off stopped the surviving hook');
  assert.notEqual(settings.get('paused'), true, 'without pausing everything');
  assert.equal(settings.get('later'), true, 'and without resetting anything else');
  assert.equal(flakySwitch().getAttribute('aria-disabled'), 'true', "off now, it can't come back on");
  flakySwitch().click();
  assert.equal(settings.get('flaky'), false);
  assert.equal(body.contains('flaky-on'), false);

  late();
  assert.equal(unavailable.get('later'), 'failed');
  assert.match(describedText(shadow, shadow.querySelector('main [data-key="later"]'))[1], /stopped working.*You can still turn it off/, 'a feature that stops later redraws the open panel');
});

test('the search count is spoken once it settles, from one live region, without moving focus', async () => {
  const features = [
    { id: 'quiet', section: 'feed', title: 'Wobble the feed', description: 'Shakes it.', default: false },
    { id: 'speedy', section: 'playback', title: 'Keep your video speed', description: 'The speed you pick stays.', default: false },
  ];
  const { win, shadow, panel, settings } = setup({ features });
  panel.open('feed');
  mock.timers.enable({ apis: ['setTimeout'] });
  cleanups.push(() => mock.timers.reset());
  const status = shadow.querySelector('[data-key="search-status"]');
  assert.ok(status.closest('dialog'), 'it sits inside the modal, where a screen reader can reach it');
  const writes = [];
  new win.MutationObserver((records) => writes.push(...records)).observe(status, { childList: true, characterData: true, subtree: true });
  const search = shadow.querySelector('[data-key="search"]');
  search.focus();
  const type = (text) => {
    search.value = text;
    search.dispatchEvent(new win.Event('input', { bubbles: true }));
  };
  type('w');
  mock.timers.tick(300);
  type('wo');
  mock.timers.tick(300);
  type('wob');
  mock.timers.tick(599);
  assert.equal(status.textContent, '', 'nothing while typing goes on');
  assert.match(shadow.querySelector('.page-heading p').textContent, /^1 setting matches\.$/, 'the visible count keeps up');
  assert.deepEqual([...shadow.querySelectorAll('[role="status"]')].map((node) => node.dataset.key), ['save-state', 'search-status'], 'nothing inside the redrawn page is a live region');
  mock.timers.tick(1);
  assert.equal(status.textContent, '1 setting matches.');
  settings.set('quiet', true);
  type('wobble');
  mock.timers.tick(5000);
  await tick();
  assert.equal(writes.length, 1, 'a redraw or a longer word with the same count says nothing new');
  type('zebra');
  mock.timers.tick(600);
  assert.equal(status.textContent, 'No setting matches.');
  assert.equal(shadow.activeElement, search, 'focus stays in the search box');
  panel.close();
  await tick();
  assert.equal(status.textContent, '', 'closing settings takes the words away');
  panel.open();
  mock.timers.tick(600);
  assert.equal(status.textContent, 'No setting matches.', 'and opening them again on the same search says it again');
  type('');
  assert.equal(status.textContent, '', 'leaving the search clears it at once');
  mock.timers.tick(5000);
  assert.equal(status.textContent, '');
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

test('Reset stays busy until extension settings load and Undo receives the saved snapshot', async () => {
  const data = new Map([['settings', { 'ui.hiddenNote': true }]]);
  const ready = [];
  const storage = {
    kind: 'extension',
    get: (key, fallback) => (data.has(key) ? structuredClone(data.get(key)) : fallback),
    getAtLoad: (key, fallback) => (data.has(key) ? structuredClone(data.get(key)) : fallback),
    whenReady: (run) => ready.push(run),
    onChange() {},
    mutate(key, mutation) {
      const value = applyObjectMutation(data.get(key), mutation);
      data.set(key, structuredClone(value));
      return Promise.resolve(structuredClone(value));
    },
    set: (key, value) => data.set(key, structuredClone(value)),
  };
  const { shadow, panel, settings } = setup({ storage });
  panel.open('general');
  shadow.querySelector('[data-key="reset"]').click();
  assert.equal(shadow.querySelector('[data-key="reset"]').textContent, 'Resetting...');
  assert.deepEqual(data.get('settings'), { 'ui.hiddenNote': true });

  for (const run of [...ready]) run();
  await tick();
  assert.deepEqual(data.get('settings'), {});
  const undo = [...shadow.querySelectorAll('.toast button')].find((button) => button.textContent === 'Undo');
  assert.ok(undo);
  undo.click();
  await tick();
  assert.equal(settings.get('ui.hiddenNote'), true);
  assert.deepEqual(data.get('settings'), { 'ui.hiddenNote': true });
});

test('an unavailable section request keeps the existing settings page usable', () => {
  const { shadow, panel } = setup();
  panel.open('missing');
  assert.equal(shadow.querySelector('#hfw-section-title').textContent, 'General');
  assert.equal(shadow.querySelector('dialog').open, true);
});

test('a synchronous manager save failure rolls the switch back and reports it', async () => {
  const storage = createMemoryStorage();
  const { win, shadow, panel, settings } = setup({ storage });
  const save = storage.set;
  storage.set = () => { throw new Error('Disk full'); };
  panel.open('general');
  const input = shadow.querySelector('[data-key="ui.hiddenNote"]');
  input.checked = true;
  input.dispatchEvent(new win.Event('change'));
  assert.equal(settings.get('ui.hiddenNote'), false);
  assert.equal(shadow.querySelector('[data-key="ui.hiddenNote"]').checked, false);
  assert.equal(shadow.querySelector('[data-key="save-recovery"]'), null);
  assert.equal(shadow.querySelector('[data-key="save-state"]').textContent, 'Changes apply as you go.');
  assert.match(shadow.querySelector('.toast.error').textContent, /save|storage/i);
  storage.set = save;
});

test('a synchronous Undo failure is reported without changing the reset settings', async () => {
  const storage = createMemoryStorage();
  const { shadow, panel, settings } = setup({ storage });
  settings.set('ui.hiddenNote', true);
  panel.open('general');
  shadow.querySelector('[data-key="reset"]').click();
  storage.set = () => { throw new Error('Disk full'); };
  [...shadow.querySelectorAll('.toast button')].find((button) => button.textContent === 'Undo').click();
  await tick();
  assert.equal(settings.get('ui.hiddenNote'), false);
  assert.match(shadow.querySelector('.toast.error').textContent, /undo|save|storage/i);
  assert.ok(shadow.querySelector('[data-key="reset:undo"]'), 'General keeps the Undo for another try');
});

// An extension-like store: saves land a moment later, the next few can be made to fail, and a
// change from another tab arrives through onChange.
function laterStorage(initial) {
  const data = new Map([['settings', structuredClone(initial)]]);
  const heard = new Map();
  const control = { failures: 0 };
  const storage = {
    kind: 'extension',
    get: (key, fallback) => (data.has(key) ? structuredClone(data.get(key)) : fallback),
    getAtLoad: (key, fallback) => (data.has(key) ? structuredClone(data.get(key)) : fallback),
    whenReady: (run) => run(),
    onChange: (key, listener) => heard.set(key, listener),
    mutate(key, mutation) {
      if (control.failures > 0) {
        control.failures--;
        return Promise.reject(new Error('Storage is full'));
      }
      const value = applyObjectMutation(data.get(key), mutation);
      data.set(key, structuredClone(value));
      return Promise.resolve(structuredClone(value));
    },
    set: (key, value) => data.set(key, structuredClone(value)),
  };
  control.remote = (value) => {
    data.set('settings', structuredClone(value));
    heard.get('settings')?.(structuredClone(value), { source: 'remote' });
  };
  return { storage, data, control };
}

const button = (shadow, text) => [...shadow.querySelectorAll('button')].find((candidate) => candidate.textContent === text);

test('Undo outlives the notice in General and still works from the keyboard much later', async () => {
  const { shadow, panel, settings } = setup();
  settings.set('ui.hiddenNote', true);
  panel.open('general');
  mock.timers.enable({ apis: ['setTimeout'] });
  cleanups.push(() => mock.timers.reset());
  shadow.querySelector('[data-key="reset"]').click();
  assert.match(shadow.querySelector('.toast').textContent, /Undo stays in General until you change a setting or leave this page/);
  mock.timers.tick(60000);
  assert.equal(shadow.querySelector('.toast'), null, 'an untouched notice still times out');
  const card = shadow.querySelector('[data-key="reset-undo"]');
  assert.match(card.textContent, /until you dismiss it or change a setting, and it's gone once you leave or reload this page/);
  assert.equal(card.closest('dialog').open, true);
  const undo = shadow.querySelector('[data-key="reset:undo"]');
  undo.focus();
  undo.click();
  await tick();
  assert.equal(settings.get('ui.hiddenNote'), true);
  assert.equal(shadow.querySelector('[data-key="reset-undo"]'), null, 'a finished Undo leaves General');
  assert.equal(shadow.activeElement, shadow.querySelector('[data-key="reset"]'));
  assert.ok([...shadow.querySelectorAll('.toast span')].some((span) => span.textContent === 'Your settings from before the reset are back.'));
});

test('a notice under the pointer or holding focus stays until both leave', async () => {
  const { win, shadow, panel, settings } = setup();
  settings.set('ui.hiddenNote', true);
  panel.open('general');
  mock.timers.enable({ apis: ['setTimeout'] });
  cleanups.push(() => mock.timers.reset());
  shadow.querySelector('[data-key="reset"]').click();
  const notice = shadow.querySelector('.toast');
  notice.dispatchEvent(new win.Event('pointerenter'));
  mock.timers.tick(60000);
  assert.ok(notice.isConnected, 'hovered');
  notice.querySelector('button').focus();
  notice.dispatchEvent(new win.Event('pointerleave'));
  mock.timers.tick(60000);
  assert.ok(notice.isConnected, 'focused');
  shadow.querySelector('[data-key="reset"]').focus();
  mock.timers.tick(6999);
  assert.ok(notice.isConnected, 'gets its full time again');
  mock.timers.tick(1);
  assert.equal(notice.isConnected, false);
  assert.equal(settings.get('ui.hiddenNote'), false);
});

test('a notice for something still running stays until it is dismissed, and its action ends it too', () => {
  const { shadow, panel } = setup();
  mock.timers.enable({ apis: ['setTimeout'] });
  cleanups.push(() => mock.timers.reset());
  const ran = [];
  const running = panel.toast('Saving Pat photo.jpg', { action: { label: 'Cancel', run: () => ran.push('cancel') }, duration: Infinity });
  const notice = shadow.querySelector('.toast:last-child');
  mock.timers.tick(3600000);
  assert.ok(notice.isConnected, 'no timeout for an open-ended notice');
  running.dismiss();
  assert.equal(notice.isConnected, false);
  running.dismiss();

  panel.toast('Saving Pat video.mp4', { action: { label: 'Cancel', run: () => ran.push('cancel') }, duration: Infinity });
  const second = shadow.querySelector('.toast:last-child');
  second.querySelector('button').click();
  assert.equal(second.isConnected, false);
  assert.deepEqual(ran, ['cancel']);

  const timed = panel.toast('Saved Pat photo.jpg');
  const third = shadow.querySelector('.toast:last-child');
  mock.timers.tick(4000);
  assert.equal(third.isConnected, false, 'an ordinary notice still times out');
  timed.dismiss();
});

test('a failed Undo keeps the earlier choices until a retry saves them', async () => {
  const { storage, data, control } = laterStorage({ 'ui.hiddenNote': true, 'ui.launcher': false });
  const { shadow, panel, settings } = setup({ storage });
  panel.open('general');
  shadow.querySelector('[data-key="reset"]').click();
  await tick();
  assert.deepEqual(data.get('settings'), {});
  control.failures = 1;
  shadow.querySelector('[data-key="reset:undo"]').click();
  await tick();
  assert.deepEqual(data.get('settings'), {});
  assert.equal(settings.get('ui.hiddenNote'), false);
  assert.match(shadow.querySelector('.toast.error').textContent, /save|undo/i);
  assert.ok(shadow.querySelector('[data-key="reset-undo"]'), 'the Undo is still offered');
  // The waiting choices are the Undo's own, so another failed save through Retry keeps it.
  control.failures = 1;
  shadow.querySelector('[data-key="settings:retry"]').click();
  await tick();
  assert.deepEqual(data.get('settings'), {});
  assert.ok(shadow.querySelector('[data-key="reset-undo"]'), 'still offered after a failed Retry');
  shadow.querySelector('[data-key="reset:undo"]').click();
  await tick();
  assert.deepEqual(data.get('settings'), { 'ui.hiddenNote': true, 'ui.launcher': false });
  assert.equal(settings.get('ui.hiddenNote'), true);
  assert.equal(shadow.querySelector('[data-key="reset-undo"]'), null);
});

test('a change here or in another tab ends the Undo, and the notice says so', async () => {
  for (const change of ['local', 'remote']) {
    const { storage, data, control } = laterStorage({ 'ui.hiddenNote': true });
    const { shadow, panel, settings } = setup({ storage });
    panel.open('general');
    shadow.querySelector('[data-key="reset"]').click();
    await tick();
    assert.ok(shadow.querySelector('[data-key="reset-undo"]'), change);
    if (change === 'local') settings.set('ui.launcher', false);
    else control.remote({ 'ui.launcher': false });
    await tick();
    assert.equal(shadow.querySelector('[data-key="reset-undo"]'), null, change);
    button(shadow, 'Undo').click();
    await tick();
    assert.deepEqual(data.get('settings'), { 'ui.launcher': false }, `${change} change is kept`);
    assert.equal(settings.get('ui.hiddenNote'), false, change);
    assert.ok([...shadow.querySelectorAll('.toast span')].some((span) => /isn't available any more/.test(span.textContent)), change);
  }
});

test('the Undo belongs to the account that reset, and Dismiss ends it', async () => {
  let account = 'A';
  const { shadow, panel, settings } = setup({ environment: { accountMatches: () => account === 'A' } });
  settings.set('ui.hiddenNote', true);
  panel.open('general');
  shadow.querySelector('[data-key="reset"]').click();
  assert.ok(shadow.querySelector('[data-key="reset-undo"]'));
  account = 'B';
  panel.open('general');
  assert.equal(shadow.querySelector('[data-key="reset-undo"]'), null);
  account = 'A';
  button(shadow, 'Undo').click();
  await tick();
  assert.equal(settings.get('ui.hiddenNote'), false, 'seeing another account ends it for good');

  settings.set('ui.hiddenNote', true);
  shadow.querySelector('[data-key="reset"]').click();
  await tick();
  shadow.querySelector('[data-key="reset:dismiss"]').click();
  assert.equal(shadow.querySelector('[data-key="reset-undo"]'), null);
  assert.equal(shadow.activeElement, shadow.querySelector('[data-key="reset"]'));
  assert.equal(settings.get('ui.hiddenNote'), false);
});

test('resetting settings already at their defaults offers nothing to undo', async () => {
  const { shadow, panel } = setup();
  panel.open('general');
  shadow.querySelector('[data-key="reset"]').click();
  await tick();
  assert.equal(shadow.querySelector('.toast').textContent, 'Settings are back to their defaults.');
  assert.equal(shadow.querySelector('[data-key="reset-undo"]'), null);
});

test('an extension save shows pending state, keeps a rejected draft and commits it on retry', async () => {
  const data = new Map();
  const mutations = [];
  const storage = {
    kind: 'extension',
    get: (key, fallback) => (data.has(key) ? structuredClone(data.get(key)) : fallback),
    set: (key, value) => void data.set(key, structuredClone(value)),
    remove: (key) => void data.delete(key),
    mutate(key, mutation) {
      let resolve;
      let reject;
      const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      mutations.push({
        mutation: structuredClone(mutation),
        accept() {
          const next = applyObjectMutation(data.get(key), mutation);
          data.set(key, structuredClone(next));
          resolve(structuredClone(next));
        },
        reject,
      });
      return promise;
    },
    onChange() {},
  };
  const { win, shadow, panel, settings } = setup({ storage, migrations: [] });
  panel.open('general');
  const input = shadow.querySelector('[data-key="ui.hiddenNote"]');
  input.checked = true;
  input.dispatchEvent(new win.Event('change'));

  assert.equal(settings.get('ui.hiddenNote'), false);
  assert.equal(shadow.querySelector('[data-key="ui.hiddenNote"]').checked, true);
  assert.equal(shadow.querySelector('[data-key="save-state"]').textContent, 'Saving changes...');
  mutations[0].reject(new Error('Extension context disconnected'));
  await tick();

  assert.equal(settings.get('ui.hiddenNote'), false);
  assert.equal(shadow.querySelector('[data-key="ui.hiddenNote"]').checked, true);
  assert.ok(shadow.querySelector('[data-key="save-recovery"]'));
  shadow.querySelector('[data-key="settings:retry"]').click();
  assert.equal(shadow.querySelector('[data-key="save-state"]').textContent, 'Saving changes...');
  mutations[1].accept();
  await tick();

  assert.equal(settings.get('ui.hiddenNote'), true);
  assert.equal(shadow.querySelector('[data-key="save-recovery"]'), null);
  assert.equal(shadow.querySelector('[data-key="save-state"]').textContent, 'Changes apply as you go.');
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

test('search finds settings by their words, changes toggles in place, and clears back to the sections', () => {
  const features = [
    { id: 'quiet', section: 'feed', android: 'Quiet', title: 'Hide sponsored posts', description: 'Ads leave the feed.', default: false },
    { id: 'speedy', section: 'playback', android: 'Speedy', title: 'Keep your video speed', description: 'The speed you pick stays.', default: false,
      options: [{ key: 'step', type: 'select', label: 'Speed step', default: 1, choices: [{ value: 1, label: 'Quarter steps' }] }] },
  ];
  const { shadow, panel, win, settings } = setup({ features });
  panel.open('feed');
  const search = shadow.querySelector('[data-key="search"]');
  const type = (text) => {
    search.value = text;
    search.dispatchEvent(new win.Event('input', { bubbles: true }));
  };
  type('quarter');
  assert.equal(shadow.querySelector('#hfw-section-title').textContent, 'Search');
  assert.deepEqual([...shadow.querySelectorAll('.result .title')].map((node) => node.textContent), ['Keep your video speed'], 'choice names count');
  assert.ok(shadow.querySelector('.result [data-key="speedy.step"]'), 'the matching option works from the results while its parent is off');
  assert.equal(shadow.querySelector('nav [aria-current="page"]'), null, 'no section is current while searching');
  const resultToggle = shadow.querySelector('.result [data-key="speedy"]');
  resultToggle.checked = true;
  resultToggle.dispatchEvent(new win.Event('change', { bubbles: true }));
  assert.equal(settings.get('speedy'), true, 'the result switch changes the saved setting');
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

test('search covers every kind of General row', () => {
  const { shadow, panel, win, settings } = setup();
  panel.open('general');
  const search = shadow.querySelector('[data-key="search"]');
  const find = (query) => {
    search.value = query;
    search.dispatchEvent(new win.Event('input', { bubbles: true }));
  };
  find('settings button');
  const toggle = shadow.querySelector('.result [data-key="ui.launcher"]');
  toggle.checked = false;
  toggle.dispatchEvent(new win.Event('change', { bubbles: true }));
  assert.equal(settings.get('ui.launcher'), false);
  for (const [query, key] of [
    ['privacy defaults', 'quick-setups'],
    ['back up restore', 'backup-restore'],
    ['report problem', 'report-problem'],
    ['bug', 'report-problem'],
    ['coffee kofi', 'kofi'],
    ['donate', 'kofi'],
  ]) {
    find(query);
    assert.ok(shadow.querySelector(`.result [data-key="${key}"]`), query);
  }
});

test("General's switches and backup actions come up by their own words, and the link focuses the control named", () => {
  const { shadow, panel, win } = setup();
  panel.open('feed');
  const search = shadow.querySelector('[data-key="search"]');
  const find = (query) => {
    search.value = query;
    search.dispatchEvent(new win.Event('input', { bubbles: true }));
  };
  for (const [query, row, focused] of [
    ['Leave a note', 'ui.hiddenNote', 'ui.hiddenNote'],
    ['Backup', 'backup-restore', 'backup'],
    ['export', 'backup-restore', 'backup'],
    ['Restore', 'backup-restore', 'restore'],
    ['restore from a file', 'backup-restore', 'restore'],
    ['Reset', 'backup-restore', 'reset'],
    ['Reset', 'quick-setups', 'quick:defaults'],
    ['back up restore', 'backup-restore', 'backup'],
  ]) {
    find(query);
    const link = shadow.querySelector(`[data-key="show:${row}"]`);
    assert.ok(link, `${query} finds ${row}`);
    link.click();
    assert.equal(shadow.querySelector('#hfw-section-title').textContent, 'General', query);
    assert.equal(shadow.activeElement?.dataset.key, focused, `${query} lands on ${focused}`);
    assert.equal(search.value, '', query);
  }
  find('injection mode');
  assert.match(shadow.querySelector('main .empty').textContent, /No setting matches/, "Diagnostics' own text stays out of search");
});

// What src/core/extension.js updateStatus gives General.
const CHECKED = Date.UTC(2026, 9, 17, 15, 4);
const checkStatus = (fields = {}) => ({ state: 'current', update: null, checking: false, checkedAt: CHECKED, triedAt: CHECKED, nextAt: CHECKED + 86400000, ...fields });
const generalKeys = (shadow) => [...shadow.querySelectorAll('main .settings-group > *')].map((card) => card.dataset.key ?? card.querySelector('[data-key]')?.dataset.key);

test("the extension's update notice heads General while a newer release is out, and links to it", () => {
  const url = 'https://github.com/SysAdminDoc/HushFacebookWeb/releases/tag/v0.0.9';
  let status = checkStatus({ state: 'newer', update: { version: '0.0.9', url } });
  const { shadow, panel, win } = setup({ update: () => status, environment: { checkForUpdate: async () => ({ asked: true }) } });
  panel.open('general');
  const card = shadow.querySelector('[data-key="update"]');
  assert.ok(card, 'the card shows');
  assert.equal(generalKeys(shadow)[0], 'update', 'first in General');
  assert.equal(card.querySelector('.title').textContent, 'HushFacebook Web 0.0.9 is out');
  assert.match(card.querySelector('.desc').textContent, /^You have 0\.0\.1\. /);
  assert.match(card.querySelector('[data-key="update:status"]').textContent, /^Checked .*2026/);
  const link = card.querySelector('a.button');
  assert.equal(link.getAttribute('href'), url);
  assert.equal(link.getAttribute('target'), '_blank');
  assert.ok(card.querySelector('button[data-key="update:check"]'), 'Check now sits next to it');
  const search = shadow.querySelector('[data-key="search"]');
  search.value = 'new extension release';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.ok(shadow.querySelector('.result [data-key="update"]'), 'the visible update row is searchable');
  search.value = '';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  status = checkStatus();
  panel.refresh();
  const plain = shadow.querySelector('[data-key="update"]');
  assert.equal(plain.querySelector('.title').textContent, 'Updates', 'once nothing is newer it says how the check went');
  assert.equal(plain.querySelector('a'), null);
  assert.notEqual(generalKeys(shadow)[0], 'update', 'and moves down General');
});

test('General says how a failed check went, never that you have the newest release, and only a check that worked says so', () => {
  let status = checkStatus({ state: 'offline', checkedAt: null });
  const { shadow, panel } = setup({ update: () => status });
  panel.open('general');
  const line = () => shadow.querySelector('[data-key="update:status"]').textContent;
  const shows = (fields, pattern) => {
    status = checkStatus(fields);
    panel.refresh();
    assert.match(line(), pattern, JSON.stringify(fields));
    if (fields.state !== 'current') assert.doesNotMatch(line(), /newest/, JSON.stringify(fields));
  };
  shows({ state: 'offline', checkedAt: null }, /^The check on .+ couldn't reach GitHub\. No check has worked yet\. It tries again on its own\.$/);
  shows({ state: 'offline', triedAt: null }, /^The last check couldn't reach GitHub\. The last one that worked was .+\. It tries again on its own\.$/);
  shows({ state: 'failed' }, /^GitHub's answer to the check on .+ didn't make sense\. The last one that worked was .+\. It tries again on its own\.$/);
  shows({ state: 'rate-limited' }, /^GitHub asked for a pause, so the next check waits until .+\. The last one that worked was .+\.$/);
  shows({ state: 'rate-limited', nextAt: null, checkedAt: null }, /^GitHub asked for a pause before the next check\. No check has worked yet\.$/);
  shows({ state: 'waiting', checkedAt: null, triedAt: null }, /^No check has finished for this version yet\. It checks GitHub once a day\.$/);
  shows({ state: 'offline', checking: true }, /^Checking GitHub now\.$/);
  shows({ state: 'current' }, /^You have the newest release\. Checked .+\.$/);
  assert.equal(shadow.querySelector('[data-key="update:check"]'), null, 'no Check now without the extension to ask');
});

test('Check now asks the extension and says why when it was too soon or GitHub asked for a pause', async () => {
  const answers = [];
  let answer = { asked: true, nextAt: null };
  let status = checkStatus();
  const { shadow, panel, win } = setup({
    update: () => status,
    environment: { checkForUpdate: () => new Promise((resolve) => answers.push(() => resolve(answer))) },
  });
  panel.open('general');
  const button = () => shadow.querySelector('[data-key="update:check"]');
  const search = shadow.querySelector('[data-key="search"]');
  search.value = 'check now';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.ok(shadow.querySelector('.result [data-key="update:check"]'), 'search finds it');
  search.value = '';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));

  button().click();
  assert.equal(button().textContent, 'Checking...');
  assert.equal(button().getAttribute('aria-busy'), 'true');
  button().click();
  assert.equal(answers.length, 1, 'a second click while it runs asks nothing');
  answers.shift()();
  await tick();
  assert.equal(button().textContent, 'Check now');
  assert.equal(shadow.querySelector('.toast'), null, 'a check that ran speaks through the card');

  answer = { asked: false, nextAt: null };
  button().click();
  answers.shift()();
  await tick();
  assert.equal(shadow.querySelector('.toast:last-child span').textContent, 'It checked a moment ago. Try again in a couple of minutes.');

  status = checkStatus({ state: 'rate-limited', nextAt: Date.now() + 3600000 });
  panel.refresh();
  button().click();
  answers.shift()();
  await tick();
  assert.match(shadow.querySelector('.toast:last-child span').textContent, /^GitHub asked for a pause\. The next check is after .+\.$/);
});

test('without an update source General has no notice', () => {
  const { shadow, panel } = setup();
  panel.open('general');
  assert.ok(!shadow.querySelector('[data-key="update"]'));
  assert.ok(!shadow.querySelector('main, .main')?.textContent.includes('null'), 'no stray text');
});

test('General offers to add or delete the activity from before accounts were kept apart, and never does either alone', async () => {
  const now = Date.now();
  const storage = createMemoryStorage({
    seenPosts: { 't:1': now - 1000, 't:2': now - 2000 },
    'resumeVideos.positions': { 2234567890: { t: 60, d: 900, at: now } },
    'keepSpeed.rate': 1.5,
  });
  let account = '615000000000051';
  const activity = createActivityStorage({ storage, account, currentAccount: () => account, log: { warn() {}, error() {} } });
  const { shadow, panel } = setup({ environment: { activity } });
  panel.open('general');
  const card = () => shadow.querySelector('[data-key="legacy-activity"]');
  assert.equal(card().querySelector('.desc').textContent, "This browser still has 2 seen posts, 1 video spot and a kept video speed from before each Facebook account kept its own. They aren't tied to any account. Add them to the account you're signed in to, or delete them.");
  for (const key of ['seenPosts', 'resumeVideos.positions', 'keepSpeed.rate']) {
    assert.equal(storage.get(activityKeyFor(key, account)), undefined, 'showing it adds nothing');
  }

  card().querySelector('[data-key="legacy:add"]').click();
  await tick();
  assert.deepEqual(Object.keys(storage.get(activityKeyFor('seenPosts', account))).sort(), ['t:1', 't:2']);
  assert.equal(storage.get(activityKeyFor('keepSpeed.rate', account)), 1.5);
  assert.ok(storage.get('seenPosts'), 'the shared copy stays');
  assert.ok([...shadow.querySelectorAll('.toast span')].some((span) => span.textContent === "Added to the account you're signed in to. The shared copy stays until you delete it."));
  assert.ok(card(), 'still offered, since the shared copy is there');

  card().querySelector('[data-key="legacy:delete"]').click();
  await tick();
  assert.equal(storage.get('seenPosts'), undefined);
  assert.equal(storage.get('keepSpeed.rate'), undefined);
  assert.equal(card(), null, 'nothing left to offer');
  assert.equal(storage.get(activityKeyFor('keepSpeed.rate', account)), 1.5, "the account's own copy stays");
  [...shadow.querySelectorAll('.toast button')].find((button) => button.textContent === 'Undo').click();
  await tick();
  assert.deepEqual(Object.keys(storage.get('seenPosts')).sort(), ['t:1', 't:2']);
  assert.equal(storage.get('keepSpeed.rate'), 1.5);
  assert.ok(card(), 'back after Undo');

  // Once the page is someone else's (another tab signed in, nothing here noticed yet), the card
  // goes rather than adding to either account.
  account = '615000000000052';
  assert.equal(activity.switched(), false);
  panel.refresh();
  assert.equal(card(), null);
});

test('signed out, the activity card keeps it for signed-out browsing', () => {
  const storage = createMemoryStorage({ 'keepVolume.state': { volume: 0.5, muted: false } });
  const activity = createActivityStorage({ storage, account: null, log: { warn() {}, error() {} } });
  const { shadow, panel } = setup({ environment: { activity } });
  panel.open('general');
  const card = shadow.querySelector('[data-key="legacy-activity"]');
  assert.match(card.querySelector('.desc').textContent, /still has a kept volume from before .* Add them to signed-out browsing, or delete them\.$/);
  assert.equal(card.querySelector('[data-key="legacy:add"]').textContent, 'Use while signed out');
});

test('General keeps a failed extension storage load visible and offers retry', async () => {
  let state = 'error';
  const listeners = new Set();
  const storage = {
    status: () => ({ state, error: state === 'error' ? new Error('bridge unavailable') : null }),
    onStatus(listener) {
      listeners.add(listener);
      listener(this.status());
    },
    async retry() {
      state = 'loading';
      for (const listener of listeners) listener(this.status());
      state = 'ready';
      for (const listener of listeners) listener(this.status());
      return true;
    },
  };
  const { shadow, panel } = setup({ environment: { storage } });
  panel.open('general');
  const card = shadow.querySelector('[data-key="storage-recovery"]');
  assert.match(card.textContent, /saved settings aren't available/i);
  assert.match(card.textContent, /privacy choices aren't confirmed/i);
  card.querySelector('button').click();
  await tick();
  assert.equal(shadow.querySelector('[data-key="storage-recovery"]'), null);
  assert.match(shadow.querySelector('.toast').textContent, /saved settings loaded/i);
});

test('A notice can carry several buttons, and one marked keep leaves it up', async () => {
  const { shadow, panel } = setup();
  const ran = [];
  panel.toast('Stuck', { actions: [{ label: 'Pause for this tab', run: () => ran.push('pause') }, { label: 'Copy report', run: () => ran.push('copy'), keep: true }] });
  const notice = shadow.querySelector('.toast:last-child');
  assert.deepEqual([...notice.querySelectorAll('button')].map((entry) => entry.textContent), ['Pause for this tab', 'Copy report']);
  button(shadow, 'Copy report').click();
  assert.ok(notice.isConnected, 'a kept button leaves the notice up');
  button(shadow, 'Pause for this tab').click();
  assert.equal(notice.isConnected, false);
  assert.deepEqual(ran, ['copy', 'pause']);
});

test('copyReport is there for notices outside the panel', async () => {
  const { panel, copied } = setup();
  await panel.copyReport();
  assert.equal(copied.length, 1);
  assert.match(copied[0], /^HushFacebook Web 0.0.1/);
});

test('In a tab paused after a stuck feed, the power switch turns it back on with a reload', async () => {
  const resumed = [];
  const { shadow, panel, settings, win } = setup({ tabPaused: true, environment: { resumeTab: () => resumed.push(true) } });
  panel.open();
  const power = shadow.querySelector('[data-key="power"]');
  assert.equal(power.checked, false);
  assert.equal(shadow.querySelector('.power-state').textContent, 'Paused in this tab');
  power.checked = true;
  power.dispatchEvent(new win.Event('change'));
  assert.deepEqual(resumed, [true]);
  assert.equal(Object.hasOwn(settings.snapshot(), 'paused'), false, 'nothing about the tab is saved');
});

// Settings an update added (src/ui/new-dots.js). One storage holds both settings and the seen
// list, as boot.js gives the panel.
const DOT_FEED = { id: 'dotFeed', section: 'feed', title: 'Dot feed', description: 'A feed switch.', default: false, options: [{ key: 'words', type: 'text', default: '', label: 'Words' }], setup() {} };
const DOT_ON = { id: 'dotOn', section: 'feed', title: 'Dot on', description: 'A switch that starts on.', default: true, options: [{ key: 'quiet', type: 'toggle', default: false, label: 'Quietly' }, { key: 'size', type: 'number', default: 2, min: 1, max: 9, label: 'Size' }], setup() {} };
const DOT_SEARCH = { id: 'dotSearch', section: 'search', title: 'Dot search', description: 'A search switch.', default: false, setup() {} };
const dotsIn = (root) => [...root.querySelectorAll('.new-dot')].map((dot) => {
  const holder = dot.closest('[data-key], .title, label');
  return holder.dataset?.key ?? holder.textContent.replace(/New$/, '');
});

test('the first time settings open nothing has a dot, and every setting counts as seen from then on', async () => {
  const storage = createMemoryStorage();
  const { shadow, panel } = setup({ features: [DOT_FEED, DOT_SEARCH], storage, environment: { storage } });
  panel.open('feed');
  assert.deepEqual(dotsIn(shadow), []);
  assert.deepEqual(storage.get(SEEN_SETTINGS_KEY), ['dotFeed', 'dotFeed.words', 'dotSearch']);
  panel.close();
  await tick();
  panel.open('search');
  assert.deepEqual(dotsIn(shadow), []);
});

test('a setting an update added keeps its dot, and its section its own, until settings close after that section was shown', async () => {
  const storage = createMemoryStorage({ [SEEN_SETTINGS_KEY]: ['dotFeed', 'gone'] });
  const { shadow, panel } = setup({ features: [DOT_FEED, DOT_SEARCH], storage, environment: { storage } });
  panel.open('feed');
  // dotFeed is off, so its new option hides with it and the card carries the dot.
  assert.deepEqual(dotsIn(shadow), ['nav:feed', 'nav:search', 'Dot feed']);
  assert.equal(shadow.querySelector('.title .new-dot').textContent, 'New', 'a screen reader hears it');
  panel.close();
  await tick();
  assert.deepEqual(storage.get(SEEN_SETTINGS_KEY), ['dotFeed', 'gone', 'dotFeed.words'], 'only what was shown, and a removed setting stays');
  panel.open('feed');
  assert.deepEqual(dotsIn(shadow), ['nav:search'], 'Search was never shown');
  shadow.querySelector('[data-key="nav:search"]').click();
  assert.deepEqual(dotsIn(shadow), ['nav:search', 'Dot search'], 'dots stay while settings are open');
  panel.close();
  await tick();
  panel.open('search');
  assert.deepEqual(dotsIn(shadow), []);
});

test("a new option on a switch that's on has its own dot, and the card has one too", () => {
  const storage = createMemoryStorage({ [SEEN_SETTINGS_KEY]: ['dotOn', 'dotOn.size'] });
  const { shadow, panel } = setup({ features: [DOT_ON], storage, environment: { storage } });
  panel.open('feed');
  assert.deepEqual(dotsIn(shadow), ['nav:feed', 'Dot on', 'Quietly']);
  assert.equal(shadow.querySelectorAll('label:has([data-key="dotOn.size"]) .new-dot').length, 0, 'Size was there before');
});

test('opening settings again while they are open keeps what was already shown', async () => {
  const storage = createMemoryStorage({ [SEEN_SETTINGS_KEY]: ['dotFeed'] });
  const { shadow, panel } = setup({ features: [DOT_FEED, DOT_SEARCH], storage, environment: { storage } });
  panel.open('feed');
  panel.open('search');
  assert.deepEqual(dotsIn(shadow), ['nav:feed', 'nav:search', 'Dot search']);
  panel.close();
  await tick();
  assert.deepEqual(storage.get(SEEN_SETTINGS_KEY), ['dotFeed', 'dotFeed.words', 'dotSearch']);
});

test('search results show no dots and searching counts as nothing shown', async () => {
  const storage = createMemoryStorage({ [SEEN_SETTINGS_KEY]: ['dotFeed.words'] });
  const { shadow, panel } = setup({ features: [DOT_FEED], storage, environment: { storage } });
  panel.open('feed', 'Dot');
  assert.equal(shadow.querySelectorAll('main .new-dot').length, 0);
  assert.deepEqual(dotsIn(shadow), ['nav:feed'], 'the section still says it has something new');
  panel.close();
  await tick();
  assert.deepEqual(storage.get(SEEN_SETTINGS_KEY), ['dotFeed.words']);
});

test("storage that hasn't loaded, or can't be read, shows no dots and saves nothing, and the list stays out of backups", async () => {
  const storage = createMemoryStorage({ [SEEN_SETTINGS_KEY]: ['dotFeed'] });
  let state = 'loading';
  storage.status = () => ({ state, error: null });
  const { shadow, panel, settings } = setup({ features: [DOT_FEED, DOT_SEARCH], storage, environment: { storage } });
  panel.open('feed');
  assert.deepEqual(dotsIn(shadow), []);
  panel.close();
  await tick();
  assert.deepEqual(storage.get(SEEN_SETTINGS_KEY), ['dotFeed']);
  state = 'ready';
  panel.open('feed');
  assert.deepEqual(dotsIn(shadow), ['nav:feed', 'nav:search', 'Dot feed'], 'once loaded, the next open has them');
  assert.equal(Object.hasOwn(JSON.parse(settings.exportJson()), SEEN_SETTINGS_KEY), false);
  assert.doesNotMatch(settings.exportJson(), /seenSettings|dotFeed\.words/);
  panel.close();
  await tick();

  const broken = createMemoryStorage();
  broken.get = (key, fallback) => {
    if (key === SEEN_SETTINGS_KEY) throw new Error('gone');
    return fallback;
  };
  const second = setup({ features: [DOT_FEED], storage: broken, environment: { storage: broken } });
  second.panel.open('feed');
  assert.deepEqual(dotsIn(second.shadow), []);
  assert.equal(second.shadow.querySelector('[data-key="dotFeed"]').checked, false, 'settings still draw');
});
