// Keep post dates, as Hushfacebook does on Android. A post's header says "3h" or "2d", and the
// full date only shows in a tooltip when you point at it (live 2026-10-11, captures/
// 2026-10-11-run23: "Sunday, October 11, 2026 at 6:24 PM" on Home and the groups feed). The
// script puts the date and time next to that short one.
//
// The time comes from Facebook's own data. Every feed story it sends carries creation_time (in
// seconds) beside its comet_sections, and the page's posts are matched to the stories the same
// way Hide seen posts does it (core/seen-keys.js): by a photo or video in the post, or by its
// first words. A shared post's original has a time of its own deeper down, so only the top
// story's time is read. Nothing in the data is changed. Needs the script running in the page.
//
// The time link is the header link Facebook opens in a new tab: it has a target, but no rel
// (the hidden copies of the post's link out have one), no label (the avatar and the Hide post
// button do) and isn't inside the post text or an <object> (12 of 12 posts checked live).

import { watchPostChecks } from '../../core/dom/post-checks.js';
import { ownLinks } from '../../core/dom/posts.js';
import { pageKeys, storyKeys } from '../../core/seen-keys.js';

export const DATE_MARK = 'data-hfw-post-date';
export const MARKERS = ['"comet_sections"'];
const MAX_REMEMBERED = 4000;
const MESSAGE = '[data-ad-rendering-role="story_message"], [data-ad-preview="message"]';
const HEADINGS = 'h1, h2, h3, h4, h5, h6, [role="heading"]';

export const POST_DATES_CSS = `[${DATE_MARK}] { margin-inline-start: 0.25em; white-space: nowrap; }`;

// Each top-level feed story's keys with its time. The number of stories read.
export function indexTimes(data, remember) {
  let found = 0;
  (function visit(value, depth) {
    if (!value || typeof value !== 'object' || depth > 80) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (Number.isFinite(value.creation_time) && value.creation_time > 0 && value.comet_sections && typeof value.comet_sections === 'object') {
      for (const key of storyKeys(value)) remember(key, value.creation_time);
      found++;
      return;
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  })(data, 0);
  return found;
}

// Keys aren't one story's alone: a share carries the photo of the post it shares, a share with
// no words of its own is keyed by the original's words, and a seller can paste the same words
// into several groups. A key two stories give different times is kept as null, and a post is
// dated by its first key only one time belongs to, or not at all, never with another's date.
// Shared keys are kept apart from the dated ones, so they never take a dated key's room, and a
// third story with one can't date the others. When the dated book is full, the key seen longest
// ago goes, and its time is kept a while longer, so a story bringing that key back with another
// time makes it shared instead of dating the first post by it. Each of the three is capped.
export function createTimeBook({ max = MAX_REMEMBERED } = {}) {
  const times = new Map(); // key -> seconds, the longest unseen first
  const shared = new Map(); // key -> true, the longest unseen first
  const gone = new Map(); // key -> seconds, for keys that left times
  const add = (map, key, value) => {
    map.delete(key);
    map.set(key, value);
    if (map.size <= max) return null;
    const [oldest, time] = map.entries().next().value;
    map.delete(oldest);
    return [oldest, time];
  };
  return {
    remember(key, seconds) {
      if (shared.has(key)) {
        add(shared, key, true);
        return;
      }
      const before = times.has(key) ? times.get(key) : gone.get(key);
      gone.delete(key);
      if (before !== undefined && before !== seconds) {
        times.delete(key);
        add(shared, key, true);
        return;
      }
      const dropped = add(times, key, seconds);
      if (dropped) add(gone, ...dropped);
    },
    // A post's time, by its first key that has one: a photo or video first, then its words.
    timeOf: (keys) => keys.map((key) => (shared.has(key) ? null : times.get(key))).find((seconds) => typeof seconds === 'number') ?? null,
  };
}

export function timeLinkOf(post) {
  return ownLinks(post).find((a) => a.hasAttribute('target') && !a.hasAttribute('rel') && !a.hasAttribute('aria-label')
    && !a.closest(MESSAGE) && !a.closest(HEADINGS) && !a.closest('object')) ?? null;
}

// Facebook draws the short time in a box only as wide as the time, one item in the header's
// row of time, dot and audience icon (a wrapping flex row, live 2026-10-11, run 68). A date put
// inside that box wrapped under the time, and the dot and icon landed on top of it. So the date
// goes right after the box, as an item of its own in the row. A header without such a row keeps
// it right after the link.
const ROW_LEVELS = 5;

export function dateSpot(link) {
  const view = link.ownerDocument?.defaultView;
  let item = link;
  for (let i = 0; i < ROW_LEVELS; i++) {
    const parent = item.parentElement;
    if (!parent || parent.matches('[aria-posinset], [role="article"]')) break;
    const display = view?.getComputedStyle ? view.getComputedStyle(parent).display : '';
    if (display === 'flex' || display === 'inline-flex') return item;
    item = parent;
  }
  return link;
}

export function formatTime(seconds, lang) {
  const when = new Date(seconds * 1000);
  try {
    return new Intl.DateTimeFormat(lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(when);
  } catch {
    return when.toLocaleString();
  }
}

// The date next to a post's time, put there or brought up to date. True once it's shown.
export function showDate(doc, post, seconds, lang = doc.documentElement?.lang) {
  const link = timeLinkOf(post);
  const spot = link ? dateSpot(link) : null;
  for (const old of post.querySelectorAll(`[${DATE_MARK}]`)) {
    if (old.previousElementSibling !== spot) old.remove();
  }
  if (!spot || seconds === null) return false;
  const value = String(seconds);
  const next = spot.nextElementSibling;
  if (next?.hasAttribute(DATE_MARK)) {
    if (next.getAttribute(DATE_MARK) !== value) {
      next.setAttribute(DATE_MARK, value);
      next.textContent = `· ${formatTime(seconds, lang)}`;
    }
    return true;
  }
  const span = doc.createElement('span');
  span.setAttribute(DATE_MARK, value);
  span.textContent = `· ${formatTime(seconds, lang)}`;
  spot.after(span);
  return true;
}

export default {
  id: 'keepPostDates',
  section: 'feed',
  android: 'Keep post dates',
  title: 'Show full post dates',
  description: "Each post shows the day and time it went up next to Facebook's short \"3h\" or \"2d\", so you don't have to point at it to find out.",
  default: false,
  needsPage: true,
  css: POST_DATES_CSS,

  setup({ doc, net, posts, enabled, settings, diagnostics }) {
    const book = createTimeBook();
    net.transformResponses({
      id: 'keepPostDates',
      enabled,
      markers: MARKERS,
      // Facebook parses its feed answers and the page's inline data with JSON.parse, so this
      // sees every story. It only reads.
      match: (ctx) => ctx.transport === 'json-parse',
      transform(data) {
        indexTimes(data, book.remember);
        return false;
      },
    });

    let shown = 0;
    const check = (element) => {
      const had = Boolean(element.querySelector(`[${DATE_MARK}]`));
      const done = showDate(doc, element, book.timeOf(pageKeys(element)));
      if (done && !had) {
        shown++;
        diagnostics?.changed();
      }
      return done;
    };
    if (posts) {
      const watcher = watchPostChecks({ posts, enabled, check });
      // Facebook can put another story in a post it already drew, so a changed post is looked
      // at again even once its date is up.
      posts.on('post/update', ({ element }) => {
        if (enabled()) check(element);
      });
      let on = enabled();
      settings?.subscribe(() => {
        if (enabled() === on) return;
        on = enabled();
        if (on) watcher.recheckAll();
        else for (const mark of doc.querySelectorAll(`[${DATE_MARK}]`)) mark.remove();
      });
    }
    diagnostics?.add('Post dates shown', () => String(shown));
  },
};
