// Waiting for the page's body or root. Firefox fires DOMContentLoaded on the document a
// document_start redirect leaves behind (Marketplace only) with no body at all, and observing
// that null body threw in every feature that watches the page (live 2026-10-17, Firefox 156).
// A fake document stands in, since happy-dom always has a body.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLabelCache } from '../src/core/dom/label-cache.js';
import { createPostTracker } from '../src/core/dom/posts.js';
import { whenBodyReady } from '../src/core/env.js';

// A document still loading. root() gives it its <html>, load() fires DOMContentLoaded, with a
// body or without one.
function loadingDoc() {
  const waiting = [];
  const observed = [];
  const watching = [];
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe(target) {
      if (!target) throw new TypeError("MutationObserver.observe: Argument 1 is not an object.");
      observed.push(target);
      watching.push([target, this]);
    }
    disconnect() {
      for (let i = watching.length - 1; i >= 0; i--) if (watching[i][1] === this) watching.splice(i, 1);
    }
  }
  const doc = {
    body: null,
    documentElement: null,
    defaultView: { MutationObserver },
    observed,
    addEventListener(type, fn) {
      if (type === 'DOMContentLoaded') waiting.push(fn);
    },
    root(element) {
      doc.documentElement = element;
      for (const [target, observer] of [...watching]) if (target === doc) observer.callback([]);
    },
    load(body = null) {
      doc.body = body;
      for (const fn of waiting.splice(0)) fn();
    },
  };
  return doc;
}

const body = () => ({ nodeType: 1, querySelectorAll: () => [] });
const html = () => ({ nodeType: 1, isConnected: true, id: '', textContent: '', closest: () => null, querySelectorAll: () => [] });

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

// Home's first posts stream in as finished HTML a second before DOMContentLoaded (live
// 2026-10-21), so the post tracker and the label cache watch from the root, not the body.
test('the post tracker and the label cache start on the root, before there is a body', () => {
  const doc = loadingDoc();
  createPostTracker({ doc }).on('post/add', () => {});
  createLabelCache({ doc }).start();
  assert.deepEqual(doc.observed, [doc, doc], 'both wait for the root');
  const root = html();
  doc.root(root);
  assert.deepEqual(doc.observed.slice(2), [root, root]);
  // The leftover redirect page that never gets a body is no trouble.
  assert.doesNotThrow(() => doc.load());
  assert.equal(doc.observed.length, 4);
});

test('stopped before the root came, the post tracker and the label cache never start', () => {
  const doc = loadingDoc();
  const tracker = createPostTracker({ doc });
  tracker.on('post/add', () => {});
  tracker.stop();
  const cache = createLabelCache({ doc });
  cache.start();
  cache.stop();
  assert.doesNotThrow(() => doc.root(html()));
  assert.deepEqual(doc.observed, [doc, doc]);
});
