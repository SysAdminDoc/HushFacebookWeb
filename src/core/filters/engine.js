// Word filters. One phrase per line. A plain phrase matches whole words and ignores case, so
// "cat" hides "Cat pics" but not "concatenate". "re:" turns the rest of the line into a
// regular expression, which also ignores case. Blank lines and lines starting with "# " (a
// hash and a space) are skipped, so "#news" is still a hashtag to hide. No rule keeps state
// between tests (no g or y flag), so a post always gets the same answer however often it's
// checked.
//
// re: lines run on RE2JS, which matches in time linear in the text, so a pattern like
// "(a+)+$" can't freeze the page on a long post the way the browser's backtracking RegExp
// would. RE2 has no look-ahead or back-references. A line that uses them is skipped with a
// reason naming what to change, and stays in the list as written. Plain phrases are built
// here from escaped words and keep the browser's RegExp.
/*!
RE2JS 2.9.0, https://github.com/le0pard/re2js, bundled unchanged.

MIT License

Copyright (c) 2023 Oleksii Vasyliev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import { RE2JS } from 're2js';
import { normalizeText } from '../dom/visible-text.js';

const WORD = '[\\p{L}\\p{N}_]';
const SPECIAL = /[.*+?^${}()|[\]\\]/g;
const RE_FLAGS = RE2JS.CASE_INSENSITIVE | RE2JS.LOOKBEHINDS;
// An unescaped \k<, a named back-reference. translateRegExp would turn it into a literal "k<"
// that quietly matches something else, so it's refused before translating.
const NAMED_BACKREF = /(?:^|[^\\])(?:\\\\)*\\k</;

// Plain words for what RE2 refuses, read after "it": "line 3 is skipped because it looks ahead".
function reasonFor(message) {
  const detail = String(message).replace(/^error parsing regexp: /, '');
  if (/Perl syntax: `\(\?[=!]/.test(detail)) return 'looks ahead';
  if (/escape sequence: `\\[1-9]/.test(detail)) return 'refers back to a group';
  if (detail.startsWith('invalid capture in lookbehind')) return 'has a group inside a look-behind';
  if (/character class range: `\\[pP]/.test(detail)) return 'uses an unknown \\p{...} name';
  if (/repeat count: `\{[^`]*\d{4}/.test(detail)) return 'repeats more than 1000 times';
  return "isn't a valid pattern";
}

// Throws an Error whose message is the reason, with RE2's own error as its cause.
function regexFor(source) {
  if (NAMED_BACKREF.test(source)) throw new Error('refers back to a group');
  try {
    return RE2JS.compile(RE2JS.translateRegExp(source), RE_FLAGS);
  } catch (error) {
    throw new Error(reasonFor(error.message), { cause: error });
  }
}

function phraseRegex(phrase) {
  const body = phrase.split(' ').map((word) => word.replace(SPECIAL, '\\$&')).join('\\s+');
  return new RegExp(`(?<!${WORD})${body}(?!${WORD})`, 'iu');
}

// { rules: [{ line, phrase, re }], errors: [{ line, phrase, reason, message }] }. line counts
// from 1 in the list as written. reason is the plain-words cause above. message is RE2's own,
// for the log.
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
        rules.push({ line: index + 1, phrase: line, re: regexFor(source) });
      } catch (error) {
        const message = error.cause?.message ?? error.message;
        errors.push({ line: index + 1, phrase: line, reason: error.message, message });
      }
      return;
    }
    rules.push({ line: index + 1, phrase: line, re: phraseRegex(line) });
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

// Every rule that matches any of the values, in list order. For the preview, which counts each
// line on its own rather than stopping at the one that would hide the post.
export function matchingRules(rules, values) {
  if (!rules.length) return [];
  const clean = values.filter(Boolean).map(normalizeText);
  return rules.filter((rule) => clean.some((value) => rule.re.test(value)));
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
