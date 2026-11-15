// Open Messenger from the top bar, as Hushfacebook does on Android. The top bar's Messenger
// button opens a dropdown of chats, and a chat picked there opens as a small window over the
// page. Live 2026-10-11 (run 50) the button is a div with role="button", aria-label="Messenger"
// and aria-haspopup="dialog" in the banner's account controls, beside a second, zero-sized
// copy Facebook keeps for focus. With chats unread the label reads "Messenger, 1 unread" instead.
// With this on, the button goes to the full Messages page.
// Ctrl, Cmd or Shift with the click, or the middle button, opens it in a new tab instead.
//
// The handler listens on the document in the capture phase, so it runs before React's own
// listeners on the page root, and stops the press there so the dropdown never opens.
//
// Since the button then opens nothing, it stops telling screen readers it opens a dialog that's
// collapsed: aria-haspopup becomes "false" and aria-expanded goes, and Facebook's own values come
// back when the switch is turned off. aria-haspopup stays on it, since the settings gear finds the
// top bar's round buttons by it. Attributes are safe on the server-drawn bar, as React's
// hydration compares nodes and text.

import { whenRootReady } from '../../core/env.js';

export const MESSAGES_PATH = '/messages/';
const BANNER = '[role="banner"]';
// With chats unread the label carries the count, "Messenger, 1 unread" (live 2026-11-15). The
// banner's "See all in Messenger" link in the dropdown stays out.
export const BUTTON = ['[aria-label="Messenger"]', '[aria-label^="Messenger,"]'].map((label) => `${BANNER} [role="button"]${label}`).join(', ');
// On a quieted button, holding Facebook's own values as JSON.
export const ARIA_MARK = 'data-hfw-messenger-aria';
const QUIET = { 'aria-haspopup': 'false', 'aria-expanded': null };

// Sets an attribute, or takes it off for null, writing only when that changes something, so the
// watcher never hears its own writes twice.
function put(el, name, value) {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

export function quietButton(button) {
  if (!button.hasAttribute(ARIA_MARK)) {
    button.setAttribute(ARIA_MARK, JSON.stringify(Object.fromEntries(Object.keys(QUIET).map((name) => [name, button.getAttribute(name)]))));
  }
  for (const [name, value] of Object.entries(QUIET)) put(button, name, value);
}

export function restoreButton(button) {
  const was = JSON.parse(button.getAttribute(ARIA_MARK));
  button.removeAttribute(ARIA_MARK);
  for (const name of Object.keys(QUIET)) put(button, name, was[name]);
}

// Keeps the Messenger buttons quiet while enabled() says so, through Facebook drawing the bar
// again or setting a value back, and gives them back their own values when it doesn't. Only
// changes in the top bar, or a new top bar, bring a look, so the feed changing costs nothing.
export function createAriaKeeper({ doc, enabled }) {
  const view = doc.defaultView;
  const frame = view?.requestAnimationFrame ? (fn) => view.requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16);
  let observer = null;
  let queued = false;
  let banner = null;
  const sync = () => {
    queued = false;
    if (!observer) return;
    for (const button of doc.querySelectorAll(BUTTON)) quietButton(button);
    // Every button on the page was just looked at, so changes not heard yet, this look's own
    // writes among them, need no look of their own.
    observer.takeRecords();
  };
  const touched = (records) => {
    if (!banner?.isConnected) banner = doc.querySelector(BANNER);
    if (!banner) return false;
    return records.some((record) => (record.type === 'attributes'
      ? Boolean(messengerButton(record.target))
      : banner.contains(record.target) || [...record.addedNodes].some((node) => node.contains?.(banner))));
  };
  return {
    apply() {
      if (!doc.documentElement) return;
      if (!enabled()) {
        observer?.disconnect();
        observer = null;
        for (const button of doc.querySelectorAll(`[${ARIA_MARK}]`)) restoreButton(button);
        return;
      }
      if (!observer) {
        const Observer = view?.MutationObserver ?? globalThis.MutationObserver;
        observer = new Observer((records) => {
          if (queued || !touched(records)) return;
          queued = true;
          frame(sync);
        });
        observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: Object.keys(QUIET) });
      }
      sync();
    },
  };
}

// Presses that would open the dropdown. Only the click and Enter or Space navigate. A touch is
// held back by its pointer events, which leave the tap's click alone. Stopping its touchstart
// would cancel that click, so a tap would go nowhere.
const PRESSES = ['pointerdown', 'mousedown', 'pointerup', 'mouseup'];

export const messengerButton = (target) => (typeof target?.closest === 'function' ? target.closest(BUTTON) : null);

export function messengerTarget(event) {
  if (event.type === 'keydown') return event.key === 'Enter' || event.key === ' ' ? 'here' : null;
  if (event.type === 'auxclick') return event.button === 1 ? 'tab' : null;
  if (event.type !== 'click' || event.button !== 0) return null;
  return event.ctrlKey || event.metaKey || event.shiftKey ? 'tab' : 'here';
}

export default {
  id: 'messengerPage',
  section: 'opening',
  android: 'Open Messenger from the top bar',
  title: 'Open Messenger as a full page',
  description: 'The Messenger button in the top bar goes straight to the Messages page instead of opening the list of chats over Facebook.',
  default: false,
  needsPage: false,

  setup({ doc, win, settings, enabled, log, diagnostics }) {
    let sent = 0;
    const stop = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const go = (where) => {
      sent++;
      diagnostics?.changed();
      try {
        if (where === 'tab') win.open(MESSAGES_PATH, '_blank', 'noopener');
        else win.location.assign(MESSAGES_PATH);
      } catch (error) {
        log?.error("Couldn't open the Messages page", error);
      }
    };
    const onPress = (event) => {
      if (enabled() && messengerButton(event.target)) stop(event);
    };
    const onActivate = (event) => {
      if (!enabled() || !messengerButton(event.target)) return;
      const where = messengerTarget(event);
      if (event.type === 'keydown' && !where) return;
      stop(event);
      if (where) go(where);
    };
    for (const type of PRESSES) doc.addEventListener(type, onPress, true);
    for (const type of ['click', 'auxclick', 'keydown']) doc.addEventListener(type, onActivate, true);
    const aria = createAriaKeeper({ doc, enabled });
    whenRootReady(() => aria.apply(), doc);
    settings?.subscribe(() => whenRootReady(() => aria.apply(), doc));
    diagnostics?.add('Messenger button presses sent to Messages', () => String(sent));
  },
};
