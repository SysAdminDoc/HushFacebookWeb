// Tells a feature when you've looked at a post: it was on screen for at least minMs, with at
// least half of it showing (or half the screen, for a post taller than that), and then it
// left. A post still on screen when you go to another page or close the tab counts too, if
// it had its second.
//
// Only time on a page where the feature works, with it on and the tab in front, counts. When
// that stops (update() hears about the page and the switch, the tab's own events about the
// rest), a post that already had its second counts then, and the others start over once it's
// back, if they're still showing.
//
// The observer only calls back when a post crosses one of its thresholds. A post 4 screens
// tall never shows more than a quarter of itself, so with only a few thresholds it could
// pass half the screen without a callback. Steps of 2% catch posts up to 25 screens tall.

export const SEEN_AFTER_MS = 1000;
export const THRESHOLDS = Array.from({ length: 51 }, (_, i) => i / 50);

// Enough of the post is showing to have been read.
export function halfShown(entry, screenHeight) {
  if (!entry.isIntersecting) return false;
  const shown = entry.intersectionRect.height;
  const tall = entry.boundingClientRect.height;
  const screen = entry.rootBounds?.height || screenHeight;
  return shown > 0 && shown >= Math.min(tall, screen) / 2;
}

// snapshot(post) runs when a post starts showing, and onSeen(post, snapshot) gets what it
// returned, so a feature can note what the post was then. Facebook can put another story
// in the same element later.
export function watchSeen({ posts, win, active, onSeen, snapshot, minMs = SEEN_AFTER_MS, now = () => win.performance.now() }) {
  const Observer = win?.IntersectionObserver;
  if (!posts || typeof Observer !== 'function') return { stop() {}, flush() {}, update() {} };
  const doc = win.document;
  const since = new Map(); // element -> { start, taken } from when it started showing enough
  const showing = new Set(); // elements showing enough right now, timed or not
  const records = new Map(); // element -> post record (its id can arrive late)
  const counts = () => active() && doc?.visibilityState !== 'hidden';
  let counting = counts();

  // ending: the time stopped counting just now, so what it had so far is all eligible.
  function leave(element, ending = false) {
    const shown = since.get(element);
    since.delete(element);
    // Otherwise the time stopped counting without update() hearing, and there's no telling when.
    if (shown === undefined || (!ending && !counts()) || now() - shown.start < minMs) return;
    const post = records.get(element);
    if (post) onSeen(post, shown.taken);
  }

  function start(element) {
    const post = records.get(element);
    since.set(element, { start: now(), taken: post && snapshot ? snapshot(post) : undefined });
  }

  const observer = new Observer((entries) => {
    for (const entry of entries) {
      if (halfShown(entry, win.innerHeight)) {
        showing.add(entry.target);
        // Only posts showing where the feature works (Home, say) are timed.
        if (!since.has(entry.target) && counts()) start(entry.target);
      } else {
        showing.delete(entry.target);
        leave(entry.target);
      }
    }
  }, { threshold: THRESHOLDS });

  function add(post) {
    records.set(post.element, post);
    observer.observe(post.element);
  }
  function remove({ element }) {
    leave(element);
    showing.delete(element);
    records.delete(element);
    observer.unobserve(element);
  }

  // Everything showing long enough counts when you leave the page.
  function flush() {
    for (const element of [...since.keys()]) leave(element, true);
  }

  // The page, the switch or the tab's visibility may have changed.
  function update() {
    const next = counts();
    if (next === counting) return;
    counting = next;
    if (!next) flush();
    else for (const element of showing) if (!since.has(element)) start(element);
  }

  // The tracker tells a late post/add listener about the posts already there.
  const stops = [
    posts.on('post/add', add),
    posts.on('post/remove', remove),
    posts.on('reset', () => {
      since.clear();
      showing.clear();
      records.clear();
    }),
  ];
  win.addEventListener?.('pagehide', flush);
  doc?.addEventListener?.('visibilitychange', update);

  return {
    flush,
    update,
    stop() {
      for (const stop of stops) stop();
      observer.disconnect();
      win.removeEventListener?.('pagehide', flush);
      doc?.removeEventListener?.('visibilitychange', update);
      since.clear();
      showing.clear();
      records.clear();
    },
  };
}
