// Whether text someone typed looks like CSS: a rule with a block ("div { display: none }"), a
// declaration on its own line ("display: none !important;"), or a selector with :has() and the
// like. Used to warn when CSS lands in a box that wants words. Every check stays within a line
// (a rule's block aside) and reads the text once, since a filter list can run to thousands of
// lines.

// Property names are lowercase, which keeps "Note: buy milk;" out.
const DECLARATION = /^[ \t]*-?[a-z][a-z-]*[ \t]*:[ \t]*[^:;{}\n]+;[ \t]*$/m;
const PSEUDO = /^[ \t]*[^\s:]*:(?:(?:has|not|is|where|nth-child)\(|(?:first|last)-child\b)/im;

// Something other than spaces before a { on its line, then a colon before the }, with no
// other brace in between.
function hasRule(text) {
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\n' || char === '}') start = i + 1;
    if (char !== '{') continue;
    const selector = /\S/.test(text.slice(start, i));
    let colon = false;
    let j = i + 1;
    start = j;
    for (; j < text.length && text[j] !== '{' && text[j] !== '}'; j += 1) {
      if (text[j] === ':') colon = true;
      else if (text[j] === '\n') start = j + 1;
    }
    if (selector && colon && text[j] === '}') return true;
    i = j - 1;
  }
  return false;
}

export function looksLikeCss(text) {
  const value = String(text ?? '');
  return hasRule(value) || DECLARATION.test(value) || PSEUDO.test(value);
}
