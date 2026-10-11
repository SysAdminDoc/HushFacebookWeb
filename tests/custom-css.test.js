// Custom CSS goes last in the script's style, and CSS typed into Hide posts by words gets a
// warning once per list.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import customCss from '../src/features/appearance/custom-css.js';
import amoledTheme from '../src/features/appearance/amoled.js';
import hidePostsByWords, { CSS_WARNING } from '../src/features/feed/filters.js';
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
  ]) assert.equal(looksLikeCss(words), false, words);
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

function filterSetup(values) {
  const toasts = [];
  const warnings = [];
  const listeners = [];
  hidePostsByWords.setup({
    net: null, router: null, posts: null, hider: null,
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
