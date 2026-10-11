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

import { postIdOf } from './posts.js';

export const MARK = 'data-hfw-hide';
export const NOTE = 'data-hfw-note';
const POST = ':is([aria-posinset], [role="article"])';
// ::before doesn't draw on these, so they can't carry the note.
const REPLACED = new Set(['IMG', 'VIDEO', 'IFRAME', 'CANVAS', 'INPUT', 'TEXTAREA', 'SELECT', 'OBJECT', 'EMBED']);

export function hideCss({ notes }) {
  if (!notes) return `${POST}:has(> [${MARK}]) { display: none !important; }`;
  return [
    `${POST}:has(> [${MARK}]) > :not([${MARK}]) { display: none !important; }`,
    `${POST} > [${MARK}] > * { display: none !important; }`,
    // Loose text right inside the mark has no element to hide, so it shrinks to nothing.
    `${POST} > [${MARK}] { font-size: 0 !important; }`,
    `${POST} > [${MARK}]::before { content: attr(${NOTE}); display: block; padding: 10px 16px; font: 13px/1.4 system-ui, sans-serif; color: var(--secondary-text, #65676b); cursor: pointer; }`,
  ].join('\n');
}

// notesShown: whether the note line is on screen (not paused, "Leave a note" on). Clicks on
// a mark are only taken while it is, so a paused script never swallows one.
export function createHider({ doc = globalThis.document, posts, log, notesShown = () => true } = {}) {
  const counts = new Map();
  // A post counts once, under the first reason it was hidden for. By id, so a post Facebook
  // draws again counts once, and by element, for posts whose id isn't known yet.
  const countedIds = new Set();
  const countedElements = new WeakSet();
  const revealed = new WeakSet();
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
    }
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
    if (!marker?.hasAttribute?.(MARK) || !notesShown()) return;
    const post = marker.parentElement;
    if (!post?.matches(POST)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    revealed.add(post);
    clear(post);
  }
  doc.addEventListener('click', onClick, true);

  return {
    // Hides a post found by the post tracker. reason is what Diagnostics counts
    // ("Sponsored", "Filter"); detail narrows it in the note ("Filter: cats").
    // Returns false when the post can't be marked or the person chose to see it.
    hide(element, reason, detail) {
      if (revealed.has(element)) return false;
      const marker = markOf(element) ?? element.firstElementChild;
      if (!marker || REPLACED.has(marker.tagName)) return false;
      watchRecycling();
      const label = detail ? `${reason}: ${detail}` : reason;
      marker.setAttribute(MARK, reason);
      marker.setAttribute(NOTE, `Hidden: ${label}. Show`);
      if (count(element, reason)) notify();
      return true;
    },
    show(element) {
      clear(element);
    },
    // Brings back every post hidden for one reason, for a feature that was just switched off.
    showAll(reason) {
      for (const marker of doc.querySelectorAll(`[${MARK}]`)) {
        if (marker.getAttribute(MARK) === reason && marker.parentElement) clear(marker.parentElement);
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
