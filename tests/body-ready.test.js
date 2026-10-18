// Waiting for the page's body. Firefox fires DOMContentLoaded on the document a document_start
// redirect leaves behind (Marketplace only) with no body at all, and observing that null body
// threw in every feature that watches the page (live 2026-10-17, Firefox 156). A fake document
// stands in, since happy-dom always has a body.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLabelCache } from '../src/core/dom/label-cache.js';
import { createPostTracker } from '../src/core/dom/posts.js';
import { whenBodyReady } from '../src/core/env.js';

// A document still loading. load() fires DOMContentLoaded, with a body or without one.
function loadingDoc() {
  const waiting = [];
  const observed = [];
  class MutationObserver {
    observe(target) {
      if (!target) throw new TypeError("MutationObserver.observe: Argument 1 is not an object.");
      observed.push(target);
    }
    disconnect() {}
  }
  const doc = {
    body: null,
    defaultView: { MutationObserver },
    observed,
    addEventListener(type, fn) {
      if (type === 'DOMContentLoaded') waiting.push(fn);
    },
    load(body = null) {
      doc.body = body;
      for (const fn of waiting.splice(0)) fn();
    },
  };
  return doc;
}

const body = () => ({ nodeType: 1, querySelectorAll: () => [] });

test('whenBodyReady runs at once on a page with a body and waits on one still loading', () => {
  const ready = loadingDoc();
  ready.body = body();
  let runs = 0;
  whenBodyReady(() => runs++, ready);
  assert.equal(runs, 1);

  const loading = loadingDoc();
  whenBodyReady(() => runs++, loading);
  assert.equal(runs, 1);
  loading.load(body());
  assert.equal(runs, 2);
});

test('a page that finishes loading with no body runs nothing', () => {
  const doc = loadingDoc();
  let runs = 0;
  whenBodyReady(() => runs++, doc);
  doc.load();
  assert.equal(runs, 0);
});

test('the post tracker and the label cache wait out a page with no body without throwing', () => {
  const empty = loadingDoc();
  createPostTracker({ doc: empty }).on('post/add', () => {});
  createLabelCache({ doc: empty }).start();
  assert.doesNotThrow(() => empty.load());
  assert.deepEqual(empty.observed, []);

  const page = loadingDoc();
  createPostTracker({ doc: page }).on('post/add', () => {});
  createLabelCache({ doc: page }).start();
  const loaded = body();
  page.load(loaded);
  assert.deepEqual(page.observed, [loaded, loaded]);
});
