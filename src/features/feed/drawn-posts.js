// The page half of drawnEdges (ad-markers.js). A feed post Facebook drew on the server keeps its
// data, so React can hydrate it without #418, and is hidden here instead by its place in the
// feed: aria-posinset counts the feed's edges from 1, the same as the data, and needs no words.
// Places only hold on the page that loaded with them. Another feed numbers its posts from 1 too,
// and coming back to this one draws the same edges from Facebook's store at the same places.
//
// Returns the onDrawn callback for adRule, or undefined when there's no page to hide posts on,
// which leaves adRule dropping those edges like any other.

import { watchPostChecks } from '../../core/dom/post-checks.js';

export function hideDrawnPosts({ posts, hider, router, settings, enabled, reason, onHide, schedule, cancel }) {
  if (!posts || !hider || !router) return undefined;
  const places = new Map();
  let loaded = null;

  const watcher = watchPostChecks({
    posts,
    enabled,
    schedule,
    cancel,
    check(element) {
      // The data can come after the post is drawn, so the retries wait for it.
      if (!places.size) return false;
      if (router.current().path !== loaded) return true;
      const signal = places.get(Number(element.getAttribute('aria-posinset')));
      if (signal && hider.hide(element, reason)) onHide?.(signal);
      return true;
    },
  });

  // Switched off, the post comes back: its data was never taken out.
  let on = enabled();
  settings?.subscribe(() => {
    if (enabled() === on) return;
    on = enabled();
    if (on) watcher.recheckAll();
    else hider.showAll(reason);
  });

  return (kept) => {
    loaded ??= router.current().path;
    for (const { place, signal } of kept) places.set(place, signal);
    watcher.recheckAll();
  };
}
