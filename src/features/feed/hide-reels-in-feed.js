// Rows of reels Facebook puts between posts ("Reels and short videos"). The data check
// empties captured ShowcaseFeedUnit rows with SHOWCASE_SHORT_VIDEO on Home and the groups
// feed. A single reel a friend posted is a Story and stays.
//
// A row is told apart without reading its heading, so it works in any language: it sits in
// the feed's list beside the posts, it isn't a post itself, and it links to at least two
// different reels. The Stories tray links to reels too, so it never counts. The captured row
// has no page markup yet, so this follows FB Feed Filter 0.1.0.17's reel module check
// (content.js scanReelModules, MIT), which also asks for two reel links.

import { adRule } from './ad-markers.js';
import { CANDIDATE_SELECTOR } from '../../core/dom/posts.js';
import { whenBodyReady } from '../../core/env.js';

const REEL_LINK = 'a[href*="/reel/"]';
const NOT_A_ROW = '[data-focus-target="stories_tray"], [role="region"], [role="dialog"], [role="complementary"], [role="navigation"]';
const MIN_REELS = 2;

const reelIdOf = (href) => href?.match(/\/reels?\/(\d+)/)?.[1] ?? null;

// The feed row a reel link sits in, when that row is a reel row. null for a reel inside a post.
export function reelRowOf(link) {
  // A reel linked from a post (its text, an attachment, a comment) belongs to that post.
  if (link.closest(CANDIDATE_SELECTOR)) return null;
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
  description: 'Hides the rows of reels Facebook puts between posts on Home and in your groups feed. Reels your friends post stay.',
  default: false,

  setup({ net, doc, win, router, hider, log, settings, diagnostics, enabled }) {
    let dataHidden = 0;
    if (net) {
      net.transformResponses(adRule('hideReelsInFeed', enabled, (fired) => {
        dataHidden += fired.length;
        diagnostics?.changed();
      }, { route: () => router?.current(), diagnostics, reason: 'Reels' }));
    }
    diagnostics?.add('Reel rows taken out of the data', () => (net ? String(dataHidden) : "Off: the script can't reach the page's data"));
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
    whenBodyReady(begin, doc);

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
