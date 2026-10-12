// Keys typed in the settings panel stay in it. Facebook's single-key shortcuts (l likes the
// selected post, c comments, s shares, p starts a post) listen on the page, and a key from inside
// the panel's closed shadow root reaches them as a key on a plain div, so they act on it. Live
// 2026-10-12 "speed" typed in Find a setting came out "seed": Facebook's applyCommand took the p.
// This listener goes on the window before Facebook's scripts run, so it's the first to see a key,
// and stops key events aimed at the panel there. Typing, Tab and Escape are the browser's own
// defaults, which stopping an event doesn't cancel.

export const PANEL_ATTRIBUTE = 'data-hushfacebook-web';
const KEY_EVENTS = ['keydown', 'keypress', 'keyup'];

// From outside, a closed shadow root's path ends at its host, so the host is what's checked.
export const fromPanel = (event) => (event.composedPath?.() ?? [event.target]).some((node) => node?.getAttribute?.(PANEL_ATTRIBUTE) === 'ui');

export function keepKeysInPanel(win) {
  const stop = (event) => {
    if (fromPanel(event)) event.stopImmediatePropagation();
  };
  for (const type of KEY_EVENTS) win.addEventListener(type, stop, true);
}
