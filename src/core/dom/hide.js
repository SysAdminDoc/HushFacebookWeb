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
//
// While the note is on screen the mark is also a button, named by the note, so Tab reaches it
// and Enter or Space shows the post like a click does. Focus then moves to the first control
// the post brings back, or stays on the wrapper, given a box, when there's none. Those
// attributes go again with the note (or the focus), so a paused script or a note switched off
// leaves Facebook's element as it was.
//
// The note line has a second button at its end, Show hidden, which shows every post hidden on
// the page the way its own note would. It's Facebook's first element inside the mark, hidden
// with the rest of the post anyway: the rules clear its look, hide what's in it and draw the
// label in its ::before. Being an element of its own, a click on it has its own target, and it
// becomes a button the same way the mark does, after it in Tab order. A first element that
// can't draw a ::before (REPLACED) leaves the note with no second button.

import { inDialog, isComment, postIdOf } from './posts.js';

export const MARK = 'data-hfw-hide';
export const NOTE = 'data-hfw-note';
// On a shown post's wrapper while it keeps focus because nothing in the post can take it.
const HELD = 'data-hfw-held';
const HOLDER = `:has(> [${MARK}])`;
// ::before doesn't draw on these, so they can't carry the note. SVG tag names keep their
// case in an HTML page.
const REPLACED = new Set(['IMG', 'VIDEO', 'IFRAME', 'CANVAS', 'INPUT', 'TEXTAREA', 'SELECT', 'OBJECT', 'EMBED', 'svg', 'STYLE', 'SCRIPT', 'TEMPLATE', 'LINK', 'META']);
// What makes the mark a button while its note shows. The page's own values come back after.
const BUTTON = ['role', 'tabindex', 'aria-label'];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
export const SHOW_ALL = 'Show hidden';
// The note's Show hidden button: the mark's first element, unless it's one ::before can't draw on
// or a mark of its own.
const ALL = `[${MARK}] > :first-child:not(${[...REPLACED].map((tag) => tag.toLowerCase()).join(', ')}, [${MARK}])`;
const allOf = (marker) => {
  const child = marker.firstElementChild;
  return child && !REPLACED.has(child.tagName) && !child.hasAttribute(MARK) ? child : null;
};

export function hideCss({ notes }) {
  if (!notes) return `${HOLDER} { display: none !important; }`;
  return [
    `${HOLDER} > :not([${MARK}]) { display: none !important; }`,
    `[${MARK}] > * { display: none !important; }`,
    // Loose text right inside the mark has no element to hide, so it shrinks to nothing.
    `[${MARK}] { font-size: 0 !important; }`,
    // Facebook's mark is a display:contents wrapper, which can't take focus.
    `[${MARK}] { display: flex !important; gap: 8px; border-radius: 6px; }`,
    `[${MARK}]::before { content: attr(${NOTE}); display: block; flex: 1 1 auto; padding: 12px 16px; border: 1px solid #343745; border-radius: 6px; background: #171923; font: 600 13px/1.4 system-ui, sans-serif; color: #c4b0ff; cursor: pointer; }`,
    `[${MARK}]:hover:not(:has(> :hover))::before { text-decoration: underline; }`,
    // The ring sits on Facebook's page, and on a light one the lavender alone barely shows, so a
    // dark halo fills the gap and runs under it.
    `[${MARK}]:focus-visible { outline: 2px solid #c4b0ff !important; outline-offset: 2px; box-shadow: 0 0 0 4px #171923 !important; }`,
    // Facebook's own element, so its classes' look goes first.
    `${ALL} { all: unset !important; display: block !important; flex: none !important; border-radius: 6px !important; cursor: pointer !important; font-size: 0 !important; }`,
    `${ALL} > * { display: none !important; }`,
    `${ALL}::before { all: unset !important; content: "${SHOW_ALL}" !important; display: block !important; padding: 12px 16px !important; border: 1px solid #343745 !important; border-radius: 6px !important; background: #262a3b !important; font: 600 13px/1.4 system-ui, sans-serif !important; color: #c4b0ff !important; white-space: nowrap !important; }`,
    `${ALL}::after { content: none !important; }`,
    `${ALL}:hover::before { text-decoration: underline !important; }`,
    // Important, or the all: unset above puts the ring back on the edge, outside its halo.
    `${ALL}:focus-visible { outline: 2px solid #c4b0ff !important; outline-offset: 2px !important; box-shadow: 0 0 0 4px #171923 !important; }`,
    `[${HELD}] { display: block !important; }`,
  ].join('\n');
}

// Whether an element takes up room on screen, so focus can land on it.
const drawn = (element) => element.getClientRects().length > 0;

// notesShown: whether the note line is on screen (not paused, "Leave a note" on). Clicks on
// a mark are only taken while it is, so a paused script never swallows one.
// onHide({ element, reason, detail, signal }): told each time a reason goes on a post, not
// when the same reason is applied again, for the Diagnostics decision list.
export function createHider({ doc = globalThis.document, posts, log, notesShown = () => true, onHide } = {}) {
  const counts = new Map();
  // The same count without comments, for the line above the feed's loading cards.
  let postsHidden = 0;
  // A post counts once, under the first reason it was hidden for. By id, so a post Facebook
  // draws again counts once, and by element, for posts whose id isn't known yet.
  const countedIds = new Set();
  const countedElements = new WeakSet();
  const revealed = new WeakSet();
  // Marks this hider set, so a click on anything else carrying the attribute passes through.
  const marks = new WeakSet();
  // mark -> Map(reason -> its note text), in the order the reasons came.
  const labels = new WeakMap();
  // element -> the page's own values of BUTTON, while a mark or its Show hidden is a button.
  const prior = new WeakMap();
  // mark -> the element made its Show hidden button.
  const allButtons = new WeakMap();
  const listeners = new Set();
  let watching = false;
  // The mark Space went down on. A button acts when Space comes up, on the same one.
  let pressed = null;

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

  function makeButton(element, label) {
    if (!prior.has(element)) prior.set(element, BUTTON.map((name) => element.getAttribute(name)));
    element.setAttribute('role', 'button');
    element.setAttribute('tabindex', '0');
    element.setAttribute('aria-label', label);
  }

  function restore(element) {
    const values = prior.get(element);
    if (!values) return;
    prior.delete(element);
    BUTTON.forEach((name, i) => (values[i] === null ? element.removeAttribute(name) : element.setAttribute(name, values[i])));
  }

  function asButton(marker) {
    makeButton(marker, marker.getAttribute(NOTE));
    // Facebook may have swapped the first element since, and the old one goes back as it was.
    const all = allOf(marker);
    const before = allButtons.get(marker);
    if (before && before !== all) restore(before);
    if (all) {
      makeButton(all, SHOW_ALL);
      allButtons.set(marker, all);
    } else allButtons.delete(marker);
  }

  function notButton(marker) {
    restore(marker);
    const all = allButtons.get(marker);
    if (!all) return;
    allButtons.delete(marker);
    restore(all);
  }

  function clear(element) {
    for (const child of element.children) {
      if (!child.hasAttribute(MARK)) continue;
      notButton(child);
      child.removeAttribute(MARK);
      child.removeAttribute(NOTE);
      labels.delete(child);
    }
  }

  function write(marker, reasons) {
    marker.setAttribute(MARK, [...reasons.keys()].join(' '));
    marker.setAttribute(NOTE, `Hidden: ${reasons.values().next().value}. Show`);
    if (notesShown()) asButton(marker);
    else notButton(marker);
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

  // Takes one reason off a mark, and the mark off once none is left.
  function unmark(marker, reason) {
    const reasons = reasonsOf(marker);
    if (!reasons.delete(reason)) return;
    if (reasons.size) write(marker, reasons);
    else if (marker.parentElement) clear(marker.parentElement);
  }

  // Where hide() would put the post's mark, or null when it leaves the post alone: the person
  // chose to see it, or it's open in a dialog (every feature leaves those, though its comments
  // still go by their rules), or there's no element in it to take the mark.
  function markFor(element) {
    if (revealed.has(element)) return null;
    if (inDialog(element) && !isComment(element)) return null;
    const marker = markOf(element) ?? element.firstElementChild;
    return marker && !REPLACED.has(marker.tagName) ? marker : null;
  }

  // Counts a post the first time it's hidden. Returns whether it was new. A comment's links name
  // the post it's on, so a comment counts by its element alone.
  function count(element, reason) {
    const comment = isComment(element);
    const id = comment ? null : postIdOf(element).id;
    const seen = countedElements.has(element) || (id !== null && countedIds.has(id));
    countedElements.add(element);
    if (id !== null) countedIds.add(id);
    if (seen) return false;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    if (!comment) postsHidden++;
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

  const isNote = (target) => Boolean(target?.hasAttribute?.(MARK) && marks.has(target) && notesShown() && target.parentElement);
  // The mark a Show hidden press belongs to, or null.
  const showAllOf = (target) => {
    const marker = target?.parentElement;
    return marker && isNote(marker) && allOf(marker) === target ? marker : null;
  };

  // Shows the post for the rest of the visit. Focus on the note (or its Show hidden) goes to the
  // first control the post brings back, or stays on the mark when there's none, so it never
  // drops to the page.
  function reveal(marker, focused = doc.activeElement === marker) {
    const post = marker.parentElement;
    revealed.add(post);
    clear(post);
    if (!focused) return;
    // A control can be drawn and still refuse focus (visibility:hidden), so the next one is tried.
    for (const control of post.querySelectorAll(FOCUSABLE)) {
      if (!drawn(control)) continue;
      control.focus({ preventScroll: true });
      if (doc.activeElement === control) return;
    }
    // With no mark the wrapper is display:contents again, which browsers won't keep focus on,
    // so it holds a box until focus moves on. The page's own tabindex comes back then.
    const own = marker.getAttribute('tabindex');
    const release = () => {
      marker.removeAttribute(HELD);
      if (own === null) marker.removeAttribute('tabindex');
      else marker.setAttribute('tabindex', own);
    };
    marker.setAttribute(HELD, '');
    marker.setAttribute('tabindex', '-1');
    marker.focus({ preventScroll: true });
    if (doc.activeElement === marker) marker.addEventListener('blur', release, { once: true });
    else release();
  }

  // Shows every post this hider has hidden on the page, for the rest of the visit. Posts that
  // load later are still hidden. Focus on the Show hidden pressed goes into its own post.
  function revealAll(button) {
    const owner = button.parentElement;
    const focused = doc.activeElement === button;
    for (const marker of doc.querySelectorAll(`[${MARK}]`)) {
      if (marks.has(marker) && marker.parentElement) reveal(marker, marker === owner && focused);
    }
  }

  function press(target) {
    if (isNote(target)) reveal(target);
    else revealAll(target);
  }

  const isButton = (target) => isNote(target) || showAllOf(target) !== null;

  function stop(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onClick(event) {
    if (!isButton(event.target)) return;
    stop(event);
    press(event.target);
  }

  // Enter acts as it goes down and Space as it comes up, like the browser's own buttons.
  function onKeyDown(event) {
    if ((event.key !== 'Enter' && event.key !== ' ') || event.altKey || event.ctrlKey || event.metaKey || !isButton(event.target)) return;
    stop(event);
    if (event.key === 'Enter') press(event.target);
    else pressed = event.target;
  }

  function onKeyUp(event) {
    if (event.key !== ' ' || pressed === null) return;
    const target = pressed;
    pressed = null;
    if (event.target !== target || !isButton(target)) return;
    stop(event);
    press(target);
  }
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('keyup', onKeyUp, true);

  return {
    // Hides a post found by the post tracker. reason is what Diagnostics counts
    // ("Sponsored", "Filter"); detail narrows it in the note ("Filter: cats"). signal says
    // what matched, for the decision list only, when detail doesn't already say it.
    // Returns false when the post can't be marked, the person chose to see it or opened it in a
    // dialog.
    hide(element, reason, detail, signal) {
      const marker = markFor(element);
      if (!marker) return false;
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
    // Shows the post again. With a reason, takes only that one off, for a post that no longer
    // fits it: one still hidden for another reason stays hidden, under that one.
    show(element, reason) {
      if (reason === undefined) clear(element);
      else {
        const marker = markOf(element);
        if (marker) unmark(marker, reason);
      }
    },
    // Takes one reason off every post, for a feature that was just switched off.
    showAll(reason) {
      for (const marker of doc.querySelectorAll(`[${MARK}]`)) unmark(marker, reason);
    },
    // Makes each note a button again, or not, after pausing or the note setting changed.
    refresh() {
      const shown = notesShown();
      for (const marker of doc.querySelectorAll(`[${MARK}]`)) {
        if (!marks.has(marker)) continue;
        if (shown) asButton(marker);
        else notButton(marker);
      }
    },
    // Whether hide() would take the post, for a feature that must decide before it asks.
    canHide: (element) => markFor(element) !== null,
    isHidden: (element) => markOf(element) !== null,
    // Whether the person chose to see the post from its note, so hide() leaves it alone.
    isRevealed: (element) => revealed.has(element),
    // Posts hidden since the page loaded, per reason.
    counts: () => Object.fromEntries(counts),
    // Posts hidden since the page loaded, comments left out.
    hiddenPosts: () => postsHidden,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
