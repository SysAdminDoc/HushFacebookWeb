// Keeps Facebook's j and k keys moving through a feed with hidden posts.
//
// Facebook's handler (useCometFeedKeyCommands, read live 2026-11-18) remembers a post number and
// goes to the one after it. It focuses that post and scrolls to where the post sits. A hidden post
// has no place on the page, and Facebook doesn't count one as visible even with a note line drawn,
// so the next press starts over from the first visible post and picks the same hidden one again.
// j stops for good there: with no note nothing happens at all, and with one, focus stays on it.
//
// Facebook keeps the keys. This waits until its handler has run, and acts only when it claimed the
// key and didn't end up on a shown post in the right direction, so j and k still do nothing for
// someone who has single-key shortcuts turned off. Facebook's number catches up by itself: the
// post moved to is on screen, and it starts from there on the next press.

import { inDialog } from './posts.js';

const FEED_POST = '[aria-posinset]:not([role])';
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
// How far below the top of the window Facebook puts a post it moves to.
const TOP = 76;
const PRECEDING = 2;
const FOLLOWING = 4;

export function keepFeedKeysMoving({ win, doc = win.document, hider, active = () => true }) {
  const feedPosts = () => [...doc.querySelectorAll(FEED_POST)].filter((post) => !inDialog(post));
  const shown = (post) => !hider.isHidden(post) && post.getClientRects().length > 0;
  const postOf = (element) => {
    const post = element?.closest?.(FEED_POST) ?? null;
    return post && !inDialog(post) ? post : null;
  };
  const inDirection = (from, post, forward) => Boolean(from.compareDocumentPosition(post) & (forward ? FOLLOWING : PRECEDING));
  const topOf = (post) => post.getBoundingClientRect().top;

  // The next shown post from the one focus was on, or from the top of the window with none.
  function nextPost(posts, from, forward) {
    const open = posts.filter(shown);
    if (from) return forward ? open.find((post) => inDirection(from, post, true)) : open.findLast((post) => inDirection(from, post, false));
    return forward ? open.find((post) => topOf(post) > TOP) : open.findLast((post) => topOf(post) < TOP);
  }

  function moveTo(post) {
    // Facebook adds this to a post the first time it moves there, and a post without it refuses focus.
    if (!post.hasAttribute('tabindex')) post.setAttribute('tabindex', '-1');
    post.focus({ preventScroll: true });
    win.scrollTo({ top: topOf(post) + win.pageYOffset - TOP, behavior: 'smooth' });
  }

  function settle(event, from, forward) {
    if (!event.defaultPrevented || !active()) return;
    const posts = feedPosts();
    if (!posts.some((post) => hider.isHidden(post))) return;
    const now = postOf(doc.activeElement);
    if (now && now !== from && shown(now) && (!from || inDirection(from, now, forward))) return;
    const target = nextPost(posts, from, forward);
    if (target) {
      moveTo(target);
      return;
    }
    // Nothing shown that way. Facebook may have gone to a hidden post's note, so come back from it.
    if (now && !shown(now)) {
      if (from) moveTo(from);
      else now.blur();
    }
    // Everything left on the page is hidden, so the way on is more of the feed.
    if (forward) win.scrollTo({ top: doc.documentElement.scrollHeight, behavior: 'smooth' });
  }

  win.addEventListener('keydown', (event) => {
    if ((event.key !== 'j' && event.key !== 'k') || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing) return;
    if (!active()) return;
    const focused = doc.activeElement;
    if (focused?.closest?.(EDITABLE) || (focused?.closest && inDialog(focused))) return;
    // Read now: by the time Facebook is done, focus may already be on the hidden post.
    const from = postOf(focused);
    win.setTimeout(() => settle(event, from, event.key === 'j'), 0);
  }, true);
}
