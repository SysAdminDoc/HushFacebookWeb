// The script's words in the chosen language: English as the key and fallback, and the two test
// layouts that stand in for languages that aren't here yet.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { english, language, LANGUAGES, plural, setLanguage, t } from '../src/core/i18n.js';

afterEach(() => setLanguage('en'));

const fold = (text) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '');

test('English fills in its words and leaves the phrase as written', () => {
  assert.equal(t('Changed {count} settings', { count: 3 }), 'Changed 3 settings');
  assert.equal(t('Saved {name}', {}), 'Saved {name}', 'a word with no value stays as it is');
  assert.equal(t('No words here'), 'No words here');
  assert.equal(t(''), '');
  assert.equal(t(undefined), undefined);
  assert.equal(plural(1, '{count} setting', '{count} settings'), '1 setting');
  assert.equal(plural(0, '{count} setting', '{count} settings'), '0 settings');
  assert.equal(plural(2, '{count} {thing}', '{count} {thing}s', { thing: 'spot' }), '2 spots');
});

test('an unknown language falls back to English, and the change is reported once', () => {
  assert.equal(setLanguage('long-test'), true);
  assert.equal(setLanguage('long-test'), false);
  assert.equal(language().value, 'long-test');
  assert.equal(setLanguage('klingon'), true);
  assert.equal(language().value, 'en');
  assert.equal(setLanguage(undefined), false);
});

test('every language keeps a value that never changes and a label in its own words', () => {
  const values = LANGUAGES.map((entry) => entry.value);
  assert.equal(new Set(values).size, values.length);
  assert.equal(values[0], 'en');
  for (const entry of LANGUAGES) {
    assert.ok(entry.label && entry.lang, entry.value);
    assert.ok(['ltr', 'rtl'].includes(entry.dir), entry.value);
    assert.ok(Object.isFrozen(entry), entry.value);
  }
  assert.ok(Object.isFrozen(LANGUAGES));
});

test('long text accents every letter, grows the phrase and keeps its words to fill', () => {
  setLanguage('long-test');
  const shown = t('Saving {name}', { name: 'photo.jpg' });
  assert.match(shown, /^\[.+\]$/, 'a cut-off phrase loses its ]');
  assert.ok(shown.includes('photo.jpg'), 'the filled-in word stays as it is');
  assert.doesNotMatch(shown.replace('photo.jpg', ''), /[a-pr-z]/i, 'every letter but q is accented');
  assert.ok(shown.length >= 'Saving photo.jpg'.length * 1.4);
  const long = 'Filter lines {lines} and {last} are skipped. Diagnostics says why.';
  const stretched = t(long);
  assert.ok(stretched.includes('{lines}') && stretched.includes('{last}'), 'placeholders survive the stretch');
  const literal = long.replace(/\{\w+\}/g, '').length;
  assert.ok(stretched.replace(/\{\w+\}/g, '').length - 2 >= literal * 1.4);
  assert.equal(english(long, { lines: '1, 2', last: 3 }), 'Filter lines 1, 2 and 3 are skipped. Diagnostics says why.');
  assert.match(plural(1, '{count} setting', '{count} settings'), /^\[1 \S+ /);
});

test('every accented letter is one character that folds back to its letter', () => {
  setLanguage('long-test');
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const shown = t(letters).slice(1, letters.length + 1);
  assert.equal([...shown].length, letters.length);
  assert.equal(fold(shown), letters);
});

test('right to left mirrors the panel and leaves the English readable', () => {
  setLanguage('rtl-test');
  assert.equal(language().dir, 'rtl');
  assert.equal(t('Changed {count} settings', { count: 2 }), 'Changed 2 settings');
});
