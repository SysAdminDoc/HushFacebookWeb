// The post box at the top of a group's posts ("Write something...") and of your own profile's
// ("What's on your mind?"), for people who only read. Home's goes with Hide Stories tray's
// option, so this switch leaves Home alone.
//
// Live 2026-11-04 (signed in, script off, 1600 px): the box is a block before the posts, in the
// column that holds them. On a group that column holds the box and then the feed, on your own
// profile the box, the Posts header (Filters, Manage posts) and the feed. A friend's profile that
// takes no posts has the header and the feed only. The box carries no label of its own in any
// language, so it's found by its parts: a link holding your round picture (an svg image), the
// prompt (a [role=button] with no aria-label) and a row of buttons with an aria-label and an icon
// img (Live video and Photo/video on a profile, Anonymous post, Feeling/activity and Poll on a
// group), with no post, heading, tab list, field or form inside. The Posts header has a heading,
// the profile's left column its Intro and Photos headings. The Create post dialog the box opens
// is outside [role=main] and a comment box is inside its post, so neither is looked at.

import { whenRootReady } from '../../core/env.js';

export const POST_BOX_MARK = 'data-hfw-post-box';

// The marks only count on these pages, so one left behind elsewhere hides nothing.
const PAGES = ['groups', 'profile'];
export const POST_BOX_CSS = `${PAGES.map((page) => `html[data-hfw-route="${page}"] [${POST_BOX_MARK}]`).join(',\n')} { display: none !important; }`;

const POSTS = '[aria-posinset], [role="article"]';
const NEVER = `${POSTS}, h1, h2, h3, h4, h5, h6, [role="heading"], [role="tablist"], [role="feed"], [role="textbox"], [role="dialog"], form, textarea, input:not([type="file"])`;
// How many blocks before each one holding the posts are looked at.
const LOOK_BACK = 3;

// Whether block is laid out the way the post box was seen live.
export function isPostBox(block) {
  if (block.closest('[role="dialog"]') || block.matches(NEVER) || block.querySelector(NEVER)) return false;
  if (!block.querySelector('a svg image')) return false;
  if (!block.querySelector('[role="button"]:not([aria-label])')) return false;
  let icons = 0;
  for (const button of block.querySelectorAll('[role="button"][aria-label]')) {
    if (button.querySelector('img') && ++icons >= 2) return true;
  }
  return false;
}

// The post box in the column holding the page's posts, or null.
export function postBox(doc) {
  const main = doc.querySelector('[role="main"]');
  if (!main) return null;
  const seen = new Set();
  for (const post of main.querySelectorAll(POSTS)) {
    for (let holder = post; holder.parentElement && holder.parentElement !== main; holder = holder.parentElement) {
      if (seen.has(holder)) break;
      seen.add(holder);
      let before = holder.previousElementSibling;
      for (let n = 0; before && n < LOOK_BACK; n += 1, before = before.previousElementSibling) {
        if (isPostBox(before)) return before;
      }
    }
  }
  return null;
}

export default {
  id: 'hidePostBox',
  section: 'feed',
  title: 'Hide the post box on groups and profiles',
  description: 'Takes the "Write something..." box off the top of groups and the "What\'s on your mind?" box off your profile, for when you only read. Comment boxes stay. Home\'s box goes with Hide Stories tray.',
  default: false,
  webOnly: true,
  css: POST_BOX_CSS,

  setup({ doc, router, enabled }) {
    if (!doc) return;
    const onPage = () => PAGES.includes(router?.current()?.type);
    let queued = false;
    const check = () => {
      queued = false;
      if (!enabled() || !onPage()) return;
      const box = postBox(doc);
      // React reuses blocks when it draws a page again.
      for (const marked of doc.querySelectorAll(`[${POST_BOX_MARK}]`)) {
        if (marked !== box) marked.removeAttribute(POST_BOX_MARK);
      }
      if (box && !box.hasAttribute(POST_BOX_MARK)) box.setAttribute(POST_BOX_MARK, '');
    };
    const view = doc.defaultView;
    // Before the browser paints the change, once however many changes came in.
    const frame = view?.requestAnimationFrame ? (fn) => view.requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16);
    const Observer = view?.MutationObserver ?? globalThis.MutationObserver;
    const observer = new Observer(() => {
      if (queued || !enabled() || !onPage()) return;
      queued = true;
      frame(check);
    });
    whenRootReady(() => {
      observer.observe(doc.documentElement, { childList: true, subtree: true });
      check();
    }, doc);
  },
};
