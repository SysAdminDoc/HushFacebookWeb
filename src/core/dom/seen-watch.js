// Tells a feature when you've looked at a post: it was on screen for at least minMs, with at
// least half of it showing (or half the screen, for a post taller than that), and then it
// left. A post still on screen when you go to another page or close the tab counts too, if
// it had its second.

export const SEEN_AFTER_MS = 1000;
const THRESHOLDS = [0, 0.1, 0.25, 0.5, 0.75, 1];

// Enough of the post is showing to have been read.
export function halfShown(entry, screenHeight) {
  if (!entry.isIntersecting) return false;
  const shown = entry.intersectionRect.height;
  const tall = entry.boundingClientRect.height;
  const screen = entry.rootBounds?.height || screenHeight;
  return shown > 0 && shown >= Math.min(tall, screen) / 2;
}

export function watchSeen({ posts, win, active, onSeen, minMs = SEEN_AFTER_MS, now = () => win.performance.now() }) {
  const Observer = win?.IntersectionObserver;
  if (!posts || typeof Observer !== 'function') return { stop() {}, flush() {} };
  const since = new Map(); // element -> when it started showing enough
  const records = new Map(); // element -> post record (its id can arrive late)

  function leave(element) {
    const start = since.get(element);
    since.delete(element);
    if (start === undefined || now() - start < minMs) return;
    const post = records.get(element);
    if (post) onSeen(post);
  }

  const observer = new Observer((entries) => {
    for (const entry of entries) {
      if (halfShown(entry, win.innerHeight)) {
        // Only posts that start showing where the feature works (Home, say) are timed.
        if (!since.has(entry.target) && active()) since.set(entry.target, now());
      } else {
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
    records.delete(element);
    observer.unobserve(element);
  }

  // Everything showing long enough counts when you leave the page.
  function flush() {
    for (const element of [...since.keys()]) leave(element);
  }

  // The tracker tells a late post/add listener about the posts already there.
  const stops = [
    posts.on('post/add', add),
    posts.on('post/remove', remove),
    posts.on('reset', () => {
      since.clear();
      records.clear();
    }),
  ];
  win.addEventListener?.('pagehide', flush);

  return {
    flush,
    stop() {
      for (const stop of stops) stop();
      observer.disconnect();
      win.removeEventListener?.('pagehide', flush);
      since.clear();
      records.clear();
    },
  };
}
