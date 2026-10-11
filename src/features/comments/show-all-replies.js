// Show every reply, part of Hushfacebook's Comment sheet options on Android. Facebook folds
// replies behind "View 3 replies" and "View more replies" buttons; each one fetches its replies
// on its own (Depth1CommentsListPaginationQuery, seen live 2026-10-11), so the script clicks
// them as they appear. It works in rounds a moment apart and rests after five rounds in a row
// with nothing to open, until the page changes again.
//
// A button is clicked again when it says something new. "View more replies" is also tried
// again a few rounds later if it still says that, since Facebook can keep it on one element
// while it loads the next page; a counted one like "12 Replies" isn't, as a second click could
// fold the thread back up. Five times at most. Each post, meaning each dialog or page address,
// gets its own budget of clicks, so a long visit never runs dry.
//
// Same reach as Default comment order: a post's own page, a photo's page and a post opened
// over the feed. The buttons are told apart by their English text for now.

import { normalizeText } from '../../core/dom/visible-text.js';
import { dialogOpen } from './post-dialog.js';

export const REPLY_BUTTON = /^(?:view (?:all )?[\d.,]+k? (?:more )?repl(?:y|ies)|view more repl(?:y|ies)|[\d.,]+k? repl(?:y|ies))$/i;
const PER_ROUND = 3;
const PER_BUTTON = 5;
const RETRY_ROUNDS = 3;
const MORE_PAGES = /^view more repl/i;

export function createReplyExpander({ doc, win = globalThis, inPage, enabled, onClick, idleLimit = 5, delay = 800, maxClicks = 300 }) {
  const clicked = new WeakMap(); // button -> { text, times, round }
  const spentInDialog = new WeakMap();
  const spentOnPage = new Map();
  let idle = 0;
  let timer = null;
  let rounds = 0;
  let total = 0;

  const address = () => doc.location?.href ?? '';
  const spent = (scope) => (scope === doc.body ? spentOnPage.get(address()) : spentInDialog.get(scope)) ?? 0;
  function spend(scope) {
    if (scope === doc.body) spentOnPage.set(address(), spent(scope) + 1);
    else spentInDialog.set(scope, spent(scope) + 1);
  }

  function ready(button, text) {
    const before = clicked.get(button);
    if (!before) return true;
    if (before.times >= PER_BUTTON) return false;
    return before.text !== text || (MORE_PAGES.test(text) && rounds - before.round >= RETRY_ROUNDS);
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
        if (REPLY_BUTTON.test(text) && ready(button, text)) found.set(button, scope);
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
      clicked.set(button, { text: normalizeText(button.textContent), times: (clicked.get(button)?.times ?? 0) + 1, round: rounds });
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
  description: "Opens every folded reply under comments on a post's own page and when you open a post's comments from the feed, so you don't have to click View replies. English Facebook only for now.",
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
    if (doc.body) begin();
    else doc.addEventListener('DOMContentLoaded', begin, { once: true });
  },
};
