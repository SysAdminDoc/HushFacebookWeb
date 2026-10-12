// Hide Follow and Join beside names. Posts from people and groups you don't follow put a button
// after the name, "Cynthia Ravinski · Follow" or "Venice Beach Florida · Join". Live 2026-10-12 it
// is a role=button whose text is the verb and whose label is the verb with the name ("Follow
// Cynthia Ravinski"), in a small span after a hidden " · ":
//   <span><span><span>&nbsp;</span><span aria-hidden="true"> · </span></span><div role="button">Follow</div></span>
// Checking that the rest of the label is a name the post shows, rather than the word "Follow",
// finds it in any language and leaves other dotted buttons alone (the page footer's "· More" is
// labelled "More footer links"). The span with the dot and the button goes, so the name reads on
// its own. Reels have their own switch in Clean up Reels. Works in content mode.

export const MARK = 'data-hfw-follow';
const DELAY = 150;
const MAX_VERB = 24; // characters in the button's own text
const MAX_HOLDER = 40; // characters in the span with the dot and the button
const SCOPE = '[aria-posinset], [role="article"]';
const NAMES = 'a, h2, h3, h4, strong';

export const HIDE_FOLLOW_CSS = `[${MARK}] { display: none !important; }`;

const clean = (text) => (text ?? '').replace(/\s+/g, ' ').trim();
const fold = (text) => clean(text).toLowerCase();

// The name a button's label adds to its own text, or '' when the label adds nothing.
export function labelName(button) {
  const text = fold(button.textContent);
  const label = fold(button.getAttribute('aria-label'));
  if (!text || text.length > MAX_VERB || label === text || !label.includes(text)) return '';
  return clean(label.replace(text, ''));
}

// Whether the post or comment around the button shows that name, as a link or a heading. Whole
// words, so "Seguir a Cynthia Ravinski" finds her name and a short link like "in" finds nothing.
export function namedIn(scope, name, button) {
  if (name.length < 2) return false;
  const words = ` ${name} `;
  for (const node of scope.querySelectorAll(NAMES)) {
    if (node.contains(button)) continue;
    const shown = fold(node.textContent);
    if (shown.length >= 2 && words.includes(` ${shown} `)) return true;
  }
  return false;
}

// For a hidden " · ", the span holding it and the button after it, when that button is one of these.
export function followAfter(dot) {
  if (clean(dot.textContent) !== '·') return null;
  const holder = dot.parentElement?.parentElement;
  if (!holder || clean(holder.textContent).length > MAX_HOLDER) return null;
  const button = [...holder.querySelectorAll('div[role="button"][aria-label]')].find((candidate) => !candidate.contains(dot));
  if (!button || holder.querySelector('a')) return null;
  const scope = holder.closest(SCOPE);
  if (!scope || !namedIn(scope, labelName(button), button)) return null;
  return holder;
}

export function markFollowButtons(doc) {
  let marked = 0;
  for (const dot of doc.querySelectorAll('span[aria-hidden="true"]')) {
    const holder = followAfter(dot);
    if (!holder || holder.hasAttribute(MARK)) continue;
    holder.setAttribute(MARK, '');
    marked++;
  }
  return marked;
}

export function createFollowHider({ doc, enabled, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
  let timer = null;
  let marked = 0;
  const sync = () => {
    timer = null;
    if (enabled()) marked += markFollowButtons(doc);
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
  id: 'hideFollowButtons',
  section: 'feed',
  android: 'Hide Follow and Join buttons',
  title: 'Hide Follow and Join buttons',
  description: "Takes the Follow and Join buttons off the names in posts from people, pages and groups you don't follow, so a post's header shows just who wrote it.",
  default: false,
  css: HIDE_FOLLOW_CSS,

  setup({ doc, settings, diagnostics, enabled }) {
    const hider = createFollowHider({ doc, enabled });
    const begin = () => hider.start();
    if (doc.body) begin();
    else doc.addEventListener('DOMContentLoaded', begin, { once: true });
    settings?.subscribe(() => hider.schedule());
    diagnostics?.add('Follow buttons hidden', () => String(hider.marked()));
  },
};
