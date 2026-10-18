// Show every reply, part of Hushfacebook's Comment sheet options on Android. Facebook folds
// replies behind "View 3 replies" and "View more replies" buttons; each one fetches its replies
// on its own (Depth1CommentsListPaginationQuery, seen live 2026-10-11), so the script clicks
// them as they appear. It works in rounds a moment apart and rests after five rounds in a row
// with nothing to open, until the page changes again.
//
// A button is clicked again when it says something new. "View more replies" is also tried
// again a few rounds later if it still says that, since Facebook can keep it on one element
// while it loads the next page; a counted one like "12 Replies" isn't, as a second click could
// fold the thread back up. Five times at most. Each post, meaning a dialog or the page at one
// address, gets its own budget of clicks, so a long visit never runs dry. Facebook reuses a
// dialog, and the buttons in it, for the next post or photo, so that post starts with nothing
// spent and nothing clicked, and going back to a post picks up where it left off.
//
// Same reach as Default comment order: a post's own page, a photo's page and a post opened
// over the feed. A reply button is found by the curved arrow Facebook draws in front of its
// words, which is the same in every language (live 2026-10-11: div[role=button] outside the
// comment, holding a span with that svg and a span of text), or by its English words.

import { normalizeText } from '../../core/dom/visible-text.js';
import { whenBodyReady } from '../../core/env.js';
import { dialogOpen } from './post-dialog.js';

export const REPLY_BUTTON = /^(?:view (?:all )?[\d.,]+k? (?:more )?repl(?:y|ies)|view more repl(?:y|ies)|[\d.,]+k? repl(?:y|ies))$/i;
// The start of the reply arrow's svg path.
export const REPLY_ICON = 'M6.94 10.354';
const PER_ROUND = 3;
const PER_BUTTON = 5;
const RETRY_ROUNDS = 3;
// "View more replies" carries no count in any language, unlike "View 3 replies". Counts can come
// in a language's own digits (Persian, Arabic, Bengali), so any digit counts.
const morePages = (text) => !/\p{Nd}/u.test(text);

export function isReplyButton(button, text) {
  if (REPLY_BUTTON.test(text)) return true;
  if (!text || button.closest('[role="article"]')) return false;
  return Boolean(button.querySelector('svg path')?.getAttribute('d')?.startsWith(REPLY_ICON));
}

export function createReplyExpander({ doc, win = globalThis, inPage, enabled, onClick, idleLimit = 5, delay = 800, maxClicks = 300 }) {
  // Both by the address the dialog or page shows.
  const clicked = new WeakMap(); // button -> Map(address -> { text, times, round })
  const spentIn = new WeakMap(); // dialog or body -> Map(address -> clicks)
  let idle = 0;
  let timer = null;
  let rounds = 0;
  let total = 0;

  const address = () => doc.location?.href ?? '';
  const under = (map, key) => map.get(key) ?? map.set(key, new Map()).get(key);
  const spent = (scope) => spentIn.get(scope)?.get(address()) ?? 0;
  const spend = (scope) => under(spentIn, scope).set(address(), spent(scope) + 1);
  const record = (button) => clicked.get(button)?.get(address());
  const note = (button) => under(clicked, button).set(address(), { text: normalizeText(button.textContent), times: (record(button)?.times ?? 0) + 1, round: rounds });

  function ready(button, text) {
    const before = record(button);
    if (!before) return true;
    if (before.times >= PER_BUTTON) return false;
    return before.text !== text || (morePages(text) && rounds - before.round >= RETRY_ROUNDS);
  }

  // Reply buttons to click, each with the post it belongs to. The page behind an open dialog
  // is left alone (see post-dialog.js).
  function candidates() {
    const scopes = [...doc.querySelectorAll('[role="dialog"]')];
    if (inPage() && doc.body && !dialogOpen(doc)) scopes.push(doc.body);
    const found = new Map();
    for (const scope of scopes) {
      if (spent(scope) >= maxClicks) continue;
      for (const button of scope.querySelectorAll('[role="button"]')) {
        if (found.has(button)) continue;
        const text = normalizeText(button.textContent);
        if (isReplyButton(button, text) && ready(button, text)) found.set(button, scope);
      }
    }
    return [...found];
  }

  function schedule() {
    if (!timer) timer = win.setTimeout(round, delay);
  }

  function round() {
    timer = null;
    if (!enabled()) return;
    rounds++;
    const buttons = candidates();
    if (!buttons.length) {
      idle++;
      if (idle < idleLimit) schedule();
      return;
    }
    idle = 0;
    let now = 0;
    for (const [button, scope] of buttons) {
      if (now >= PER_ROUND) break;
      if (spent(scope) >= maxClicks) continue;
      note(button);
      spend(scope);
      button.click();
      now++;
      total++;
      onClick?.();
    }
    schedule();
  }

  return {
    // The page changed: start the rounds again if they were resting.
    wake() {
      if (timer || !enabled()) return;
      idle = 0;
      schedule();
    },
    state: () => ({ idle, total, rounds, running: Boolean(timer) }),
    stop() {
      win.clearTimeout(timer);
      timer = null;
    },
  };
}

export default {
  id: 'showAllReplies',
  section: 'comments',
  android: 'Comment sheet options',
  title: 'Show every reply',
  description: "Opens every folded reply under comments on a post's own page and when you open a post's comments from the feed, so you don't have to click View replies.",
  default: false,

  setup({ doc, win, router, diagnostics, enabled }) {
    let opened = 0;
    const expander = createReplyExpander({
      doc, win: win ?? globalThis, enabled,
      inPage: () => {
        const route = router?.current();
        return Boolean(route && (route.permalink || route.type === 'photo'));
      },
      onClick: () => {
        opened++;
        diagnostics?.changed();
      },
    });
    diagnostics?.add('Reply threads opened', () => String(opened));
    const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    const observer = new Observer(() => expander.wake());
    const begin = () => observer.observe(doc.body, { childList: true, subtree: true });
    whenBodyReady(begin, doc);
  },
};
