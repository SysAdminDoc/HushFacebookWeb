// Whether text someone typed looks like CSS: a rule with a block ("div { display: none }"), or
// a declaration on its own line ("display: none !important;"). Used to warn when CSS lands in
// a box that wants words.

const RULE = /[^{}\n]+\{[^{}]*:[^{}]*\}/;
// Property names are lowercase, which keeps "Note: buy milk;" out.
const DECLARATION = /^\s*-?[a-z][a-z-]*\s*:\s*[^:;{}]+;\s*$/m;
const PSEUDO = /^\s*[^\s:]*:(?:has|not|is|where|nth-child|first-child|last-child)\(/im;

export function looksLikeCss(text) {
  const value = String(text ?? '');
  return RULE.test(value) || DECLARATION.test(value) || PSEUDO.test(value);
}
