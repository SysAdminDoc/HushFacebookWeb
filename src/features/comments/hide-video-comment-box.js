// Hushfacebook's Hide the video comment box on Android (2026-10-21) takes the Add a comment bar off
// its full-screen video viewer. The web's viewer is the page a video opens on: /<page>/videos/<id>/,
// where /watch/?v= lands too. Live 2026-10-22 signed out on a NASA video, the video sits in the
// WatchPermalinkVideo pagelet with its description under it, and the column beside them holds the
// post, its comments and, signed in, the box for writing one. That column is a sibling of one of
// the pagelet's first few ancestors, and the more-videos list under them is outside it, so comment
// boxes on those posts stay, like every other comment box. The box is the one posts use
// (hide-comment-stickers.js): a form[role=presentation] around a contenteditable text box. Works in
// content mode.

import { whenBodyReady } from '../../core/env.js';

export const MARK = 'data-hfw-video-comment-box';
const VIDEO = '[data-pagelet="WatchPermalinkVideo"]';
const FORMS = 'form[role="presentation"]';
const LEVELS = 4;
const DELAY = 200;

export const HIDE_VIDEO_COMMENT_BOX_CSS = `[${MARK}] { display: none !important; }`;

const isBox = (form) => Boolean(form.querySelector('[role="textbox"][contenteditable="true"]'));
const boxesIn = (root) => [...root.querySelectorAll(FORMS)].filter(isBox);

// The column beside a video viewer's video: going up from its pagelet, the first sibling that holds
// comments or a comment box.
export function commentColumns(doc) {
  const columns = [];
  for (const video of doc.querySelectorAll(VIDEO)) {
    let node = video;
    let column = null;
    for (let level = 0; !column && node.parentElement && level < LEVELS; level++, node = node.parentElement) {
      column = [...node.parentElement.children].find((sibling) => sibling !== node && (sibling.querySelector('[role="article"]') || boxesIn(sibling).length)) ?? null;
    }
    if (column) columns.push(column);
  }
  return columns;
}

// Marks the comment boxes beside a video, and lets go of any that aren't there any more.
// Returns how many it newly marked.
export function markVideoCommentBoxes(doc) {
  const columns = commentColumns(doc);
  for (const form of doc.querySelectorAll(`[${MARK}]`)) {
    if (!columns.some((column) => column.contains(form))) form.removeAttribute(MARK);
  }
  let marked = 0;
  for (const column of columns) {
    for (const form of boxesIn(column)) {
      if (form.hasAttribute(MARK)) continue;
      form.setAttribute(MARK, '');
      marked++;
    }
  }
  return marked;
}

export function createVideoCommentBoxHider({ doc, enabled, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
  let timer = null;
  let hidden = 0;

  function sync() {
    timer = null;
    if (!enabled()) {
      for (const form of doc.querySelectorAll(`[${MARK}]`)) form.removeAttribute(MARK);
      return;
    }
    hidden += markVideoCommentBoxes(doc);
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
  id: 'hideVideoCommentBox',
  section: 'comments',
  android: 'Hide the video comment box',
  title: 'Hide the video comment box',
  description: 'When a video opens on its own page, with its comments beside it, the box for writing a comment there goes away. Comment boxes under posts stay.',
  default: false,
  css: HIDE_VIDEO_COMMENT_BOX_CSS,

  setup({ doc, settings, diagnostics, enabled }) {
    const hider = createVideoCommentBoxHider({ doc, enabled });
    whenBodyReady(() => hider.start(), doc);
    settings?.subscribe(() => hider.schedule());
    diagnostics?.add('Video comment boxes hidden', () => String(hider.hidden()));
  },
};
