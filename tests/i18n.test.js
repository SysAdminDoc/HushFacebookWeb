// The script's words in the chosen language: English as the key and fallback, Russian, and the
// two test layouts that stand in for languages that aren't here yet.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { english, language, LANGUAGES, plural, pluralForm, setLanguage, t } from '../src/core/i18n.js';

afterEach(() => setLanguage('en'));

const catalog = (name) => JSON.parse(readFileSync(new URL(`../translations/${name}.json`, import.meta.url), 'utf8'));
const template = catalog('template');
const russian = catalog('ru');
const words = (text) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map(([, name]) => name))].sort();

test('Russian is offered right after English, under its own name', () => {
  const { value, label, lang, dir, test: isTest } = LANGUAGES[1];
  assert.deepEqual({ value, label, lang, dir, isTest }, { value: 'ru', label: 'Русский', lang: 'ru', dir: 'ltr', isTest: undefined });
  assert.deepEqual(LANGUAGES.map((entry) => entry.value), ['en', 'ru', 'long-test', 'rtl-test']);
});

test('the Russian catalog has every phrase the template has, in its order, and nothing else', () => {
  assert.deepEqual(Object.keys(russian), Object.keys(template));
});

test('every Russian phrase keeps its English placeholders, and a plural phrase has all four Russian forms', () => {
  for (const [key, source] of Object.entries(template)) {
    const shown = russian[key];
    if (typeof source === 'string') {
      assert.equal(typeof shown, 'string', key);
      assert.ok(shown.trim(), key);
      assert.deepEqual(words(shown), words(key), key);
      continue;
    }
    assert.deepEqual(Object.keys(shown).sort(), ['few', 'many', 'one', 'other'], key);
    for (const [form, text] of Object.entries(shown)) {
      assert.equal(typeof text, 'string', `${key} ${form}`);
      assert.deepEqual(words(text), words(form === 'one' ? source.one : source.other), `${key} ${form}`);
    }
  }
});

test('with Russian chosen, a phrase shows in Russian with its words filled in', () => {
  assert.equal(setLanguage('ru'), true);
  assert.deepEqual([language().lang, language().dir], ['ru', 'ltr']);
  assert.equal(t('Settings'), 'Настройки');
  assert.equal(t('Enter a number from {min} to {max}.', { min: 1, max: 10 }), 'Введите число от 1 до 10.');
  assert.equal(t('Hide posts by {name}', { name: 'Анна' }), 'Скрыть публикации автора Анна');
  assert.equal(t('A phrase no catalog has'), 'A phrase no catalog has', 'a phrase missing from the catalog shows in English');
  assert.equal(english('Saved {name}', { name: 'photo.jpg' }), 'Saved photo.jpg', 'search keeps the English');
});

test('Russian picks one, few or many by the count, and other for a fraction', () => {
  setLanguage('ru');
  const seen = (count) => plural(count, '{count} seen post', '{count} seen posts');
  assert.deepEqual([1, 2, 5, 11, 21, 22, 25, 101].map(seen), [
    '1 просмотренная публикация',
    '2 просмотренные публикации',
    '5 просмотренных публикаций',
    '11 просмотренных публикаций',
    '21 просмотренная публикация',
    '22 просмотренные публикации',
    '25 просмотренных публикаций',
    '101 просмотренная публикация',
  ]);
  assert.equal(seen(1.5), '1.5 просмотренной публикации');
  assert.equal(plural(3, 'Changed {count} setting.', 'Changed {count} settings.'), 'Изменены 3 настройки.');
  assert.equal(plural(2, '{count} thing', '{count} things'), '2 things', 'a plural phrase the catalog lacks stays English');
});

test('switching back from Russian shows English again', () => {
  setLanguage('ru');
  assert.equal(t('Settings'), 'Настройки');
  assert.equal(setLanguage('en'), true);
  assert.equal(t('Settings'), 'Settings');
  assert.equal(plural(2, '{count} seen post', '{count} seen posts'), '2 seen posts');
  assert.equal(plural(1, '{count} seen post', '{count} seen posts'), '1 seen post');
});

test('a translation picks its plural form by that language\'s own count rules', () => {
  const arabic = { zero: 'zero', one: 'one', two: 'two', few: 'few', many: 'many', other: 'other' };
  assert.deepEqual([0, 1, 2, 3, 11, 100].map((count) => pluralForm(arabic, count, 'ar')),
    ['zero', 'one', 'two', 'few', 'many', 'other']);
  assert.equal(pluralForm({ one: 'one', other: 'other' }, 1, 'en'), 'one');
  assert.equal(pluralForm({ one: 'one', other: 'other' }, 0, 'en'), 'other');
});

test('a translation missing a plural form falls back to its other form, and then to nothing', () => {
  assert.equal(pluralForm({ one: 'one', other: 'other' }, 3, 'ar'), 'other');
  assert.equal(pluralForm({ one: 'one' }, 3, 'ar'), null);
  assert.equal(pluralForm({ few: 7, other: 'other' }, 3, 'ar'), null, 'a form that is not text is not shown');
});

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
