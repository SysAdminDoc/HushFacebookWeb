// One window-capture listener per event type, shared by every link feature. It runs
// before Facebook's handlers, which swap in the l.facebook.com redirect on mousedown, and
// click runs again after that so the browser follows the cleaned href.
//
// A handler returns 'stop' to keep Facebook's handlers from seeing the event at all (the
// way Privacy Badger handles outbound Facebook links). The default action, following the
// link, still happens.

const EVENTS = ['pointerdown', 'mousedown', 'mouseup', 'click', 'auxclick', 'contextmenu', 'focusin', 'dragstart'];
const STOPPABLE = new Set(['mousedown', 'mouseup', 'click', 'auxclick']);
const registries = new WeakMap();

export function onLinkActivation(win, handler) {
  let handlers = registries.get(win);
  if (!handlers) {
    handlers = [];
    registries.set(win, handlers);
    const listener = (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const anchor = path.find((node) => node?.tagName === 'A' && node.hasAttribute?.('href'));
      if (!anchor) return;
      let stop = false;
      for (const run of handlers) if (run(anchor, event) === 'stop') stop = true;
      if (stop && STOPPABLE.has(event.type)) event.stopImmediatePropagation();
    };
    for (const type of EVENTS) win.addEventListener(type, listener, { capture: true, passive: true });
  }
  handlers.push(handler);
}
