// Expand long posts. Facebook cuts a long post or comment off with "… See more" and opens the rest
// in place when you click it. Live 2026-10-12 the button is an unlabelled div[role=button] holding
// only its words, the last thing in the text's block, right after the "…" (most sit inside
// [data-ad-preview="message"], but posts with other layouts have the same shape outside it). That
// shape finds it in any language. The script clicks it as it comes near the screen, once each,
// so posts open as you scroll to them rather than all at once. Works in content mode.

import { whenBodyReady } from '../../core/env.js';

const DELAY = 150;
const MAX_WORDS = 24; // characters in the button's text
const SCOPE = '[aria-posinset], [role="article"]';
const CANDIDATES = ['[aria-posinset] div[role="button"]:not([aria-label])', '[role="article"] div[role="button"]:not([aria-label])'].join(', ');
const NEAR = '600px 0px';

const clean = (text) => (text ?? '').replace(/\s+/g, ' ').trim();

// Whether a button is a "See more" at the end of cut-off text.
export function isSeeMore(button) {
  const words = clean(button.textContent);
  if (!words || words.length > MAX_WORDS || button.querySelector('a, img, svg') || !button.closest(SCOPE)) return false;
  const block = button.parentElement;
  if (!block || block.lastElementChild !== button) return false;
  let before = '';
  for (let node = button.previousSibling; node; node = node.previousSibling) before = node.textContent + before;
  const text = before.trimEnd();
  return text.endsWith('…') || text.endsWith('...');
}

export function createExpander({ doc, enabled, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
  const seen = new WeakSet();
  let opened = 0;
  let timer = null;
  const Observer = doc.defaultView?.IntersectionObserver ?? globalThis.IntersectionObserver;
  const open = (button) => {
    if (!enabled() || !button.isConnected || !isSeeMore(button)) return;
    opened++;
    button.click();
  };
  const near = Observer
    ? new Observer((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        near.unobserve(entry.target);
        open(entry.target);
      }
    }, { rootMargin: NEAR })
    : null;
  const sync = () => {
    timer = null;
    if (!enabled()) return;
    for (const button of doc.querySelectorAll(CANDIDATES)) {
      if (seen.has(button) || !isSeeMore(button)) continue;
      seen.add(button);
      if (near) near.observe(button);
      else open(button);
    }
  };
  const schedule = () => {
    timer ??= setTimer(sync, DELAY);
  };
  return {
    start() {
      const Mutations = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
      new Mutations(() => {
        if (enabled()) schedule();
      }).observe(doc.body, { childList: true, subtree: true });
      sync();
    },
    sync,
    schedule,
    opened: () => opened,
  };
}

export default {
  id: 'expandLongPosts',
  section: 'feed',
  android: 'Expand long posts',
  title: 'Expand long posts',
  description: 'Long posts and comments open in full as you scroll to them, instead of stopping at "See more".',
  default: false,

  setup({ doc, settings, diagnostics, enabled }) {
    const expander = createExpander({ doc, enabled });
    const begin = () => expander.start();
    whenBodyReady(begin, doc);
    settings?.subscribe(() => expander.schedule());
    diagnostics?.add('Long posts opened', () => String(expander.opened()));
  },
};
