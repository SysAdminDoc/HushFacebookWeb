// Which of Facebook's modes the page is in, for the panel's colors. Facebook marks it with one
// class on <html> (force-dark.js has the details), and Force dark mode swaps that same class, so
// following it follows both. A page with neither class yet is treated as dark, the panel's look
// before it had a light one.

import { LIGHT } from '../features/appearance/force-dark.js';

export const pageTheme = (doc) => (doc?.documentElement?.classList?.contains(LIGHT) ? 'light' : 'dark');

// Calls apply('light' or 'dark') now and again whenever the mode changes. Returns a stop function.
export function watchPageTheme(doc, apply) {
  let current = pageTheme(doc);
  apply(current);
  const html = doc?.documentElement;
  const Observer = doc?.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  if (!html || typeof Observer !== 'function') return () => {};
  const observer = new Observer(() => {
    const next = pageTheme(doc);
    if (next === current) return;
    current = next;
    apply(next);
  });
  observer.observe(html, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
