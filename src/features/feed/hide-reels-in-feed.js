// Rows of reels Facebook puts between posts on Home ("Reels and short videos"). A single reel
// a friend posted is a post like any other and stays.
//
// A row is told apart without reading its heading, so it works in any language: it sits in
// the feed's list beside the posts, it isn't a post itself, and it links to at least two
// different reels. The Stories tray links to reels too, so it never counts. The test account
// hasn't been shown a reel row yet (2026-10-11), so this follows FB Feed Filter 0.1.0.17's
// reel module check (content.js scanReelModules, MIT), which also asks for two reel links.

import { CANDIDATE_SELECTOR } from '../../core/dom/posts.js';

const REEL_LINK = 'a[href*="/reel/"]';
const NOT_A_ROW = '[data-focus-target="stories_tray"], [role="region"], [role="dialog"], [role="complementary"], [role="navigation"]';
const MIN_REELS = 2;

const reelIdOf = (href) => href?.match(/\/reels?\/(\d+)/)?.[1] ?? null;

// The feed row a reel link sits in, when that row is a reel row. null for a reel inside a post.
export function reelRowOf(link) {
  for (let row = link; row?.parentElement; row = row.parentElement) {
    if (row.matches(CANDIDATE_SELECTOR) || row.matches(NOT_A_ROW)) return null;
    const list = row.parentElement;
    const besidePosts = [...list.children].some((sibling) => sibling !== row && sibling.querySelector(CANDIDATE_SELECTOR));
    if (!besidePosts) continue;
    if (row.querySelector(CANDIDATE_SELECTOR) || row.querySelector(NOT_A_ROW)) return null;
    const reels = new Set([...row.querySelectorAll(REEL_LINK)].map((a) => reelIdOf(a.getAttribute('href'))).filter(Boolean));
    return reels.size >= MIN_REELS ? row : null;
  }
  return null;
}

export default {
  id: 'hideReelsInFeed',
  section: 'feed',
  android: 'Hide Reels in the feed',
  title: 'Hide reel rows in the feed',
  description: 'Hides the rows of reels Facebook puts between posts on Home. Reels your friends post stay.',
  default: false,

  setup({ doc, win, router, hider, log, settings, diagnostics, enabled }) {
    if (!hider || !doc) return;
    let hidden = 0;
    let queued = false;
    const onHome = () => router?.current()?.type === 'home';

    function sweep(root = doc.body) {
      if (!enabled() || !onHome() || !root) return;
      const rows = new Set();
      for (const link of root.querySelectorAll(REEL_LINK)) {
        const row = reelRowOf(link);
        if (row && !hider.isHidden(row)) rows.add(row);
      }
      for (const row of rows) {
        if (hider.hide(row, 'Reels')) {
          hidden++;
          diagnostics?.changed();
        }
      }
    }

    // One sweep per burst of changes: rows fill in over several frames.
    function schedule() {
      if (queued) return;
      queued = true;
      (win ?? globalThis).setTimeout(() => {
        queued = false;
        try {
          sweep();
        } catch (error) {
          log?.error('Looking for reel rows failed', error);
        }
      }, 250);
    }

    const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    const observer = new Observer((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && (node.matches(REEL_LINK) || node.querySelector(REEL_LINK))) {
            schedule();
            return;
          }
        }
      }
    });
    const begin = () => {
      observer.observe(doc.body, { childList: true, subtree: true });
      schedule();
    };
    if (doc.body) begin();
    else doc.addEventListener('DOMContentLoaded', begin, { once: true });

    let on = enabled();
    settings.subscribe(() => {
      if (enabled() === on) return;
      on = enabled();
      if (on) schedule();
      else hider.showAll('Reels');
    });
    router?.subscribe(() => schedule());
    diagnostics?.add('Reel rows hidden', () => String(hidden));
  },
};
