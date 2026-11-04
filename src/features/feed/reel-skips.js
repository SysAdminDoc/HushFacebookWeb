// Reels, with Hide posts by words' reels option. The Reels viewer shows one reel at a time, so a
// reel the filter hides is skipped, not hidden. Live 2026-11-04 (/reel/?s=tab, script off):
//
// - The viewer pages with FBUnifiedVideoContainerQuery, five reels an answer. Each reel's edge
//   comes first and holds no words. Its caption (message), who posted it (actors), its sound
//   (attachments[].media.track_title) and the rest come after the edge, in a deferred document of
//   their own (label ..._reels$defer$FBUnifiedVideoMediaFooter_footer_..., path
//   viewer/video_feed_unit_feed/edges/N/node). The edge has gone to the page by then, so the data
//   is only read: each reel's fields, by its video's id (attachments[].media.id, a Video).
// - A page loaded on /reel/?s=tab has the first reel and its footer in its inline data.
// - The address is /reel/<that id>, and the viewer only ever moves by replaceState: /reel/?s=tab,
//   then /reel/<first>, then /reel/<id> for each move, up or down.
// - The card buttons are the first and last [role=button][aria-label] two levels under
//   [role=main] ("Previous Card" and "Next Card"), Previous with aria-disabled="true" on the first
//   reel. click() on them moves the viewer, twice within 400 ms too. A made-up ArrowDown doesn't.

import { walk, SKIP } from '../../core/json-walk.js';
import { storyFields } from '../../core/filters/story.js';

export const REELS = {
  queries: /^FBUnifiedVideoContainerQuery$/,
  routes: (route) => route?.type === 'reel',
};

// The reel an address shows, or null: the Reels tab before its first reel, or another page.
export function reelIdOf(route) {
  if (route?.type !== 'reel') return null;
  return route.path?.match(/^\/reel\/(\d+)/)?.[1] ?? null;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The id of the first Video in a story's attachments, or null.
function videoOf(story) {
  if (!Array.isArray(story.attachments)) return null;
  for (const attachment of story.attachments) {
    const media = attachment?.media;
    if (media?.__typename === 'Video' && typeof media.id === 'string') return media.id;
  }
  return null;
}

// Calls visit(id, story) for each reel story in doc that says who posted it: the footer's, never
// the bare edge's or the like bar's, which name no one.
export function eachReel(doc, visit) {
  walk(doc, (value) => {
    if (!isObject(value) || !Array.isArray(value.actors)) return undefined;
    const id = videoOf(value);
    if (id === null) return undefined;
    visit(id, value);
    return SKIP;
  });
}

// What the filter looks at in a reel: storyFields' text, authors, alt text and sites, and the
// name of its sound. No kinds: every reel is a video, so Hide all video posts would skip them all.
export function reelFields(story) {
  const { text, authors, alt, sites } = storyFields(story);
  const sounds = new Set();
  walk(story.attachments, (value) => {
    if (isObject(value) && typeof value.track_title === 'string' && value.track_title) sounds.add(value.track_title);
    return undefined;
  });
  return { text: [...text, ...sounds], authors, alt, sites, kinds: new Set() };
}

// The viewer's Previous Card (back) or Next Card button, or null when it isn't there or is off.
export function cardButton(doc, back) {
  const main = doc.querySelector('[role="main"]');
  const cards = main ? [...main.querySelectorAll(':scope > div > div > [role="button"][aria-label]')] : [];
  if (cards.length !== 2) return null;
  const button = back ? cards[0] : cards[1];
  return button.getAttribute('aria-disabled') === 'true' ? null : button;
}

export const SKIP_LIMIT = 10;
export const SKIP_DELAY = 250;
const VISITS_LIMIT = 1000;

// Skips each reel verdict(id) gives a reason for as the viewer reaches it, the way the viewer was
// going, and tells skipped(id, reason) first. The reel the viewer opened on by its own link always
// shows, as a post opened by its link does; the first one the Reels tab (/reel/ with no id) shows
// can go. Going back to a skipped reel skips it backward, and the first reel, with no Previous
// Card, stays. After limit skips in a row the next match stays too, so a list that matches every
// reel can't run the viewer away, and a reel that stays starts the count over. check() looks at
// the reel on screen again, for its data coming in after it.
export function createReelSkipper({ doc, router, verdict, skipped, limit = SKIP_LIMIT, delay = SKIP_DELAY, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
  let last = null;
  let at = null;
  let opened = null;
  let back = false;
  let run = 0;
  let visits = [];
  let timer = null;

  function check() {
    timer = null;
    if (at === null || at === opened) return;
    const reason = verdict(at);
    if (reason === null) {
      run = 0;
      return;
    }
    if (run >= limit) return;
    const button = cardButton(doc, back);
    if (!button) return;
    run += 1;
    skipped(at, reason);
    button.click();
  }
  const schedule = () => {
    timer ??= setTimer(check, delay);
  };

  function arrive(route) {
    const before = last;
    last = route;
    const id = reelIdOf(route);
    if (id === null) {
      at = null;
      return;
    }
    if (id === at) return;
    if (at === null) {
      opened = before?.type === 'reel' && reelIdOf(before) === null ? null : id;
      visits = [];
      run = 0;
    }
    const index = visits.indexOf(id);
    back = index !== -1 && index < visits.indexOf(at);
    if (index === -1) {
      visits.push(id);
      if (visits.length > VISITS_LIMIT) visits.shift();
    }
    at = id;
    schedule();
  }

  arrive(router.current());
  router.subscribe?.(arrive);
  return { check: schedule };
}
