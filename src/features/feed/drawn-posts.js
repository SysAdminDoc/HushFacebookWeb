// The page half of drawnEdges (ad-markers.js). A feed post Facebook drew on the server keeps its
// data, so React can hydrate it without #418, and is hidden here instead by its place in the
// feed: aria-posinset counts the feed's edges from 1, the same as the data, and needs no words.
// Places only hold on the page that loaded with them. Another feed numbers its posts from 1 too,
// and coming back to this one draws the same edges from Facebook's store at the same places.
//
// Returns the onDrawn callback for adRule, or undefined when there's no page to hide posts on,
// which leaves adRule dropping those edges like any other.

import { watchPostChecks } from '../../core/dom/post-checks.js';
import { nameKey } from '../../core/filters/lists.js';
import { normalizeText } from '../../core/dom/visible-text.js';
import { authorsOf, isPost, posterOf } from '../../core/filters/page.js';

// Whether the post at a drawn place is the one the data drew there, by who posted it. Facebook
// also puts another feed on the same page: Home fetches its feed again (the Home button, coming
// back after a while, Back from a post: keep-feed-place.js), and a group sorts its posts another
// way, with new posts at the same places. posters are the data's actors (storyFields), never the
// group a post went to, which every post from that group shares. Data that names nobody is a row
// that isn't a post (People you may know, group suggestions), so a post there isn't it. null
// while the post isn't drawn far enough to tell (post-checks.js).
export function drawnHere(element, posters) {
  if (!posters?.length) {
    if (isPost(element)) return false;
    return normalizeText(element.textContent) ? true : null;
  }
  const poster = posterOf(element);
  const names = poster ? [poster] : authorsOf(element);
  if (!names.length) return null;
  const keys = new Set(posters.map(nameKey));
  return names.some((name) => keys.has(nameKey(name)));
}

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
      const drawn = places.get(Number(element.getAttribute('aria-posinset')));
      if (!drawn) return true;
      const here = drawnHere(element, drawn.posters);
      if (here === null) return false;
      if (here && hider.hide(element, reason)) onHide?.(drawn.signal);
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
    for (const { place, signal, posters } of kept) places.set(place, { signal, posters });
    watcher.recheckAll();
  };
}
