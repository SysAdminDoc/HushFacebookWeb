// Hides posts for features, with a reason, without touching the feed's own children.
//
// Attributes written on the feed's direct children have been measured to stall infinite
// scroll (the MIT fb-sponsored-ad-post-blocker), so the mark goes one level inside the post,
// on its first child, and a :has() rule hides the post from there. With "Leave a note" on,
// the post shrinks to one line ("Hidden: Sponsored. Show") drawn from the mark's own
// attributes, and a click on that line brings the post back for the rest of the visit.
// Nothing is ever inserted into Facebook's markup.

export const MARK = 'data-hfw-hide';
export const NOTE = 'data-hfw-note';
const POST = ':is([aria-posinset], [role="article"])';

export function hideCss({ notes }) {
  if (!notes) return `${POST}:has(> [${MARK}]) { display: none !important; }`;
  return [
    `${POST}:has(> [${MARK}]) > :not([${MARK}]) { display: none !important; }`,
    `${POST} > [${MARK}] > * { display: none !important; }`,
    `${POST} > [${MARK}]::before { content: attr(${NOTE}); display: block; padding: 10px 16px; font: 13px/1.4 system-ui, sans-serif; color: var(--secondary-text, #65676b); cursor: pointer; }`,
  ].join('\n');
}

export function createHider({ doc = globalThis.document, posts, log } = {}) {
  const counts = new Map();
  const counted = new WeakMap(); // post element -> reason it was counted under
  const revealed = new WeakSet();
  const listeners = new Set();
  let watching = false;

  const markerOf = (element) => element.firstElementChild;

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
    const marker = markerOf(element);
    if (!marker?.hasAttribute(MARK)) return;
    marker.removeAttribute(MARK);
    marker.removeAttribute(NOTE);
  }

  // A recycled element holds a different story, so what was hidden or shown in it before
  // no longer applies.
  function watchRecycling() {
    if (watching || !posts) return;
    watching = true;
    posts.on('post/remove', ({ element }) => {
      revealed.delete(element);
      counted.delete(element);
      if (element.isConnected) clear(element);
    });
  }

  function onClick(event) {
    const marker = event.target;
    if (!marker?.hasAttribute?.(MARK)) return;
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
      const marker = markerOf(element);
      if (!marker) return false;
      watchRecycling();
      const label = detail ? `${reason}: ${detail}` : reason;
      marker.setAttribute(MARK, reason);
      marker.setAttribute(NOTE, `Hidden: ${label}. Show`);
      if (!counted.has(element)) {
        counted.set(element, reason);
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
        notify();
      }
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
    isHidden: (element) => markerOf(element)?.hasAttribute(MARK) === true,
    // Posts hidden since the page loaded, per reason.
    counts: () => Object.fromEntries(counts),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
