// Hide counts. Live 2026-10-22 on Home and a post page, Facebook draws a post's counts inside its
// Like, Comment and Share buttons, next to the icon:
//   <div role="button" aria-label="Like"><div><div><span><i data-visualcompletion="css-img"></i></span><div></div></div>
//     <div><span>47.8K</span></div></div></div>
// The reaction preview is a toolbar of reaction pictures after those buttons ("See who reacted to
// this"), each one a button labelled with its count ("Like: 31K people"). A comment's reactions
// are one button of pictures labelled "151 reactions; see who reacted to this". Reaction pictures
// are 16 or 18 pixel `img[role=presentation]` drawn from data:image/svg+xml, where people's
// pictures and photos come from Facebook's photo servers.
// Each is found by its shape and its digits rather than English words, so it works in any
// language. Only what's drawn is hidden: Facebook's data keeps its counts, since the comment count
// also decides whether "View more comments" shows. The buttons stay and keep working, and your own
// reaction still shows on the Like button. Works in content mode. The reel viewer draws its
// counts beside svg icons and isn't covered.

import { whenBodyReady } from '../../core/env.js';

export const MARK = 'data-hfw-count';
const DELAY = 150;
const ICON = 'i[data-visualcompletion="css-img"]';
// Facebook's short counts: 12, 1,234, 1 234 (\s covers the no-break spaces), 47.8K, 1,2 mil, 2,3 tys., 1.2万,
// Arabic's own separators (١٫٢ ألف, ١٬٢٣٤) and a word in front (elfu 1.2).
const COUNT = /^(?:[^\p{Nd}\s.,]{1,5}\s)?\p{Nd}[\p{Nd}\s.,'\u066B\u066C]*(?:[^\p{Nd}\s.,\u066B\u066C]{1,5}\.?)?$/u;
const DIGIT = /\p{Nd}/u;
// Bars and menus that carry their own counts (Hide tab badges has those).
const AWAY = '[role="banner"], [role="navigation"]';
// A post's row: Like, Comment and Share, sometimes Send, with Facebook's icons.
const ROW_BUTTONS = [3, 5];
const ROW_DEPTH = 2;
const PICTURE = 'i, svg, img, video, canvas, [style*="background-image"]';
const REACTION = 'img[src^="data:image/"], img[src*="/rsrc.php/"]';

export const KINDS = [
  { kind: 'post', option: 'posts', label: 'Hide counts on posts' },
  { kind: 'preview', option: 'preview', label: 'Hide the reaction preview on posts' },
  { kind: 'comment', option: 'comments', label: 'Hide the reaction preview on comments' },
];

export function countsCss(get) {
  const shown = KINDS.filter(({ option }) => get(`hideCounts.${option}`)).map(({ kind }) => `[${MARK}="${kind}"]`);
  return shown.length ? `${shown.join(',\n')} { display: none !important; }` : '';
}

// Direction marks and other invisible format characters come and go around numbers in
// right-to-left pages.
const clean = (text) => (text ?? '').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();

// The node to hide for one inside a button or comment: the highest one above it that holds
// nothing else (no icon, picture or other text), so no empty box is left behind.
function holderOf(node, stop) {
  let holder = node;
  while (holder.parentElement && holder.parentElement !== stop && clean(holder.parentElement.textContent) === clean(holder.textContent)
    && !holder.parentElement.querySelector(PICTURE)) {
    holder = holder.parentElement;
  }
  return holder;
}

// The single thing a node sits in, up to two levels, so a toolbar or bubble takes its wrapper
// with it but never a comment's words beside it.
const alone = (node) => [...node.parentElement.childNodes].every((child) => child === node || (child.nodeType !== 1 && !clean(child.textContent)));

function soleHolder(node, stop) {
  let holder = node;
  for (let depth = 0; depth < 2 && holder.parentElement && holder.parentElement !== stop && alone(holder); depth++) {
    holder = holder.parentElement;
  }
  return holder;
}

// Whether a button sits in a post's row of buttons: three to five with Facebook's icons, in its
// parent or the one above (Like shares a parent with React, the others have one each), and not
// a video player's controls drawn over the video beside them.
export function inButtonRow(button) {
  let node = button.parentElement;
  for (let depth = 0; node && depth < ROW_DEPTH; depth++, node = node.parentElement) {
    const buttons = new Set([...node.querySelectorAll(ICON)].map((icon) => icon.closest('[role="button"]')).filter(Boolean));
    if (buttons.size >= ROW_BUTTONS[0] && buttons.size <= ROW_BUTTONS[1]) return !(node.parentElement ?? node).querySelector('video');
  }
  return false;
}

// A button of reaction pictures labelled with a number: the preview's buttons and a comment's.
export function reactionButton(button) {
  if (!DIGIT.test(button.getAttribute('aria-label') ?? '') || clean(button.textContent)) return false;
  const pictures = [...button.querySelectorAll('img')];
  return pictures.length > 0 && pictures.length <= 3 && pictures.every((img) => img.matches(REACTION))
    && !button.querySelector('i, svg, a, [role="button"]');
}

// How many of each kind are marked on the page now.
export function tally(doc) {
  const found = { post: 0, preview: 0, comment: 0 };
  for (const node of doc.querySelectorAll(`[${MARK}]`)) found[node.getAttribute(MARK)]++;
  return found;
}

// Marks every count on the page and takes the mark off anything that no longer holds one (React
// redraws nodes in place), returning how many of each kind are marked.
export function markCounts(doc) {
  const wanted = new Map();
  const buttons = new Set([...doc.querySelectorAll(ICON)].map((icon) => icon.closest('[role="button"]')).filter(Boolean));
  for (const button of buttons) {
    if (button.closest(AWAY)) continue;
    const counts = [...button.querySelectorAll('span')].filter((span) => !span.children.length && COUNT.test(clean(span.textContent)));
    if (!counts.length || !inButtonRow(button)) continue;
    for (const count of counts) wanted.set(holderOf(count, button), 'post');
  }
  for (const bar of doc.querySelectorAll('[role="toolbar"]')) {
    const choices = [...bar.querySelectorAll('[role="button"]')];
    if (!choices.length || !choices.every(reactionButton) || bar.closest(AWAY)) continue;
    wanted.set(soleHolder(bar, null), 'preview');
  }
  for (const button of doc.querySelectorAll('[role="article"][aria-label] [role="button"][aria-label]')) {
    if (button.closest('[role="toolbar"]') || !reactionButton(button)) continue;
    wanted.set(soleHolder(button, button.closest('[role="article"]')), 'comment');
  }
  for (const node of doc.querySelectorAll(`[${MARK}]`)) if (!wanted.has(node)) node.removeAttribute(MARK);
  for (const [node, kind] of wanted) if (node.getAttribute(MARK) !== kind) node.setAttribute(MARK, kind);
  return tally(doc);
}

export function createCountHider({ doc, enabled, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
  let timer = null;
  const sync = () => {
    timer = null;
    if (enabled()) markCounts(doc);
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
    marked: () => tally(doc),
  };
}

export default {
  id: 'hideCounts',
  section: 'feed',
  android: 'Hide counts on posts',
  title: 'Hide counts',
  description: 'Takes the numbers off the Like, Comment and Share buttons under posts, the reaction pictures beside them and the reactions on comments, so you read a post without its tallies. The buttons keep working and your own reaction still shows.',
  default: false,
  options: KINDS.map(({ option, label }) => ({ key: option, type: 'toggle', label, default: true })),
  css: countsCss,

  setup({ doc, settings, diagnostics, enabled }) {
    const hider = createCountHider({ doc, enabled });
    whenBodyReady(() => hider.start(), doc);
    settings?.subscribe(() => hider.schedule());
    diagnostics?.add('Post counts hidden', () => {
      const { post, preview, comment } = hider.marked();
      return `posts ${post}, previews ${preview}, comments ${comment}`;
    }, { shareable: true });
  },
};
