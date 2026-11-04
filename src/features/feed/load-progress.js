// Show progress while posts load. With a lot of posts hidden, Home or a group can sit on Facebook's
// gray loading cards with nothing under them while it fetches page after page. Live 2026-11-04
// with every post hidden the page couldn't scroll (1000 of 1000 px), and Facebook still asked for
// five more posts about every seven seconds without any input: 20 posts in 30 seconds, every one
// hidden, and the screen never changed from the same two cards. Nothing was stuck, it just looked
// that way. This writes how many posts were hidden so far on the first of those cards, drawn by a
// ::before like the hidden-post note, so the wait reads as work going on.
//
// A post is hidden one of two ways and both count. The data rules take an edge's node out and
// keep its cursor so paging still works (pruneAds, pruneSeen, pruneFiltered), so an edge in a
// feed answer with a cursor and no node is one of ours: stock Home sent 26 edges in 7 answers,
// every one with a node (live 2026-11-04). The page rules hide drawn posts through the hider.
//
// Nothing is inserted into Facebook's markup. The card only gets an attribute, the same card
// shape on Home and in a group (role=status inside a role=article with no links, live
// 2026-11-04), and the attribute comes off again when there's nothing to say.

import { SKIP, walk } from '../../core/json-walk.js';
import { plural } from '../../core/i18n.js';
import { FEED_PAGES, feedKind, loadingSign, shown } from '../../core/load-watchdog.js';

export const NOTE = 'data-hfw-loading';
const CARDS = '[role="main"] [role="status"][data-visualcompletion="loading-state"]';

// Feed edges in one answer that a rule emptied. An edge is the first object down any branch with
// a string cursor, so the comments inside a story aren't looked at.
export function emptiedEdges(doc) {
  let emptied = 0;
  walk(doc, (value) => {
    if (Array.isArray(value) || typeof value.cursor !== 'string') return undefined;
    if (!value.node || typeof value.node !== 'object') emptied++;
    return SKIP;
  });
  return emptied;
}

// The first of Facebook's loading cards at the end of the feed, or null. A card inside a post
// that has links is that post's own (a video loading), not the feed's.
export function feedCard(doc) {
  for (const card of doc.querySelectorAll(CARDS)) {
    if (shown(card) && loadingSign(card)) return card;
  }
  return null;
}

export const noteText = (count) => plural(count, 'Hid {count} post so far. Getting more from Facebook', 'Hid {count} posts so far. Getting more from Facebook');

export function css() {
  return [
    `[${NOTE}]::before { content: attr(${NOTE}); display: block; margin-bottom: 8px; padding: 10px 16px; border: 1px solid #343745; border-radius: 6px; background: linear-gradient(90deg, #171923 30%, #262a3b 50%, #171923 70%) 0 0 / 300% 100%; font: 600 13px/1.4 system-ui, sans-serif; color: #c4b0ff; animation: hfw-loading 1.8s linear infinite; }`,
    '@keyframes hfw-loading { from { background-position: 100% 0; } to { background-position: 0 0; } }',
    `@media (prefers-reduced-motion: reduce) { [${NOTE}]::before { animation: none; } }`,
  ].join('\n');
}

export default {
  id: 'showLoadProgress',
  section: 'feed',
  title: 'Show progress while posts load',
  description: "When your settings hide a lot of posts, Home or a group can sit on Facebook's gray loading boxes while it fetches more five at a time. This puts a line above them with how many posts were hidden so far, so you can tell it's still working.",
  default: true,
  webOnly: true,
  css,

  setup({ win, doc, net, router, hider, settings, diagnostics, enabled }) {
    if (!win || !doc || !router) return;
    const onFeed = () => feedKind(router.current()) !== null;
    const live = () => enabled() && onFeed();
    // Counted for the feed that's open. The hider's count runs from the page load, so it's read
    // against where it stood when this feed opened.
    let emptied = 0;
    let base = hider?.hiddenPosts() ?? 0;
    const hidden = () => emptied + (hider?.hiddenPosts() ?? 0) - base;
    let marked = null;

    function update() {
      const count = hidden();
      const card = live() && count > 0 ? feedCard(doc) : null;
      if (marked && marked !== card) marked.removeAttribute(NOTE);
      marked = card;
      if (!card) return;
      const text = noteText(count);
      if (card.getAttribute(NOTE) !== text) card.setAttribute(NOTE, text);
    }

    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      win.setTimeout(() => {
        queued = false;
        update();
      }, 200);
    };

    net?.transformResponses({
      id: 'showLoadProgress',
      enabled: live,
      markers: ['"__isFeedUnit"'],
      // Home's first posts come inside the page, later ones in their own answers.
      match: (ctx) => ctx.transport === 'json-parse' || FEED_PAGES.test(ctx.friendlyName ?? ''),
      observe: true,
      transform(data) {
        if (!onFeed()) return;
        const count = emptiedEdges(data);
        if (!count) return;
        emptied += count;
        schedule();
      },
    });
    hider?.subscribe(schedule);
    router.subscribe(() => {
      emptied = 0;
      base = hider?.hiddenPosts() ?? 0;
      schedule();
    });
    settings?.subscribe(schedule);
    const Observer = win.MutationObserver ?? globalThis.MutationObserver;
    new Observer(() => {
      if (live() || marked) schedule();
    }).observe(doc, { childList: true, subtree: true });
    diagnostics?.add('Posts hidden on this feed', () => (live() ? String(hidden()) : 'off'));
  },
};
