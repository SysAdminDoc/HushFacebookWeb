// Custom CSS goes last in the script's style, and CSS typed into Hide posts by words gets a
// warning once per list, ever.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import customCss from '../src/features/appearance/custom-css.js';
import amoledTheme from '../src/features/appearance/amoled.js';
import hidePostsByWords, { CSS_WARNING, plainLines } from '../src/features/feed/filters.js';
import { createMemoryStorage } from '../src/core/storage.js';
import { features } from '../src/features/index.js';
import { renderFeatureCss } from '../src/core/style.js';
import { looksLikeCss } from '../src/core/css-text.js';

test('CSS is told from a list of words', () => {
  for (const css of [
    'div[aria-label="Sponsored"] { display: none }',
    '[role="complementary"]{display:none!important}',
    'cats\ndisplay: none !important;\ndogs',
    '[role="banner"]:has(a[href="/gaming/"])',
    'a:not([href])',
  ]) assert.equal(looksLikeCss(css), true, css);
  for (const words of [
    '', 'cats', 'Pat Example\nexample.com', 're:\\bcats?\\b', '# note: these are for the garden group',
    'Note: buy milk;', 'Time: 10:30', 'giveaway!!! {limited}', 're:^(free|win) iphone$',
    // A colon on one line and a semicolon on the next aren't a declaration.
    'note:\nbuy milk;', 'crypto:\ngiveaway;', ' { a: b }',
  ]) assert.equal(looksLikeCss(words), false, JSON.stringify(words));
  // A rule's block may span lines, and a rule after an empty pair of braces still counts.
  assert.equal(looksLikeCss('div {\n  display: none;\n}'), true);
  assert.equal(looksLikeCss('cats {}\n[role="main"] {display:none}'), true);
  assert.equal(looksLikeCss('a:first-child'), true);
});

test('the CSS check reads a long list once instead of once per character', () => {
  const long = [
    'x'.repeat(200000), ' '.repeat(200000), '{}'.repeat(100000), `${'{'.repeat(100000)}}`,
    'a\n'.repeat(100000), `${'word '.repeat(40000)}:`, `${'ab-'.repeat(60000)}`,
  ];
  for (const text of long) {
    const started = performance.now();
    assert.equal(looksLikeCss(text), false);
    assert.ok(performance.now() - started < 150, `${text.slice(0, 6)}... took ${Math.round(performance.now() - started)} ms`);
  }
});

test('pattern and note lines are left out of the CSS check', () => {
  assert.equal(plainLines('cats\nre:not( ?sponsored)\nRE:is(n\'t| not) available\n# a note: here;\n#\ndogs'), 'cats\ndogs');
  for (const words of ['re:not( ?sponsored)', "re:is(n't| not) available", 're:crypto\ngiveaway;']) {
    const { toasts } = filterSetup({ on: true, words });
    assert.equal(toasts.length, 0, words);
  }
});

test('a list warned about once stays quiet on the next page load', () => {
  const storage = createMemoryStorage();
  const values = { on: true, words: 'a { color: red }' };
  assert.equal(filterSetup(values, storage).toasts.length, 1);
  assert.equal(filterSetup(values, storage).toasts.length, 0, 'same list after a reload');
  values.words = 'b { color: blue }';
  assert.equal(filterSetup(values, storage).toasts.length, 1, 'a different list');
});

test('Custom CSS comes after every built-in style, so it wins a tie', () => {
  assert.equal(features.at(-1), customCss, 'last in the list');
  const values = { amoledTheme: true, customCss: true, 'customCss.css': '.__fb-dark-mode { --web-wash: #101010 !important; }' };
  const settings = { get: (key) => values[key], enabled: (id) => values[id] === true };
  const css = renderFeatureCss(features, settings, null);
  assert.ok(css.indexOf('/* customCss */') > css.indexOf('/* amoledTheme */'));
  assert.ok(css.trimEnd().endsWith('.__fb-dark-mode { --web-wash: #101010 !important; }'));
  assert.ok(css.includes(amoledTheme.css()));
  values.customCss = false;
  assert.ok(!renderFeatureCss(features, settings, null).includes('#101010'));
});

test('an empty box adds nothing', () => {
  assert.equal(customCss.css(() => ''), '');
  assert.equal(customCss.css(() => undefined), '');
  assert.equal(customCss.options[0].code, true);
});

function filterSetup(values, storage = undefined) {
  const toasts = [];
  const warnings = [];
  const listeners = [];
  hidePostsByWords.setup({
    net: null, router: null, posts: null, hider: null, storage,
    log: { warn: (m) => warnings.push(m) },
    toast: (message, options) => toasts.push([message, options]),
    settings: { subscribe: (fn) => listeners.push(fn) },
    diagnostics: { add() {}, changed() {} },
    enabled: () => values.on,
    option: (key) => values[key],
  });
  const change = () => listeners.forEach((fn) => fn({ keys: ['hidePostsByWords.words'] }));
  return { toasts, warnings, change };
}

test('CSS in Hide posts by words gets one warning per list', () => {
  const values = { on: true, words: 'div[aria-label="Sponsored"] { display: none }' };
  const { toasts, warnings, change } = filterSetup(values);
  assert.deepEqual(toasts, [[CSS_WARNING, { tone: 'error' }]]);
  assert.equal(warnings.length, 1);
  change();
  assert.equal(toasts.length, 1, 'same list, no second warning');
  values.words = 'cats\ndogs';
  change();
  assert.equal(toasts.length, 1);
  values.words = 'display: none !important;';
  change();
  assert.equal(toasts.length, 2, 'a new list that looks like CSS');
});

test('no warning while the switch is off or the list is words', () => {
  const off = filterSetup({ on: false, words: 'a { color: red }' });
  assert.equal(off.toasts.length, 0);
  const words = filterSetup({ on: true, words: 'cats\nre:\\bdogs?\\b' });
  assert.equal(words.toasts.length, 0);
});
