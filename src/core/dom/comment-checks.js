// Runs one feature's check on each comment on the page (posts.js isComment), which the post
// tracker leaves out. A comment is looked at when it's drawn and again when anything in it
// changes, since a long one fills in after See more. check(comment) returns true once it's done
// with that comment (hidden, say), and it isn't looked at again until recheckAll(). Changes are
// gathered and looked at once a frame.
//
// The observer starts the first time recheckAll() finds the check on, so a page where it never
// is pays nothing.

import { whenRootReady } from '../env.js';
import { isComment } from './posts.js';

const ARTICLE = '[role="article"]';

export function watchCommentChecks({ doc, enabled, check }) {
  let done = new WeakSet();
  const touched = new Set();
  let queued = false;
  let observer = null;
  const view = doc.defaultView;
  const frame = view?.requestAnimationFrame ? (fn) => view.requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16);

  function run(article) {
    if (done.has(article) || !article.isConnected || !isComment(article)) return;
    if (check(article)) done.add(article);
  }

  function flush() {
    queued = false;
    const batch = [...touched];
    touched.clear();
    if (!enabled()) return;
    for (const article of batch) run(article);
  }

  // What a change touched: the comment it happened in, and any comments it added.
  function note(node, added) {
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element) return;
    const holder = element.closest(ARTICLE);
    if (holder) touched.add(holder);
    if (!added || node.nodeType !== 1) return;
    for (const article of element.querySelectorAll(ARTICLE)) touched.add(article);
  }

  function start() {
    if (observer) return;
    const Observer = view?.MutationObserver ?? globalThis.MutationObserver;
    observer = new Observer((records) => {
      if (!enabled()) return;
      for (const record of records) {
        note(record.target, false);
        for (const node of record.addedNodes) note(node, true);
      }
      if (!touched.size || queued) return;
      queued = true;
      frame(flush);
    });
    whenRootReady(() => observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true }), doc);
  }

  return {
    // A fresh look at every comment, after the lists or the switch changed.
    recheckAll() {
      done = new WeakSet();
      if (!enabled()) return;
      start();
      for (const article of doc.querySelectorAll(ARTICLE)) run(article);
    },
    stop() {
      observer?.disconnect();
      touched.clear();
    },
  };
}
