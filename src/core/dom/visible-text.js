// Text the reader actually sees. Facebook pads labels with zero-width and bidi marks and
// hides decoy letters with display:none, aria-hidden, zero opacity and zero font size, so
// textContent alone can't be trusted for short labels.
//
// normalizeText and isHidden follow FB Feed Filter 0.1.0.17 (core.js normalizeText,
// content.js hiddenByAncestors). MIT, Copyright (c) 2026 Facebook Feed Filter Companion
// contributors; the notice is in THIRD_PARTY_NOTICES.txt.

// Characters that draw nothing. Since 2026-10-11 Facebook puts a combining grapheme joiner
// (U+034F) after every letter of the ad label ("A\u034Fd\u034F"), so it's in here with the other
// default-ignorable fillers: Hangul fillers, Khmer inherent vowels, Mongolian variation
// selectors and variation selectors. The combining ones sit outside the character class,
// where they can't read as joined to the character before them.
const INVISIBLE = /[\u061C\u115F\u1160\u200B-\u200F\u202A-\u202E\u2060-\u2069\u3164\uFEFF\uFFA0]|\u034F|\u17B4|\u17B5|[\u180B-\u180F]|[\uFE00-\uFE0F]/g;

export function normalizeText(value) {
  return String(value ?? '')
    .replace(INVISIBLE, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const viewOf = (element) => element.ownerDocument?.defaultView ?? globalThis;

// Whether element, or anything between it and boundary (inclusive), hides its content.
export function isHidden(element, boundary = null) {
  const view = viewOf(element);
  const stop = boundary?.parentElement ?? null;
  for (let current = element; current && current !== stop; current = current.parentElement) {
    if (current.hidden || current.getAttribute?.('aria-hidden') === 'true') return true;
    const style = view.getComputedStyle?.(current);
    if (style) {
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true;
      if (Number.parseFloat(style.opacity || '1') <= 0.01) return true;
      if (style.fontSize && Number.parseFloat(style.fontSize) <= 0) return true;
    }
    if (current === boundary) break;
  }
  return false;
}

export function hasBox(rect) {
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

// The text drawn inside element: innerText would still include children that are
// aria-hidden, transparent or zero-size, which is where Facebook puts its decoys. accept,
// when given, also has to pass for the element holding each piece of text.
export function visibleText(element, accept = null) {
  const walker = element.ownerDocument.createTreeWalker(element, 4 /* NodeFilter.SHOW_TEXT */);
  const hidden = new Map();
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!hidden.has(parent)) hidden.set(parent, isHidden(parent, element) || (accept !== null && !accept(parent)));
    if (!hidden.get(parent)) text += node.nodeValue;
  }
  return text;
}

// The element's own text nodes, without its children's.
export function ownText(element) {
  let text = '';
  for (const node of element.childNodes) if (node.nodeType === 3) text += node.nodeValue;
  return text;
}
