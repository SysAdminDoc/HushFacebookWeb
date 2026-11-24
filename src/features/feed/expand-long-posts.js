// Expand long posts. Facebook cuts a long post or comment off with "… See more" and opens the rest
// in place when you click it. Live 2026-10-12 the button is an unlabelled div[role=button] holding
// only its words, the last thing in the text's block, right after the "…" (most sit inside
// [data-ad-preview="message"], but posts with other layouts have the same shape outside it). That
// shape finds it in any language. The script clicks it as it comes near the screen, once each,
// so posts open as you scroll to them rather than all at once. Works in content mode.
//
// Live 2026-11-24 (#19): an open post now gets a "See less" button in the same block and the
// same shape, and the block itself stays while its text and button are swapped. What tells the
// two apart is Facebook's own "…": it stands alone in a text node (text, "…", " ", button, or
// a span and then "…  " on 2026-10-12), while See less comes straight after the post's own
// words. A post whose author ended it with "..." used to read as cut off again once open, so
// it opened and closed without end. A block the script has opened is also left alone from
// then on, while it holds the same post, so closing a post by hand with See less sticks.
//
// A button that comes near the screen while the switch is off or the script is paused is
// looked at again once it's back on, and opens then if it's still cut off.

import { whenBodyReady } from '../../core/env.js';

const DELAY = 150;
const MAX_WORDS = 24; // characters in the button's text
const SCOPE = '[aria-posinset], [role="article"]';
const CANDIDATES = ['[aria-posinset] div[role="button"]:not([aria-label])', '[role="article"] div[role="button"]:not([aria-label])'].join(', ');
const NEAR = '600px 0px';

const clean = (text) => (text ?? '').replace(/\s+/g, ' ').trim();
const TEXT = 3;
const COMMENT = 8;

// Whether the thing right before the button is Facebook's own "…", in a text node of its own.
// Spaces and the comment marks the server leaves between pieces of text are stepped over.
function afterCutMark(button) {
  for (let node = button.previousSibling; node; node = node.previousSibling) {
    if (node.nodeType === COMMENT) continue;
    if (node.nodeType !== TEXT) return false;
    const text = node.data.trim();
    if (text) return text === '…' || text === '...';
  }
  return false;
}

// Whether a button is a "See more" at the end of cut-off text.
export function isSeeMore(button) {
  const words = clean(button.textContent);
  if (!words || words.length > MAX_WORDS || button.querySelector('a, img, svg') || !button.closest(SCOPE)) return false;
  const block = button.parentElement;
  if (!block || block.lastElementChild !== button) return false;
  return afterCutMark(button);
}

export function createExpander({ doc, enabled, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
  // Buttons waiting to come near the screen, and text blocks already opened. A button that
  // couldn't be opened when it came near leaves the first without its block joining the second,
  // so the next look watches it again. Blocks rather than buttons: Facebook keeps the block and
  // puts a new button in it each time the text opens or closes. Each opened block keeps how its
  // cut-off text began, so a block that comes back with another post's text opens again.
  const watched = new Set();
  // Only a See more's block is read, never an open post's whole text, and only its start.
  const openedBlocks = new WeakMap();
  const lead = (block) => clean(block.textContent.slice(0, 240)).slice(0, 60);
  const isOpened = (block) => openedBlocks.has(block) && openedBlocks.get(block) === lead(block);
  let opened = 0;
  let timer = null;
  const Observer = doc.defaultView?.IntersectionObserver ?? globalThis.IntersectionObserver;
  const open = (button) => {
    const block = button.parentElement;
    if (!enabled() || !button.isConnected || !block || !isSeeMore(button) || isOpened(block)) return;
    openedBlocks.set(block, lead(block));
    opened++;
    button.click();
  };
  const near = Observer
    ? new Observer((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || !watched.has(entry.target)) continue;
        stopWatching(entry.target);
        open(entry.target);
      }
    }, { rootMargin: NEAR })
    : null;
  function stopWatching(button) {
    near.unobserve(button);
    watched.delete(button);
  }
  const sync = () => {
    timer = null;
    // A button taken off the page is let go. If Facebook puts it back, it's watched again.
    for (const button of watched) if (!button.isConnected) stopWatching(button);
    if (!enabled()) return;
    for (const button of doc.querySelectorAll(CANDIDATES)) {
      if (watched.has(button) || !isSeeMore(button) || isOpened(button.parentElement)) continue;
      if (!near) {
        open(button);
        continue;
      }
      watched.add(button);
      near.observe(button);
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
  section: 'reading',
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
