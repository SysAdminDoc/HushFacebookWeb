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

// On the header row: the story's time in seconds, and the date as it reads. On the row's item
// the date follows: DATE_SPOT.
export const DATE_MARK = 'data-hfw-post-date';
export const DATE_TEXT = 'data-hfw-post-date-text';
export const DATE_SPOT = 'data-hfw-post-date-spot';
export const MARKERS = ['"comet_sections"'];
const MAX_REMEMBERED = 4000;
const MESSAGE = '[data-ad-rendering-role="story_message"], [data-ad-preview="message"]';
const HEADINGS = 'h1, h2, h3, h4, h5, h6, [role="heading"]';

export const POST_DATES_CSS = [
  `[${DATE_MARK}]::after { content: attr(${DATE_TEXT}); order: 1; margin-inline-start: 0.25em; white-space: nowrap; }`,
  `[${DATE_MARK}] > [${DATE_SPOT}] ~ * { order: 2; }`,
].join('\n');

// Facebook writes a post's time as "6 days ago" only while it's under a week old, and as
// "October 1 at 5:47 PM" from then on (BaseRelativeTimestampUtils counts whole days below 7,
// live 2026-10-12), so an older post already shows its date and gets none from the script.
export const RELATIVE_FOR = 7 * 24 * 60 * 60;
export const shownAsRelative = (seconds, now = Date.now() / 1000) => now - seconds < RELATIVE_FOR;

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
//
// The date is no node of its own. Feeds and the groups feed come with their first posts drawn on
// the server, as markup React takes over (hydrates) a moment later, and a span put into it first
// made React throw #418 and draw the post again: 4 of 4 loads with dates on, 0 of 14 with them
// off or no script (live 2026-11-05). Facebook's React keeps no mark on the nodes it has taken
// over (no "__reactFiber$" key on any of 400 divs), so there's nothing to wait for. Hydration
// compares nodes and text, not attributes, so the row gets the date as attributes and CSS draws
// it: the row's ::after is a flex item of the row, and order puts it after the time's box and
// before the dot and icon. In a header with no row it follows the link.
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

// Takes the date off a row, leaving Facebook's own nodes as they were.
export function clearDate(row) {
  row.removeAttribute(DATE_MARK);
  row.removeAttribute(DATE_TEXT);
  for (const item of row.children) item.removeAttribute(DATE_SPOT);
}

// The date next to a post's time, put there or brought up to date. True once it's shown, or
// once it's clear Facebook shows the date itself.
export function showDate(doc, post, seconds, lang = doc.documentElement?.lang, now = Date.now() / 1000) {
  const link = timeLinkOf(post);
  const spot = link ? dateSpot(link) : null;
  const row = spot?.parentElement ?? null;
  const relative = seconds !== null && shownAsRelative(seconds, now);
  for (const old of post.querySelectorAll(`[${DATE_MARK}]`)) {
    if (old !== row || !relative) clearDate(old);
  }
  if (seconds !== null && !relative) return true;
  if (!row || seconds === null) return false;
  const value = String(seconds);
  if (row.getAttribute(DATE_MARK) !== value) {
    row.setAttribute(DATE_MARK, value);
    row.setAttribute(DATE_TEXT, `· ${formatTime(seconds, lang)}`);
  }
  if (!spot.hasAttribute(DATE_SPOT)) {
    for (const item of row.children) item.removeAttribute(DATE_SPOT);
    spot.setAttribute(DATE_SPOT, '');
  }
  return true;
}

export default {
  id: 'keepPostDates',
  section: 'reading',
  android: 'Keep post dates',
  title: 'Show full post dates',
  description: "Each post shows the day and time it went up next to Facebook's short \"3h\" or \"2d\", so you don't have to point at it to find out.",
  default: false,
  needsPage: true,
  css: POST_DATES_CSS,

  setup({ doc, net, posts, enabled, settings, diagnostics, now = () => Date.now() / 1000 }) {
    const book = createTimeBook();
    net.transformResponses({
      id: 'keepPostDates',
      enabled,
      markers: MARKERS,
      // Facebook parses its feed answers and the page's inline data with JSON.parse, so this
      // sees every story. It only reads.
      match: (ctx) => ctx.transport === 'json-parse',
      observe: true,
      transform(data) {
        indexTimes(data, book.remember);
        return false;
      },
    });

    let shown = 0;
    const check = (element) => {
      const had = Boolean(element.querySelector(`[${DATE_MARK}]`));
      const done = showDate(doc, element, book.timeOf(pageKeys(element)), undefined, now());
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
        else for (const row of doc.querySelectorAll(`[${DATE_MARK}]`)) clearDate(row);
      });
    }
    diagnostics?.add('Post dates shown', () => String(shown));
  },
};
