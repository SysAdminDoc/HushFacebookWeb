// Clean up Reels, as Hushfacebook does on Android. The reel viewer draws the reel's name, a Follow
// button, its audio and caption in one block over the bottom of the video. Live 2026-10-11 (run 54)
// that block is an absolutely placed box inside the player's role=group, the box that holds the
// author's h2, and the video itself sits outside the group, two levels up. The Follow button is in the h2's row
// after a hidden " · ", a role=button whose label holds the author's name ("Follow <name>" in
// English), which finds it in any language. Works in content mode.

export const MARK = 'data-hfw-reel';
const DELAY = 150;

export const CLEAN_REELS_CSS = (get) => [
  get('cleanUpReels.follow') ? `[${MARK}="follow"] { display: none !important; }` : '',
  get('cleanUpReels.caption') ? `[${MARK}="overlay"] { transition: opacity 0.2s ease; }\n[${MARK}="player"]:not(:hover) [${MARK}="overlay"] { opacity: 0 !important; }` : '',
].filter(Boolean).join('\n');

const clean = (text) => (text ?? '').replace(/\s+/g, ' ').trim();

// The reel's player group for an author heading, or null when the heading isn't a reel's. Live
// (run 56) the video sits two levels above the group, in a box that holds this reel alone. A box
// with a video and more than one heading is a list of reels, so its headings aren't taken.
const VIDEO_LEVELS = 3;

export function playerOf(heading) {
  const group = heading.closest('[role="group"]');
  if (!group) return null;
  let node = group.parentElement;
  for (let level = 0; node && level < VIDEO_LEVELS; level++, node = node.parentElement) {
    if (node.querySelector('video')) return node.querySelectorAll('h2').length === 1 ? group : null;
  }
  return null;
}

// The block over the video: the heading's nearest absolutely placed ancestor inside the player.
export function overlayOf(heading, player, styleOf) {
  for (let node = heading.parentElement; node && node !== player; node = node.parentElement) {
    if (styleOf(node).position === 'absolute') return node;
  }
  return null;
}

// The Follow button and its " · " in front, as one element to hide.
export function followOf(heading, player) {
  const name = clean(heading.querySelector('a')?.textContent);
  if (!name) return null;
  const button = [...player.querySelectorAll('div[role="button"][aria-label]')].find((candidate) => {
    const label = clean(candidate.getAttribute('aria-label'));
    return label !== name && label.includes(name) && !candidate.closest('h2');
  });
  if (!button) return null;
  let node = button;
  while (node.parentElement && node.parentElement !== player && !node.parentElement.contains(heading)) {
    node = node.parentElement;
    if (node.querySelector('span[aria-hidden="true"]')) return node;
  }
  return button;
}

export function markReels(doc, styleOf) {
  let marked = 0;
  const mark = (element, kind) => {
    if (!element || element.getAttribute(MARK) === kind) return;
    element.setAttribute(MARK, kind);
    marked++;
  };
  for (const heading of doc.querySelectorAll('[role="group"] h2')) {
    if (!heading.querySelector('a')) continue;
    const player = playerOf(heading);
    if (!player) continue;
    mark(player, 'player');
    mark(overlayOf(heading, player, styleOf), 'overlay');
    mark(followOf(heading, player), 'follow');
  }
  return marked;
}

export function createReelCleaner({ doc, enabled, styleOf, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
  let timer = null;
  let marked = 0;
  const sync = () => {
    timer = null;
    if (enabled()) marked += markReels(doc, styleOf);
  };
  const schedule = () => {
    timer ??= setTimer(sync, DELAY);
  };
  return {
    start() {
      const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
      new Observer(() => {
        if (enabled()) schedule();
      }).observe(doc.body, { childList: true, subtree: true });
      sync();
    },
    sync,
    schedule,
    marked: () => marked,
  };
}

export default {
  id: 'cleanUpReels',
  section: 'reels',
  android: 'Clean up Reels',
  title: 'Clean up Reels',
  description: "Takes the Follow button off reels, and keeps a reel's name and caption off the video until you point at it.",
  default: false,
  options: [
    { key: 'follow', type: 'toggle', label: 'Hide the Follow button', default: true },
    { key: 'caption', type: 'toggle', label: 'Show the name and caption only when you point at the reel', default: true },
  ],
  css: CLEAN_REELS_CSS,

  setup({ doc, win, settings, diagnostics, enabled }) {
    const view = win ?? doc.defaultView;
    const styleOf = (element) => view.getComputedStyle(element);
    const cleaner = createReelCleaner({ doc, enabled, styleOf });
    const begin = () => cleaner.start();
    if (doc.body) begin();
    else doc.addEventListener('DOMContentLoaded', begin, { once: true });
    settings?.subscribe(() => cleaner.schedule());
    diagnostics?.add('Reel parts tidied', () => String(cleaner.marked()));
  },
};
