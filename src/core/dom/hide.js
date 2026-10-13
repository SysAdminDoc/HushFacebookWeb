// Hides posts for features, with a reason, without touching the feed's own children.
//
// Attributes written on the feed's direct children have been measured to stall infinite
// scroll (the MIT fb-sponsored-ad-post-blocker), so the mark goes one level inside the post,
// on its first child, and a :has() rule hides the post from there. On facebook.com that
// child is a display:contents wrapper holding the whole post (live 2026-10-11), so it has no
// box of its own. With "Leave a note" on, the post shrinks to one line ("Hidden: Sponsored.
// Show") drawn by the mark's ::before, which still gets a box, and a click on that line
// brings the post back for the rest of the visit. Nothing is ever inserted into Facebook's
// markup. A live scroll past 100 posts with every other one hidden kept paging.
//
// Blocks between posts that aren't posts (a row of reels) are hidden the same way, so the
// rules apply to whatever holds a mark. Only hide() ever sets one.
//
// A post can be hidden for more than one reason at once (a word filter and Hide seen posts).
// The mark lists them all, space-separated, and the note names the first. Showing one
// reason's posts again leaves a post hidden while any other reason still holds.

import { postIdOf } from './posts.js';

export const MARK = 'data-hfw-hide';
export const NOTE = 'data-hfw-note';
const HOLDER = `:has(> [${MARK}])`;
// ::before doesn't draw on these, so they can't carry the note. SVG tag names keep their
// case in an HTML page.
const REPLACED = new Set(['IMG', 'VIDEO', 'IFRAME', 'CANVAS', 'INPUT', 'TEXTAREA', 'SELECT', 'OBJECT', 'EMBED', 'svg', 'STYLE', 'SCRIPT', 'TEMPLATE', 'LINK', 'META']);

export function hideCss({ notes }) {
  if (!notes) return `${HOLDER} { display: none !important; }`;
  return [
    `${HOLDER} > :not([${MARK}]) { display: none !important; }`,
    `[${MARK}] > * { display: none !important; }`,
    // Loose text right inside the mark has no element to hide, so it shrinks to nothing.
    `[${MARK}] { font-size: 0 !important; }`,
    `[${MARK}]::before { content: attr(${NOTE}); display: block; padding: 12px 16px; border: 1px solid #343745; border-radius: 6px; background: #171923; font: 600 13px/1.4 system-ui, sans-serif; color: #c4b0ff; cursor: pointer; }`,
    `[${MARK}]:hover::before { text-decoration: underline; }`,
  ].join('\n');
}

// notesShown: whether the note line is on screen (not paused, "Leave a note" on). Clicks on
// a mark are only taken while it is, so a paused script never swallows one.
// onHide({ element, reason, detail, signal }): told each time a reason goes on a post, not
// when the same reason is applied again, for the Diagnostics decision list.
export function createHider({ doc = globalThis.document, posts, log, notesShown = () => true, onHide } = {}) {
  const counts = new Map();
  // A post counts once, under the first reason it was hidden for. By id, so a post Facebook
  // draws again counts once, and by element, for posts whose id isn't known yet.
  const countedIds = new Set();
  const countedElements = new WeakSet();
  const revealed = new WeakSet();
  // Marks this hider set, so a click on anything else carrying the attribute passes through.
  const marks = new WeakSet();
  // mark -> Map(reason -> its note text), in the order the reasons came.
  const labels = new WeakMap();
  const listeners = new Set();
  let watching = false;

  // The mark normally sits on the first child, but Facebook may put something in front of it.
  const markOf = (element) => [...element.children].find((child) => child.hasAttribute(MARK)) ?? null;

  function notify() {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        log?.error('A hidden-post listener failed', error);
      }
    }
  }

  function clear(element) {
    for (const child of element.children) {
      if (!child.hasAttribute(MARK)) continue;
      child.removeAttribute(MARK);
      child.removeAttribute(NOTE);
      labels.delete(child);
    }
  }

  function write(marker, reasons) {
    marker.setAttribute(MARK, [...reasons.keys()].join(' '));
    marker.setAttribute(NOTE, `Hidden: ${reasons.values().next().value}. Show`);
  }

  // The reasons on a mark. One this hider didn't write still lists them in the attribute.
  function reasonsOf(marker) {
    let reasons = labels.get(marker);
    if (!reasons) {
      reasons = new Map((marker.getAttribute(MARK) ?? '').split(/\s+/).filter(Boolean).map((reason) => [reason, reason]));
      labels.set(marker, reasons);
    }
    return reasons;
  }

  // Counts a post the first time it's hidden. Returns whether it was new.
  function count(element, reason) {
    const id = postIdOf(element).id;
    const seen = countedElements.has(element) || (id !== null && countedIds.has(id));
    countedElements.add(element);
    if (id !== null) countedIds.add(id);
    if (seen) return false;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    return true;
  }

  // A recycled element holds a different story, so what was hidden or shown in it before
  // no longer applies. Until the new story's link fills in, the tracker can't tell it was
  // recycled, so the old mark can stay up for that moment.
  function watchRecycling() {
    if (watching || !posts) return;
    watching = true;
    posts.on('post/remove', ({ element }) => {
      revealed.delete(element);
      countedElements.delete(element);
      if (element.isConnected) clear(element);
    });
  }

  function onClick(event) {
    const marker = event.target;
    if (!marker?.hasAttribute?.(MARK) || !marks.has(marker) || !notesShown()) return;
    const post = marker.parentElement;
    if (!post) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    revealed.add(post);
    clear(post);
  }
  doc.addEventListener('click', onClick, true);

  return {
    // Hides a post found by the post tracker. reason is what Diagnostics counts
    // ("Sponsored", "Filter"); detail narrows it in the note ("Filter: cats"). signal says
    // what matched, for the decision list only, when detail doesn't already say it.
    // Returns false when the post can't be marked or the person chose to see it.
    hide(element, reason, detail, signal) {
      if (revealed.has(element)) return false;
      const marker = markOf(element) ?? element.firstElementChild;
      if (!marker || REPLACED.has(marker.tagName)) return false;
      watchRecycling();
      const reasons = marker.hasAttribute(MARK) ? reasonsOf(marker) : new Map();
      const fresh = !reasons.has(reason);
      reasons.set(reason, detail ? `${reason}: ${detail}` : reason);
      labels.set(marker, reasons);
      write(marker, reasons);
      marks.add(marker);
      if (count(element, reason)) notify();
      if (fresh && onHide) {
        try {
          onHide({ element, reason, detail, signal });
        } catch (error) {
          log?.error('Noting a hidden post failed', error);
        }
      }
      return true;
    },
    show(element) {
      clear(element);
    },
    // Takes one reason off every post, for a feature that was just switched off. A post still
    // hidden for another reason stays hidden, under that one.
    showAll(reason) {
      for (const marker of doc.querySelectorAll(`[${MARK}]`)) {
        const reasons = reasonsOf(marker);
        if (!reasons.delete(reason)) continue;
        if (reasons.size) write(marker, reasons);
        else if (marker.parentElement) clear(marker.parentElement);
      }
    },
    isHidden: (element) => markOf(element) !== null,
    // Posts hidden since the page loaded, per reason.
    counts: () => Object.fromEntries(counts),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
