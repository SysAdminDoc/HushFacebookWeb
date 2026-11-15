// The hidden count on the extension's toolbar button for this tab: what Overview's card adds up
// (hidden on the page and removed before they showed). It goes to the worker at most once a
// second and only when it changed, and as 0 while the switch is off or the script is paused,
// which takes it off the button. A page being left sends 0 too, so the count doesn't stay on
// the button once the tab is on another site. A page back from the back/forward cache sends its
// count again, and one Chrome is prerendering waits until it's shown.

export const TOOLBAR_COUNT_EVERY = 1000;

export function toolbarCount({ win, doc, send, count, enabled, log }) {
  let sent; // What the worker last took from this page, undefined when nobody knows.
  let timer = null;
  let lastAt = -Infinity;
  let waiting = false;
  let warned = false;

  const tell = (value) => {
    sent = value;
    lastAt = Date.now();
    send(value).catch((error) => {
      // Sent again on the next change. Once is enough for the log: after an extension update
      // nothing gets through, and the panel already says so.
      if (sent === value) sent = undefined;
      if (warned) return;
      warned = true;
      log?.warn("Couldn't update the hidden count on the toolbar button", error);
    });
  };

  const flush = () => {
    timer = null;
    if (doc?.prerendering) {
      if (!waiting) {
        waiting = true;
        doc.addEventListener('prerenderingchange', () => {
          waiting = false;
          changed();
        }, { once: true });
      }
      return;
    }
    const value = enabled() ? Math.max(0, Math.floor(count()) || 0) : 0;
    if (value !== sent) tell(value);
  };

  function changed() {
    if (timer !== null) return;
    timer = win.setTimeout(flush, Math.max(0, lastAt + TOOLBAR_COUNT_EVERY - Date.now()));
  }

  win.addEventListener('pagehide', () => {
    if (timer !== null) win.clearTimeout(timer);
    timer = null;
    if (sent !== 0 && !doc?.prerendering) tell(0);
  });
  win.addEventListener('pageshow', (event) => {
    if (!event?.persisted) return;
    sent = undefined;
    changed();
  });
  changed();
  return { changed };
}
