// Part of Hushfacebook's Comment sheet options on Android: the comment box without its GIF,
// sticker and avatar sticker buttons. Live 2026-10-11 (captures/2026-10-11-run12 and run13, two
// Page posts and two group posts): a comment box is a form[role=presentation] holding the text
// box, and its buttons are role=button with aria-haspopup. Avatar sticker, GIF and sticker draw a
// sprite icon (an <i> with a background image), while emoji draws an svg and Post comment has no
// pop-up. That tells them apart in any language, without class names or labels.
//
// Only comment boxes on a post count (in a feed post, a post's page or a post opened over the
// feed), so a chat window's own GIF and sticker buttons are never touched. Works in content mode.

import { whenBodyReady } from '../../core/env.js';

export const MARK = 'data-hfw-comment-sticker';
const FORMS = 'form[role="presentation"]';
const BUTTONS = '[role="button"][aria-haspopup]';
const DELAY = 200;

export const HIDE_STICKERS_CSS = `[${MARK}] { display: none !important; }`;

// A comment box: the form around a text box, on a post.
export function isCommentForm(form) {
  if (!form.querySelector('[role="textbox"][contenteditable="true"]')) return false;
  if (form.closest('[role="main"], [aria-posinset], [role="article"]')) return true;
  return Boolean(form.closest('[role="dialog"]')?.querySelector('[role="article"]'));
}

// GIF, sticker and avatar sticker: a pop-up button whose icon is a sprite, not an svg.
export const isStickerButton = (button) => Boolean(button.querySelector('i')) && !button.querySelector('svg');

export function markStickerButtons(doc) {
  let marked = 0;
  for (const form of doc.querySelectorAll(FORMS)) {
    if (!isCommentForm(form)) continue;
    for (const button of form.querySelectorAll(BUTTONS)) {
      if (button.hasAttribute(MARK) || !isStickerButton(button)) continue;
      button.setAttribute(MARK, '');
      marked++;
    }
  }
  return marked;
}

export function createStickerHider({ doc, enabled, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
  let timer = null;
  let hidden = 0;

  function sync() {
    timer = null;
    if (!enabled()) {
      for (const button of doc.querySelectorAll(`[${MARK}]`)) button.removeAttribute(MARK);
      return;
    }
    hidden += markStickerButtons(doc);
  }

  const schedule = () => {
    timer ??= setTimer(sync, DELAY);
  };

  return {
    start() {
      const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
      new Observer(() => {
        if (enabled()) schedule();
      }).observe(doc.body, { childList: true, subtree: true });
      sync();
    },
    sync,
    schedule,
    hidden: () => hidden,
  };
}

export default {
  id: 'hideCommentStickers',
  section: 'comments',
  android: 'Comment sheet options',
  title: 'Hide GIF and sticker buttons',
  description: 'Takes the GIF, sticker and avatar sticker buttons out of the comment box under posts. The emoji button stays, and only comment boxes on posts are touched.',
  default: false,
  css: HIDE_STICKERS_CSS,

  setup({ doc, settings, diagnostics, enabled }) {
    const hider = createStickerHider({ doc, enabled });
    const begin = () => hider.start();
    whenBodyReady(begin, doc);
    settings?.subscribe(() => hider.schedule());
    diagnostics?.add('Comment box buttons hidden', () => String(hider.hidden()));
  },
};
