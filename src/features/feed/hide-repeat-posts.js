// Hide repeats of a post already on the page. People post the same words or photo to several
// groups, so Home and the groups feed show it again and again in one visit, and Hide seen posts
// only acts from the next visit. This keeps the first copy on the page and hides a later one by
// the same poster with the same key (core/seen-keys.js: the same photo or video, or the same
// first words, which a "See more" cut keeps). Someone else's post with the same words is their
// own and stays. Nothing is stored: the first copies are held in memory while they're on the
// page, and one Facebook takes away is forgotten.

import { watchPostChecks } from '../../core/dom/post-checks.js';
import { inDialog } from '../../core/dom/posts.js';
import { nameKey } from '../../core/filters/lists.js';
import { posterOf } from '../../core/filters/page.js';
import { pageKeys } from '../../core/seen-keys.js';
import { FILTERED } from './filters.js';

const REASON = 'Repeat';
// Node.DOCUMENT_POSITION_PRECEDING.
const PRECEDING = 2;

// What a key says matched, for the Diagnostics decision list.
const matchedBy = (key) => (key.startsWith('m:') ? 'same photo or video' : 'same text');

export default {
  id: 'hideRepeatPosts',
  section: 'filters',
  webOnly: true,
  title: 'Hide repeats of a post already on the page',
  description: 'When someone posts the same words or photo more than once, in several groups say, Home and your groups feed show the first copy and hide the rest behind a note. A post by someone else with the same words stays. Nothing is kept after the page closes.',
  default: false,

  setup({ router, posts, hider, diagnostics, settings, enabled }) {
    if (!posts || !hider) return;
    const route = () => router?.current();
    const changed = () => diagnostics?.changed();
    // key -> the first post on the page with that key, and who posted it.
    let first = new Map();
    let hidden = 0;
    const forget = (element) => {
      for (const [key, entry] of first) if (entry.element === element) first.delete(key);
    };
    posts.on('post/remove', ({ element }) => forget(element));

    const hide = (element, key) => {
      if (!hider.hide(element, REASON, undefined, matchedBy(key))) return;
      hidden++;
      changed();
    };

    const watcher = watchPostChecks({
      posts,
      enabled,
      check(element) {
        // A post opened in a dialog is the feed's own post shown again, not a repeat or a first copy.
        if (!FILTERED.routes(route()) || inDialog(element)) return true;
        // Not filled in yet: look again on the next retry.
        const keys = pageKeys(element);
        const poster = nameKey(posterOf(element) ?? '');
        if (!keys.length || !poster) return false;
        for (const key of keys) {
          const earlier = first.get(key);
          if (!earlier || earlier.element === element || !earlier.element.isConnected || earlier.poster !== poster) continue;
          // A copy higher on the page that filled in later is the first one after all.
          if (earlier.element.compareDocumentPosition(element) & PRECEDING) {
            forget(earlier.element);
            for (const own of keys) first.set(own, { element, poster });
            hide(earlier.element, key);
            return true;
          }
          hide(element, key);
          return true;
        }
        for (const key of keys) if (!first.has(key)) first.set(key, { element, poster });
        return true;
      },
    });

    diagnostics?.add('Repeats hidden on this page', () => String(hidden), { shareable: true });

    let on = enabled();
    settings?.subscribe(() => {
      if (enabled() === on) return;
      on = enabled();
      first = new Map();
      hider.showAll(REASON);
      if (on) watcher.recheckAll();
    });
  },
};
