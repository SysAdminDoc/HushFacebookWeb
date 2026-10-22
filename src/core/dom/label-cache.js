// Short texts of elements with an id, remembered the moment they're added to the page.
//
// Facebook points a post's "Sponsored" label at text elsewhere (aria-labelledby, an SVG
// <use href="#id">) and removes that text within a frame, so by the time a post is checked
// the target is gone. The observer callback runs before that, so it records the text then.
// The idea is FB Feed Filter 0.1.0.17's ephemeral label cache (content.js 1172-1203, MIT,
// see THIRD_PARTY_NOTICES.txt). It watches from the document's root, not its body: the first
// screen of Home streams in as finished HTML before the body is complete, labels and all.

import { whenRootReady } from '../env.js';
import { normalizeText } from './visible-text.js';

const MAX_TEXT = 40;

export function createLabelCache({ doc = globalThis.document, max = 500 } = {}) {
  const texts = new Map();
  let observer = null;

  function record(element) {
    if (!element.id) return;
    const text = normalizeText(element.textContent);
    if (!text || text.length > MAX_TEXT) return;
    texts.delete(element.id);
    texts.set(element.id, text);
    if (texts.size > max) texts.delete(texts.keys().next().value);
  }

  function capture(node) {
    if (node?.nodeType !== 1) return;
    record(node);
    for (const element of node.querySelectorAll('[id]')) record(element);
  }

  return {
    capture,
    get: (id) => texts.get(id) ?? null,
    get size() {
      return texts.size;
    },
    start() {
      if (observer) return;
      const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
      observer = new Observer((records) => {
        for (const entry of records) for (const node of entry.addedNodes) capture(node);
      });
      const begin = () => {
        if (!observer) return; // stopped before the page had a root
        observer.observe(doc.documentElement, { childList: true, subtree: true });
        capture(doc.documentElement);
      };
      whenRootReady(begin, doc);
    },
    stop() {
      observer?.disconnect();
      observer = null;
    },
  };
}
