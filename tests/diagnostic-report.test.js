import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDiagnostics, hideListener } from '../src/core/diagnostics.js';
import { createLog } from '../src/core/log.js';
import { createSettings } from '../src/core/settings.js';
import { createMemoryStorage } from '../src/core/storage.js';
import { browserOf, buildDiagnosticReport, scrubText } from '../src/ui/diagnostic-report.js';

const quiet = { info() {}, warn() {}, error() {} };
const demo = {
  id: 'demo',
  section: 'feed',
  title: 'Demo',
  default: false,
  options: [
    { key: 'words', type: 'text', default: '', label: 'Words' },
    { key: 'size', type: 'select', default: 'small', label: 'Size', choices: [{ value: 'small', label: 'Small' }, { value: 'large', label: 'Large' }] },
    { key: 'count', type: 'number', default: 3, min: 0, max: 10, label: 'Count' },
  ],
};

// Every way private text can reach Diagnostics, each with its own marker.
function seeded() {
  const log = createLog({ sink: quiet });
  const settings = createSettings({ storage: createMemoryStorage(), features: [demo], log });
  settings.set('demo', true);
  settings.set('demo.words', 'PRIVATE-SETTING cats');
  settings.set('demo.size', 'large');
  settings.set('demo.count', 5);
  const diagnostics = createDiagnostics();
  diagnostics.add('Count row', () => '7');
  diagnostics.add('Text row', () => 'PRIVATE-ROW 3');
  diagnostics.add('Fixed row', () => 'Loaded', { shareable: true });
  diagnostics.add('Id row', () => '100012345678901');
  diagnostics.add('Broken row', () => { throw new Error('PRIVATE-ROW-ERROR'); });
  diagnostics.add('Broken fixed row', () => { throw new Error('PRIVATE-FIXED-ROW-ERROR'); }, { shareable: true });
  diagnostics.add('Row for 100012345678901', () => '1');
  diagnostics.decide({ post: 'PRIVATE-POST-ID', rule: 'Filter', detail: 'PRIVATE-PHRASE', layer: 'page' });
  diagnostics.decide({ post: 'PRIVATE-POST-ID', rule: 'Sponsored', signal: 'header label', layer: 'data' });
  log.error("Couldn't save a photo or video", new Error('PRIVATE-ERROR https://www.facebook.com/PRIVATE-URL'));
  log.info('Open on a chosen tab: this visit starts on', '/PRIVATE-PATH/');
  log.warn('Facebook answered https://www.facebook.com/profile.php?id=PRIVATE-QUERY for 100012345678901 at someone@example.com');
  const input = {
    version: '0.0.4', manager: 'Tampermonkey', managerVersion: '5.4.1', mode: 'page', pageAccess: 'page',
    browser: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 PRIVATE-AGENT',
    settings, unavailable: new Map([['demo', 'failed']]), hidden: { Sponsored: 2 },
    rows: diagnostics.rows(), decisions: diagnostics.decisions(), log: log.entries(),
  };
  return { input, log, settings, diagnostics };
}

test('a copied report carries no private text from any input', () => {
  const report = buildDiagnosticReport(seeded().input);
  for (const marker of ['PRIVATE', 'cats', 'facebook.com', '100012345678901', 'example.com', 'Mozilla']) {
    assert.ok(!report.includes(marker), `${marker} stays out of the report`);
  }
});

test('a copied report keeps the facts a maintainer needs', () => {
  const lines = buildDiagnosticReport(seeded().input).split('\n');
  const has = (line) => assert.ok(lines.includes(line), `has "${line}"`);
  has('HushFacebook Web 0.0.4');
  has('Manager: Tampermonkey 5.4.1, mode page, page access page');
  has('Browser: Chrome 141 on Windows');
  has('Choices changed: demo.size=large, demo.count=5');
  has('Text settings filled in, text left out: demo.words');
  has('Unavailable: demo (failed)');
  has('Hidden since the page loaded: Sponsored 2');
  has('Count row: 7');
  has('Text row: left out');
  has('Fixed row: Loaded');
  has('Id row: left out');
  has('Broken row: left out');
  has('Broken fixed row: left out');
  has('Row for [number]: 1');
  assert.match(lines.find((line) => line.startsWith('Switches on:')), /\bdemo\b/);
  const decisions = lines.slice(lines.indexOf('Why posts were hidden, oldest first:') + 1, lines.indexOf('Log, details left out:') - 1);
  assert.equal(decisions.length, 2);
  assert.match(decisions[0], /^\d\d:\d\d:\d\d page #[0-9a-z]{6} Filter$/);
  assert.match(decisions[1], /^\d\d:\d\d:\d\d data #[0-9a-z]{6} Sponsored: header label$/);
  assert.equal(decisions[0].split(' ')[2], decisions[1].split(' ')[2], 'one post, one label within a report');
  const logged = lines.slice(lines.indexOf('Log, details left out:') + 1);
  assert.match(logged[0], /error Couldn't save a photo or video \[Error\]$/);
  assert.match(logged[1], /info Open on a chosen tab: this visit starts on \[string\]$/);
  assert.match(logged[2], /warn Facebook answered \[link\] for \[number\] at \[email\]$/);
});

test('the same post gets a different label in each copied report', () => {
  const { input } = seeded();
  const labelOf = (report) => report.split('\n').find((line) => line.endsWith('Sponsored: header label')).split(' ')[2];
  const first = labelOf(buildDiagnosticReport(input));
  const second = labelOf(buildDiagnosticReport(input));
  assert.notEqual(first, second);
  assert.equal(labelOf(buildDiagnosticReport({ ...input, salt: 'a' })), labelOf(buildDiagnosticReport({ ...input, salt: 'a' })), 'the label comes from the salt');
});

test('a page without crypto still gets fresh labels', () => {
  const { input } = seeded();
  const labelOf = (report) => report.split('\n').find((line) => line.endsWith('Sponsored: header label')).split(' ')[2];
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  try {
    assert.notEqual(labelOf(buildDiagnosticReport(input)), labelOf(buildDiagnosticReport(input)));
  } finally {
    Object.defineProperty(globalThis, 'crypto', saved);
  }
});

test('the panel keeps the details the report leaves out', () => {
  const { log, diagnostics } = seeded();
  assert.equal(diagnostics.decisions()[0].detail, 'PRIVATE-PHRASE');
  assert.match(log.entries()[0].detail, /PRIVATE-ERROR/);
  assert.equal(log.entries()[0].code, 'Error');
});

test("a setting refused for its value doesn't repeat the value", () => {
  const { settings } = seeded();
  assert.throws(() => settings.set('demo.count', 'PRIVATE-VALUE'), (error) => error instanceof TypeError && error.message === 'Invalid value for demo.count');
  assert.throws(() => settings.setMany({ 'demo.size': 'PRIVATE-VALUE' }), (error) => error instanceof TypeError && error.message === 'Invalid value for demo.size');
});

test('a hidden post noted on the page keeps its signal and its detail apart', () => {
  const diagnostics = createDiagnostics();
  const onHide = hideListener(diagnostics, () => ({ id: 'p1' }));
  onHide({ element: {}, reason: 'Filter', detail: 'PRIVATE-PHRASE' });
  onHide({ element: {}, reason: 'Sponsored', signal: 'header label' });
  const [filter, ad] = diagnostics.decisions();
  assert.deepEqual([filter.signal, filter.detail, filter.layer], ['', 'PRIVATE-PHRASE', 'page']);
  assert.deepEqual([ad.signal, ad.detail], ['header label', '']);
});

test('the browser line names the browser, its main version and the system', () => {
  assert.equal(browserOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'), 'Edge 141 on Windows');
  assert.equal(browserOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0'), 'Firefox 140 on macOS');
  assert.equal(browserOf('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'), 'Chrome 141 on Linux');
  assert.equal(browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari 18 on iOS');
  assert.equal(browserOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0'), 'Edge 141 on Android');
  assert.equal(browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1'), 'Chrome 141 on iOS');
  assert.equal(browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15'), 'Firefox 140 on iOS');
  assert.equal(browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/141.0.3537.71 Mobile/15E148 Safari/605.1.15'), 'Edge 141 on iOS');
  assert.equal(browserOf('something else'), 'Unknown browser');
});

test('scrubbing takes out addresses, ids and emails', () => {
  assert.equal(scrubText('see https://example.org/a?b=1 and www.facebook.com/x and m.facebook.com'), 'see [link] and [link] and [link]');
  assert.equal(scrubText('short fb.me/abc, fb.watch/xyz and m.me/someone'), 'short [link] [link] and [link]');
  assert.equal(scrubText('post pfbid02abcDEF and 12345 but not 1234'), 'post [id] and [number] but not 1234');
  assert.equal(scrubText('mail me@host.example now'), 'mail [email] now');
  assert.equal(scrubText('x'.repeat(400)).length, 300);
});

// Copy report keeps log messages, so they have to be the script's own words. Anything else a
// message would carry goes in the detail. These are the values each file's messages may name,
// checked by hand: ids and titles the script defines, counts, and parameters its callers only
// ever fill with fixed text.
const SAFE = {
  'core/activity.js': ['ACCOUNT_CHANGED'],
  'core/dom/posts.js': ['type'],
  'core/load-watchdog.js': ['where', 'seconds'],
  'core/modules.js': ['name'],
  'core/net/hooks.js': ['rule.id'],
  'core/net/websocket.js': ['rule.id'],
  'core/seen-store.js': ['what'],
  'core/settings.js': ['message', "copyAll ? 'Could not copy your settings to this account' : 'Could not save a settings update'"],
  'core/style.js': ['part.id', 'feature.title'],
  'core/tasks.js': ['task.id', 'result.cause ? STORAGE_FAILED : result.message'],
  'features/comments/comment-order.js': ['order.english'],
  'features/downloads/button.js': ['failText'],
  'features/feed/filters.js': ['CSS_WARNING', 'error.line', 'error.reason', 'error.list'],
  'features/feed/hide-sponsored-posts.js': ['signal', "corroborated ? ', with an ad button' : ''", 'unreadCount'],
  'features/games/sdk.js': ['message'],
  'core/start-features.js': ['feature.title'],
  'main.js': ['UNKEPT_SETTINGS', 'otherVersion', 'version', 'pageAccess'],
  'ui/panel.js': ['label', `error instanceof TypeError ? error.message : "Couldn't restore settings. Choose a valid backup and try again"`],
};

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

// i at an opening quote, returns the index of the closing one.
function stringEnd(text, i) {
  const quote = text[i];
  for (i++; i < text.length && text[i] !== quote; i++) if (text[i] === '\\') i++;
  return i;
}
function templateEnd(text, i) {
  for (i++; i < text.length && text[i] !== '`'; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '$' && text[i + 1] === '{') i = codeEnd(text, i + 2, '}');
  }
  return i;
}
// Where the code from i stops at one of stops outside any bracket, string or template, so a
// comma inside a nested template doesn't end the argument.
function codeEnd(text, i, stops) {
  let depth = 0;
  for (; i < text.length; i++) {
    const char = text[i];
    if (depth === 0 && stops.includes(char)) return i;
    if (char === '"' || char === "'") i = stringEnd(text, i);
    else if (char === '`') i = templateEnd(text, i);
    else if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) depth--;
  }
  return i;
}
function interpolations(template) {
  const found = [];
  for (let i = 1; i < template.length - 1; i++) {
    if (template[i] === '\\') i++;
    else if (template[i] === '$' && template[i + 1] === '{') {
      const end = codeEnd(template, i + 2, '}');
      found.push(template.slice(i + 2, end).trim());
      i = end;
    }
  }
  return found;
}

// What a source's log messages name beyond fixed text, past what allowed lets through.
function messageValues(text, allowed = []) {
  const values = [];
  let calls = 0;
  for (const match of text.matchAll(/\blog\s*\??\.\s*(?:debug|info|warn|error)\s*(?:\?\.)?\(/g)) {
    calls++;
    const start = match.index + match[0].length;
    const message = text.slice(start, codeEnd(text, start, ',)')).trim();
    if (/^['"]/.test(message) && stringEnd(message, 0) === message.length - 1) continue;
    const template = message.startsWith('`') && templateEnd(message, 0) === message.length - 1;
    for (const value of template ? interpolations(message) : [message]) if (!allowed.includes(value)) values.push(value);
  }
  return { calls, values };
}

test('the log message scan catches what a message could carry', () => {
  const sample = [
    "log?.warn?.('Saved ' + name);",
    'log.error(`Saw ${a ? `x ${b}` : c}, then`, error);',
    'log\n  .info(\n    `at ${path}`,\n  );',
    "log.warn('fixed, with a comma', error);",
  ].join('\n');
  assert.deepEqual(messageValues(sample).values, ["'Saved ' + name", 'a ? `x ${b}` : c', 'path']);
  assert.equal(messageValues(sample).calls, 4);
  assert.deepEqual(messageValues('log.info(`at ${path}`);').values, ['path']);
});

test('log messages name only values the script owns', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const unexpected = [];
  let seen = 0;
  for (const file of sources(root)) {
    const name = relative(root, file).split(sep).join('/');
    const { calls, values } = messageValues(readFileSync(file, 'utf8'), SAFE[name]);
    seen += calls;
    for (const value of values) unexpected.push(`${name}: ${value}`);
  }
  assert.ok(seen > 80, 'the scan finds the log calls');
  assert.deepEqual(unexpected, [], 'put page text, file names and settings text in the detail, not the message');
});
