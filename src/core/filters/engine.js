// Word filters. One phrase per line. A plain phrase matches whole words and ignores case, so
// "cat" hides "Cat pics" but not "concatenate". "re:" turns the rest of the line into a
// regular expression, which also ignores case. Blank lines and lines starting with "# " (a
// hash and a space) are skipped, so "#news" is still a hashtag to hide. No rule keeps state
// between tests (no g or y flag), so a post always gets the same answer however often it's
// checked.

import { normalizeText } from '../dom/visible-text.js';

const WORD = '[\\p{L}\\p{N}_]';
const SPECIAL = /[.*+?^${}()|[\]\\]/g;

function regexFor(source) {
  try {
    return new RegExp(source, 'iu');
  } catch {
    // Some older patterns are only valid without the u flag ("\-" outside a class, say).
    return new RegExp(source, 'i');
  }
}

function phraseRegex(phrase) {
  const body = phrase.split(' ').map((word) => word.replace(SPECIAL, '\\$&')).join('\\s+');
  return new RegExp(`(?<!${WORD})${body}(?!${WORD})`, 'iu');
}

// { rules: [{ phrase, re }], errors: [{ line, phrase, message }] }
export function compileFilters(text) {
  const rules = [];
  const errors = [];
  String(text ?? '').split(/\r?\n/).forEach((raw, index) => {
    const line = normalizeText(raw);
    if (!line || line === '#' || line.startsWith('# ')) return;
    if (/^re:/i.test(line)) {
      const source = line.slice(3).trim();
      if (!source) return;
      try {
        rules.push({ phrase: line, re: regexFor(source) });
      } catch (error) {
        errors.push({ line: index + 1, phrase: line, message: error.message });
      }
      return;
    }
    rules.push({ phrase: line, re: phraseRegex(line) });
  });
  return { rules, errors };
}

// The first rule that matches any of the values, or null. Values are normalized the same
// way phrases are, so zero-width marks and odd spaces don't hide a match.
export function firstMatch(rules, values) {
  if (!rules.length) return null;
  const clean = values.filter(Boolean).map(normalizeText);
  for (const rule of rules) {
    for (const value of clean) if (rule.re.test(value)) return rule;
  }
  return null;
}

// Compiles once per distinct text, since the setting rarely changes but posts arrive often.
export function filterCache() {
  let text = null;
  let compiled = { rules: [], errors: [] };
  return (next) => {
    if (next !== text) {
      text = next;
      compiled = compileFilters(next);
    }
    return compiled;
  };
}
