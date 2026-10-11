// The Stories row at the top of Home and, with the option on, the "What's on your mind?" box
// above it, as Hushfacebook's switch does on Android. Works in content mode and switches off
// without a reload.
//
// Live 2026-10-11 (Home, 1600 px wide): the column above the feed has four children, an empty
// one, the composer block, the Stories block and the feed. The Stories block holds
// div[data-virtualized="false"] > div > div[role=region][data-focus-target="stories_tray"]
// (min-height 160px), and nothing else. data-focus-target doesn't depend on the language, the
// region's aria-label does. The composer is div[role=region][aria-label="Create a post"] in
// English with nothing language-free of its own, so the script also finds it as the block
// right before the Stories block, in the column that holds the feed, and marks it. A CSS
// sibling rule can't do that: "div:has(+ div [tray])" also matched Facebook's top bar, whose
// next sibling holds the whole page (live check, 2026-10-11).

const HOME = 'html[data-hfw-route="home"]';
const TRAY = '[data-focus-target="stories_tray"]';
const POSTS = '[aria-posinset], [role="article"]';
export const COMPOSER_MARK = 'data-hfw-composer';

export const TRAY_SELECTORS = [
  `${HOME} ${TRAY}`,
  // The innermost data-virtualized block around the tray, so its space goes too. Never one
  // that also holds a post.
  `${HOME} [data-virtualized]:has(${TRAY}):not(:has([data-virtualized] ${TRAY}, ${POSTS}))`,
];

export const COMPOSER_SELECTORS = [
  `${HOME} [role="region"][aria-label="Create a post"]`,
  `${HOME} [${COMPOSER_MARK}]`,
];

// The block right before the Stories block, in the column that also holds the feed. null
// when the page isn't laid out the way it was seen live, so nothing else is ever taken.
export function composerBlock(doc) {
  const tray = doc.querySelector(TRAY);
  if (!tray) return null;
  for (let block = tray; block.parentElement; block = block.parentElement) {
    const column = block.parentElement;
    if (column === doc.body || column.matches('[role="main"]')) return null;
    if (!column.querySelector(POSTS)) continue;
    const before = block.previousElementSibling;
    if (!before || before.querySelector(`${TRAY}, ${POSTS}, [role="banner"], [role="navigation"]`)) return null;
    return before.querySelector('[role="button"]') ? before : null;
  }
  return null;
}

export default {
  id: 'hideStoriesTray',
  section: 'feed',
  android: 'Hide Stories tray',
  title: 'Hide Stories tray',
  description: "Takes the Stories row off the top of Home. Stories still open from a friend's profile or a link.",
  default: false,
  options: [
    { key: 'composer', type: 'toggle', label: 'Also hide the "What\'s on your mind?" box', default: true },
  ],
  css: (get) => {
    const selectors = [...TRAY_SELECTORS, ...(get('hideStoriesTray.composer') ? COMPOSER_SELECTORS : [])];
    return `${selectors.join(',\n')} { display: none !important; }`;
  },

  setup({ doc, win, log, option, enabled }) {
    if (!doc) return;
    let queued = false;
    let marked = null;
    const mark = () => {
      queued = false;
      if (!enabled() || !option('composer')) return;
      try {
        const block = composerBlock(doc);
        if (!block) return;
        block.setAttribute(COMPOSER_MARK, '');
        marked = block;
      } catch (error) {
        log?.error("Looking for the What's on your mind box failed", error);
      }
    };
    // Facebook draws Home again after a visit elsewhere, so a mark that left the page is
    // looked for again.
    const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    const observer = new Observer(() => {
      if (queued || marked?.isConnected) return;
      queued = true;
      (win ?? globalThis).setTimeout(mark, 200);
    });
    const begin = () => {
      observer.observe(doc.body, { childList: true, subtree: true });
      mark();
    };
    if (doc.body) begin();
    else doc.addEventListener('DOMContentLoaded', begin, { once: true });
  },
};
