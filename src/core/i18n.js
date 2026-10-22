// The words the script shows people, in the language chosen under General. The English is
// written where it's used, and it is both the lookup key and the fallback, so a phrase a
// catalog doesn't have yet (or has for older wording) shows in English. Every catalog ships
// inside the script: nothing is fetched and nothing goes to a translation service. Facebook's
// own language doesn't change this one.
//
//   t('Changed {count} settings', { count })   one phrase, with {name} filled in from vars
//   plural(count, '{count} setting', '{count} settings')
//
// The log, the hide decisions and Copy report stay in English, so a report reads the same for
// whoever it's sent to.
//
// Keep a select's choice labels short. A closed select can't wrap, and at 360 px it shows about
// 30 characters before the ellipsis (the open list shows the whole label).
//
// Two test layouts stand in for languages that aren't here yet. Long text accents every letter
// and makes each phrase 40% longer (twice as long when it's short) inside [ ], so a phrase cut
// off loses its ] and one that never went through t() stays plain. Right to left mirrors the
// panel with the English left as it is.

// Each letter's accented form folds back to the letter in search (NFKD, then the marks dropped).
const PLAIN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ACCENTED = 'áḃçḋéḟĝĥîĵḱĺḿñöṕqŕšţûṽŵẍýžÁḂÇḊÉḞĜĤÎĴḰĹḾÑÖṔQŔŠŢÛṼŴẌÝŽ';
const ACCENTS = new Map([...PLAIN].map((letter, index) => [letter, [...ACCENTED].at(index)]));
const PADDING = 'one two three four five six seven eight nine ten'.split(' ');
const PLACEHOLDER = /\{(\w+)\}/g;

const accent = (text) => [...text].map((letter) => ACCENTS.get(letter) ?? letter).join('');

function stretch(template) {
  const parts = template.split(/(\{\w+\})/);
  const length = parts.filter((part, index) => index % 2 === 0).join('').length;
  if (!length) return template;
  const wanted = length <= 10 ? length : Math.ceil(length * 0.4);
  const words = [];
  for (let i = 0; words.join(' ').length < wanted; i++) words.push(PADDING[i % PADDING.length]);
  return `[${parts.map((part, index) => (index % 2 === 0 ? accent(part) : part)).join('')} ${accent(words.join(' '))}]`;
}

// value is what Settings keeps (and a backup holds), so it never changes once shipped. label
// is the language's own name for itself, never translated, so it can always be found again.
export const LANGUAGES = Object.freeze([
  Object.freeze({ value: 'en', label: 'English', lang: 'en', dir: 'ltr' }),
  Object.freeze({ value: 'long-test', label: 'Test: long text', lang: 'en', dir: 'ltr', test: true, transform: stretch }),
  Object.freeze({ value: 'rtl-test', label: 'Test: right to left', lang: 'en', dir: 'rtl', test: true }),
]);

// A reviewed translation goes here as value: { 'English phrase': 'translation' }, with a plural
// phrase keyed by its English plural form: { '{count} settings': { one: '...', other: '...' } }.
// A translator starts from translations/template.json, which npm run phrases writes.
const CATALOGS = {};

let active = LANGUAGES[0];

export const language = () => active;

// Returns true when the language changed.
export function setLanguage(value) {
  const next = LANGUAGES.find((entry) => entry.value === value) ?? LANGUAGES[0];
  if (next === active) return false;
  active = next;
  return true;
}

function fill(template, vars) {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (match, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : match));
}

// The phrase as English shows it, whatever the language: search keeps these as aliases.
export const english = (template, vars) => fill(template, vars);

export function t(template, vars) {
  if (typeof template !== 'string' || template === '') return template;
  if (active.transform) return fill(active.transform(template), vars);
  const translated = CATALOGS[active.value]?.[template];
  return fill(typeof translated === 'string' ? translated : template, vars);
}

export function plural(count, one, other, vars) {
  const forms = CATALOGS[active.value]?.[other];
  const all = { count, ...vars };
  if (forms && typeof forms === 'object' && !active.transform) {
    const form = forms[new Intl.PluralRules(active.lang).select(count)] ?? forms.other;
    if (typeof form === 'string') return fill(form, all);
  }
  return t(count === 1 ? one : other, all);
}
