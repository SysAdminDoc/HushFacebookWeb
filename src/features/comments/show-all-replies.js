// Show every reply, part of Hushfacebook's Comment sheet options on Android. Facebook folds
// replies behind "View 3 replies" and "View more replies" buttons; each one fetches its replies
// on its own (Depth1CommentsListPaginationQuery, seen live 2026-10-11), so the script clicks
// them as they appear. It works in rounds a moment apart and rests after five rounds in a row
// with nothing to open, until the page changes again. A button is clicked once for each thing
// it says, so one Facebook reuses for the next page of replies is clicked again, up to a few
// times.
//
// Same reach as Default comment order: a post's own page, a photo's page and a post opened
// over the feed. The buttons are told apart by their English text for now.

import { normalizeText } from '../../core/dom/visible-text.js';

export const REPLY_BUTTON = /^(?:view (?:all )?[\d.,]+k? (?:more )?repl(?:y|ies)|view more repl(?:y|ies)|[\d.,]+k? repl(?:y|ies))$/i;
const PER_ROUND = 3;
const PER_BUTTON = 5;

export function createReplyExpander({ doc, win = globalThis, inPage, enabled, onClick, idleLimit = 5, delay = 800, maxClicks = 300 }) {
  const clicked = new WeakMap(); // button -> { text, times }
  let idle = 0;
  let timer = null;
  let total = 0;

  function candidates() {
    const dialogs = [...doc.querySelectorAll('[role="dialog"]')];
    const scopes = [...dialogs];
    // A post opened from its link shows in a dialog over Home, and the feed's copy of it behind
    // the dialog has folded replies of its own (seen live 2026-10-11). Those are the feed's.
    const postOpen = dialogs.some((dialog) => dialog.querySelector('[role="article"]'));
    if (inPage() && doc.body && !postOpen) scopes.push(doc.body);
    const found = new Set();
    for (const scope of scopes) {
      for (const button of scope.querySelectorAll('[role="button"]')) {
        const text = normalizeText(button.textContent);
        const before = clicked.get(button);
        if (before && (before.text === text || before.times >= PER_BUTTON)) continue;
        if (REPLY_BUTTON.test(text)) found.add(button);
      }
    }
    return [...found];
  }

  function schedule() {
    if (!timer) timer = win.setTimeout(round, delay);
  }

  function round() {
    timer = null;
    if (!enabled() || total >= maxClicks) return;
    const buttons = candidates();
    if (!buttons.length) {
      idle++;
      if (idle < idleLimit) schedule();
      return;
    }
    idle = 0;
    for (const button of buttons.slice(0, Math.min(PER_ROUND, maxClicks - total))) {
      clicked.set(button, { text: normalizeText(button.textContent), times: (clicked.get(button)?.times ?? 0) + 1 });
      button.click();
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
    state: () => ({ idle, total, running: Boolean(timer) }),
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
