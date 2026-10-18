// The Download button, also used for the picture-in-picture button. It floats over the photo
// or video under the pointer, or the one keyboard focus is on, inside its own closed shadow
// root, so it never becomes part of Facebook's markup and Facebook's styles can't reach it.
//
// Facebook lays clear boxes over its photos and videos, so the pointer is rarely on the media
// itself. What's under it comes from elementsFromPoint, which lists every layer at that spot,
// and failing that from the videos inside the boxes there. A layer above the media only counts
// as one of those boxes when it sits close to the media in the page. Dialogs, menus and chat
// windows are mounted on their own, far from it, and media under them gets no button.
//
// From the keyboard, the button comes up when focus reaches a photo or video (a photo's link,
// a player's controls), and Tab steps onto it next. Its box sits at the end of the page, so Tab
// is steered: from the element focus reached onto the first button, between buttons in row
// order, and from the last one back to that element, where the browser's own Tab carries on to
// whatever followed it. Shift+Tab from that next element goes straight back past the buttons.

import { uiTokens } from '../../ui/styles.js';

const MIN_SIZE = 160;
const HIDE_AFTER = 450;
const LOOK_UP = 6;
const OWN_LAYER = 12;
const ROW_HEIGHT = 44; // px between buttons stacked in one corner
const DOWNLOAD_ICON = 'M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14';

const CSS = `
:host { all: initial; ${uiTokens} color-scheme: dark; }
button {
  position: fixed; z-index: 2147483000; display: inline-flex; align-items: center; gap: 6px;
  min-height: 36px; padding: 9px 12px; border: 1px solid var(--surface1); border-radius: 6px;
  background: var(--base); color: var(--text); font: 600 13px/1.2 system-ui, sans-serif;
  cursor: pointer; backdrop-filter: blur(8px); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  transition: transform 0.12s ease, background 0.12s ease;
}
button:hover { background: var(--selected); transform: translateY(-1px); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
button[hidden] { display: none; }
button[aria-busy="true"] { cursor: progress; opacity: 0.8; }
svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
`;

// Set on each floating button's box, so the Download and Pop out buttons see through each other.
const FLOATING = 'data-hfw-floating';

// A floating button's box, or something inside one when an event wasn't retargeted to the box.
const floating = (node) => Boolean(node?.hasAttribute?.(FLOATING) || node?.getRootNode?.()?.host?.hasAttribute?.(FLOATING));

const big = (rect) => rect.width >= MIN_SIZE && rect.height >= MIN_SIZE;
const inside = (rect, x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

// Whether an element drawn above the media is part of it, like Facebook's clear boxes.
function ownLayer(media, element) {
  let node = media.parentElement;
  for (let level = 0; node && level < OWN_LAYER; level++, node = node.parentElement) {
    if (node.contains(element)) return true;
  }
  return false;
}

// The photo or video at a point, the button itself ('button'), or null. through: look past
// the button to what's under it.
export function mediaAt(doc, host, x, y, { through = false } = {}) {
  const stack = typeof doc.elementsFromPoint === 'function' ? doc.elementsFromPoint(x, y) : [];
  const above = [];
  for (const element of stack) {
    if (host && element === host) {
      if (through) continue;
      return 'button';
    }
    if (element.hasAttribute?.(FLOATING)) continue;
    if ((element.tagName === 'VIDEO' || element.tagName === 'IMG') && big(element.getBoundingClientRect())) {
      return above.every((layer) => ownLayer(element, layer)) ? element : null;
    }
    above.push(element);
  }
  let node = stack[0] ?? null;
  for (let level = 0; node && level < LOOK_UP; level++, node = node.parentElement) {
    for (const video of node.querySelectorAll('video')) {
      const rect = video.getBoundingClientRect();
      if (big(rect) && inside(rect, x, y)) return video;
    }
  }
  return null;
}

const isMedia = (element) => (element.tagName === 'VIDEO' || element.tagName === 'IMG') && big(element.getBoundingClientRect());

// Whether media fills most of a focused element's box, as a photo does its link. An inline
// link's box can be empty around the block it holds, so an empty box counts too.
function covers(media, box) {
  const area = box.width * box.height;
  if (area < 1) return true;
  const width = Math.min(media.right, box.right) - Math.max(media.left, box.left);
  const height = Math.min(media.bottom, box.bottom) - Math.max(media.top, box.top);
  return width > 0 && height > 0 && width * height >= area / 2;
}

// The photo or video a focused element belongs to: itself, the one filling it (a photo's link),
// or one close by in the page that it sits on (a player's controls). A Like button under a
// photo, or a whole post holding one, belongs to neither.
export function mediaFor(element) {
  if (element?.nodeType !== 1) return null;
  if (isMedia(element)) return element;
  const box = element.getBoundingClientRect();
  for (const media of element.querySelectorAll('video, img')) {
    if (isMedia(media) && covers(media.getBoundingClientRect(), box)) return media;
  }
  const x = (box.left + box.right) / 2;
  const y = (box.top + box.bottom) / 2;
  // Media inside the element was judged above, so a post isn't taken for its photo here.
  let node = element.parentElement;
  for (let level = 0; node && level < LOOK_UP; level++, node = node.parentElement) {
    for (const media of node.querySelectorAll('video, img')) {
      if (isMedia(media) && !element.contains(media) && inside(media.getBoundingClientRect(), x, y)) return media;
    }
  }
  return null;
}

// The floating buttons on one page, so Tab can step through them in row order, and whether the
// last input was a key, which tells focus from the keyboard apart from focus a click gave.
const groups = new WeakMap();

function groupFor(doc) {
  let group = groups.get(doc);
  if (group) return group;
  group = {
    members: new Set(),
    keyboard: false,
    // The last key was Shift+Tab, so focus that just arrived came up from below.
    backward: false,
    // Focus is being moved by step(), not by the browser.
    moving: false,
    rows: () => Math.max(0, ...[...group.members].map((member) => member.row)) + 1,
    onKey(event) {
      group.keyboard = true;
      group.backward = event.key === 'Tab' && event.shiftKey;
      if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.defaultPrevented) step(doc, group, event);
    },
    onPointer() {
      group.keyboard = false;
    },
    // After every button has had its say about the element focus reached. Coming up from below
    // with Shift+Tab, focus goes to the last button first, so going back visits them in reverse.
    // Only the focus that Shift+Tab gave: one the page moves later isn't coming up from below.
    onFocusIn(event) {
      if (group.moving) return;
      const backward = group.backward;
      group.backward = false;
      if (!backward) return;
      const row = shownRow(group, event.target);
      if (row.length && doc.activeElement === event.target) move(group, () => row.at(-1).focus());
    },
  };
  doc.addEventListener('keydown', group.onKey, true);
  doc.addEventListener('pointerdown', group.onPointer, true);
  doc.addEventListener('focusin', group.onFocusIn);
  groups.set(doc, group);
  return group;
}

function leaveGroup(doc, group, member) {
  group.members.delete(member);
  if (group.members.size || groups.get(doc) !== group) return;
  doc.removeEventListener('keydown', group.onKey, true);
  doc.removeEventListener('pointerdown', group.onPointer, true);
  doc.removeEventListener('focusin', group.onFocusIn);
  groups.delete(doc);
}

// The buttons showing for one anchor, in row order.
const shownRow = (group, anchor) => [...group.members].filter((member) => member.shown() && member.anchor() === anchor).sort((a, b) => a.row - b.row);

function move(group, focus) {
  group.moving = true;
  try {
    focus();
  } finally {
    group.moving = false;
  }
}

function step(doc, group, event) {
  const focused = doc.activeElement;
  const on = [...group.members].find((member) => member.shown() && member.host() === focused);
  if (!on) {
    const first = event.shiftKey ? null : shownRow(group, focused)[0];
    if (!first) return;
    event.preventDefault();
    move(group, () => first.focus());
    return;
  }
  const anchor = on.anchor();
  const row = shownRow(group, anchor);
  const next = row[row.indexOf(on) + (event.shiftKey ? -1 : 1)];
  if (next) {
    event.preventDefault();
    move(group, () => next.focus());
    return;
  }
  if (!anchor.isConnected) return;
  move(group, () => anchor.focus({ preventScroll: true }));
  // Going forward, the browser's own Tab then moves on from there.
  if (event.shiftKey) event.preventDefault();
}

// find(element) returns what the button would save ({ ... }) or null. run(found) saves it.
// active() says whether any download switch is on, so nothing is looked up otherwise.
// onMissing() is called when a click finds nothing to save any more. Another feature can use
// the same button with its own name, words and icon, and a row below the Download button.
export function createDownloadButton({ doc, win, find, run, active, log, onMissing, name = 'download', text = 'Download', busyText = 'Saving', icon = DOWNLOAD_ICON, row = 0, failText = 'The download failed' }) {
  let host = null;
  let shadow = null;
  let button = null;
  let current = null;
  let found = null;
  // Media being saved right now. Each one is busy on its own, so a slow save doesn't hold up
  // the button over everything else.
  const saving = new Set();
  const busy = () => Boolean(current && saving.has(current));
  let hideTimer = null;
  let frame = 0;
  let point = null;
  // The element keyboard focus reached when it brought the button up. Null when the pointer did.
  let anchor = null;
  const group = groupFor(doc);
  const member = {
    row,
    host: () => host,
    anchor: () => anchor,
    // A button left up when the script paused or its switch went off goes as Tab comes by.
    shown() {
      if (!anchor || !button || button.hidden || !host?.isConnected) return false;
      if (active()) return true;
      hide();
      return false;
    },
    focus: () => button.focus({ preventScroll: true }),
  };
  group.members.add(member);

  function mount() {
    if (host?.isConnected) return;
    host = doc.createElement('div');
    host.setAttribute('data-hushfacebook-web', name);
    host.setAttribute(FLOATING, '');
    shadow = host.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent = CSS;
    button = doc.createElement('button');
    button.type = 'button';
    button.hidden = true;
    button.addEventListener('click', onClick);
    button.addEventListener('pointerenter', () => clearTimeout(hideTimer));
    button.addEventListener('pointerleave', hideSoon);
    shadow.append(style, button);
    (doc.body ?? doc.documentElement).append(host);
  }

  function label(words) {
    button.replaceChildren();
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', icon);
    svg.append(path);
    button.append(svg, doc.createTextNode(words));
  }

  function hide() {
    clearTimeout(hideTimer);
    current = null;
    found = null;
    anchor = null;
    if (button) button.hidden = true;
  }

  // Keyboard focus is on this button, the other floating one, or the photo or video it's for.
  // The pointer doesn't move or hide the button then.
  function held() {
    if (!anchor) return false;
    const focused = doc.activeElement;
    if (!focused || focused === doc.body) return false;
    if (focused === anchor || floating(focused)) return true;
    return Boolean(current) && mediaFor(focused) === current;
  }

  function lookUp(media) {
    try {
      return find(media);
    } catch (error) {
      log?.error("Couldn't work out what to download", error);
      return null;
    }
  }

  function showState() {
    if (busy()) {
      button.setAttribute('aria-busy', 'true');
      label(busyText);
    } else {
      button.removeAttribute('aria-busy');
      label(typeof text === 'function' ? text(current) : text);
    }
  }

  function hideSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!held()) hide();
    }, HIDE_AFTER);
  }

  // While keyboard focus holds it, the button stays on screen at the edge as its photo or video
  // scrolls away, and follows a copy Facebook drew in its place for the element focus reached.
  function place() {
    if (!current || !button) return;
    if (!active()) {
      hide();
      return;
    }
    const keep = held();
    if (keep && !current.isConnected && anchor.isConnected) {
      const media = mediaFor(anchor);
      const next = media ? lookUp(media) : null;
      if (next) {
        current = media;
        found = next;
      }
    }
    const rect = current.getBoundingClientRect();
    if (!keep && (!current.isConnected || rect.bottom <= 0 || rect.top >= win.innerHeight || !big(rect))) {
      hide();
      return;
    }
    const top = Math.max(rect.top, 0) + 10 + row * ROW_HEIGHT;
    // Held, it stops above the bottom edge, leaving room for every row below it.
    const lowest = keep ? win.innerHeight - (group.rows() - row) * ROW_HEIGHT : top;
    button.style.top = `${Math.max(Math.min(top, lowest), 0)}px`;
    button.style.right = `${Math.max(win.innerWidth - rect.right, 0) + 10}px`;
  }

  // Keyboard focus reached element: the button comes up for its photo or video, or goes.
  function focusOn(element) {
    if (!active()) return;
    const media = mediaFor(element);
    // Still on the same photo or video, like the next control of one player: Tab steps onto
    // the button after the element focus reached first, not after every one.
    if (media && media === current && anchor?.isConnected) return;
    const next = media ? lookUp(media) : null;
    if (!next) {
      if (anchor) hide();
      return;
    }
    mount();
    clearTimeout(hideTimer);
    anchor = element;
    current = media;
    found = next;
    showState();
    button.hidden = false;
    place();
  }

  function check() {
    frame = 0;
    if (!point) return;
    if (!active()) {
      hide();
      return;
    }
    if (anchor) {
      if (held()) return;
      anchor = null;
    }
    mount();
    const target = mediaAt(doc, host, point.x, point.y);
    if (target === 'button') {
      clearTimeout(hideTimer);
      return;
    }
    if (!target) {
      if (current) hideSoon();
      return;
    }
    clearTimeout(hideTimer);
    if (target !== current) {
      const next = lookUp(target);
      if (!next) {
        hideSoon();
        return;
      }
      current = target;
      found = next;
      showState();
    }
    button.hidden = false;
    place();
  }

  // Looked up again at the click: the story viewer may have moved on, or a switch gone off,
  // while the pointer rested on the button. When Facebook swapped the photo or video for a new
  // element, whatever is under the button now is what gets saved, or from the keyboard, what
  // the element focus reached now holds. Never what the pointer happens to be over then.
  function fresh() {
    if (!active()) return null;
    if (!current?.isConnected) {
      if (anchor) current = anchor.isConnected ? mediaFor(anchor) : null;
      else if (point) {
        const below = mediaAt(doc, host, point.x, point.y, { through: true });
        current = below && below !== 'button' ? below : null;
      }
    }
    if (!current) return null;
    return lookUp(current);
  }

  async function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (busy()) return;
    found = fresh();
    if (!found) {
      if (active()) onMissing?.();
      hide();
      return;
    }
    const media = current;
    saving.add(media);
    showState();
    try {
      await run(found, shadow);
    } catch (error) {
      log?.error(failText, error);
    } finally {
      saving.delete(media);
      if (current === media) showState();
      if (!current) button.hidden = true;
    }
  }

  const onMove = (event) => {
    point = { x: event.clientX, y: event.clientY };
    if (!frame) frame = win.requestAnimationFrame(check);
  };
  const onScroll = () => {
    if (current) win.requestAnimationFrame(place);
  };
  // Focus coming onto a floating button is the button's own business. Focus a click gave hands
  // the button back to the pointer.
  const onFocusIn = (event) => {
    const target = event.target;
    if (floating(target)) return;
    if (group.keyboard) focusOn(target);
    else if (anchor) {
      anchor = null;
      hideSoon();
    }
  };
  doc.addEventListener('pointermove', onMove, { capture: true, passive: true });
  doc.addEventListener('focusin', onFocusIn, true);
  win.addEventListener('scroll', onScroll, { capture: true, passive: true });
  win.addEventListener('resize', onScroll, { passive: true });

  return {
    hide,
    // For tests: the button's text and whether it shows.
    state: () => ({ shown: Boolean(button && !button.hidden), text: button?.textContent ?? '', top: button?.style.top, right: button?.style.right }),
    click: () => button?.click(),
    // The words may have changed for the media it's on, like Pop out after its window closed.
    refresh() {
      if (current && button && !busy()) showState();
    },
    stop() {
      if (frame) win.cancelAnimationFrame(frame);
      frame = 0;
      clearTimeout(hideTimer);
      doc.removeEventListener('pointermove', onMove, { capture: true });
      doc.removeEventListener('focusin', onFocusIn, true);
      win.removeEventListener('scroll', onScroll, { capture: true });
      win.removeEventListener('resize', onScroll);
      leaveGroup(doc, group, member);
      anchor = null;
      host?.remove();
    },
  };
}
