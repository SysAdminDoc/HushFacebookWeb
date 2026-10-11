// Finds posts on the page as Facebook draws them and tells features when one appears or
// goes away. Facebook's feed has no role=feed and no data-pagelet any more (live
// 2026-10-10): feed posts are div[aria-posinset], and role=article marks permalink posts and,
// mostly, comments. Candidates go through sanity checks in the spirit of Social Fixer's post
// processor before they count:
//   nested    inside another candidate (a shared post's attached story, a comment in a post)
//   form      inside a <form> (the composer's preview)
//   comment   a role=article whose own links carry comment_id, or labeled "Comment by"
//   loading   a skeleton (a progressbar and no links yet), checked again when it fills in
//   empty     nothing drawn inside yet, checked again when it fills in
//
// Nothing is ever written on the page. Processed posts live in a WeakSet, because attributes
// on the feed's own children have been seen to stall infinite scroll.
//
// The observer starts with the first subscriber, so the page pays nothing until a feature
// needs posts.

export const CANDIDATE_SELECTOR = '[aria-posinset], [role="article"]';

// Which links say which post this is, best first. A link that carries comment_id points at
// a comment, so it only counts on the last rung.
const ID_RUNGS = [
  { source: 'permalink', re: /\/(?:posts|permalink)\/(pfbid0[A-Za-z0-9]+|\d+)/ },
  { source: 'pfbid', re: /(pfbid0[A-Za-z0-9]+)/ },
  { source: 'story_fbid', re: /[?&]story_fbid=(pfbid0[A-Za-z0-9]+|\d+)/ },
];
const COMMENT_ID = /[?&](?:reply_comment_id|comment_id)=(\d+)/;
const COMMENT_LABEL = /^(?:comment|reply) by /i;

const ownerOf = (node) => node.closest(CANDIDATE_SELECTOR);

// Links that belong to this candidate and not to a post or comment nested inside it.
export function ownLinks(element) {
  return [...element.querySelectorAll('a[href]')].filter((a) => ownerOf(a) === element);
}

export function postIdFromHrefs(hrefs) {
  const postLinks = hrefs.filter((href) => !COMMENT_ID.test(href));
  for (const { source, re } of ID_RUNGS) {
    for (const href of postLinks) {
      const found = href.match(re);
      if (found) return { id: found[1], source };
    }
  }
  for (const href of hrefs) {
    const found = href.match(COMMENT_ID);
    if (found) return { id: found[1], source: 'comment_id' };
  }
  return { id: null, source: null };
}

export function postIdOf(element) {
  return postIdFromHrefs(ownLinks(element).map((a) => a.getAttribute('href')));
}

function isComment(element) {
  if (element.getAttribute('role') !== 'article') return false;
  if (COMMENT_LABEL.test(element.getAttribute('aria-label') ?? '')) return true;
  return ownLinks(element).some((a) => COMMENT_ID.test(a.getAttribute('href')));
}

// { ok: true, kind } for a post, or { ok: false, reason, retry } where retry means the
// candidate may still become a post once Facebook fills it in.
export function classifyCandidate(element) {
  if (!element.isConnected) return { ok: false, reason: 'detached', retry: false };
  if (element.parentElement && ownerOf(element.parentElement)) return { ok: false, reason: 'nested', retry: false };
  if (element.closest('form')) return { ok: false, reason: 'form', retry: false };
  if (isComment(element)) return { ok: false, reason: 'comment', retry: false };
  const hasLinks = element.querySelector('a[href]') !== null;
  if (!hasLinks && element.querySelector('[role="progressbar"]')) return { ok: false, reason: 'loading', retry: true };
  if (!hasLinks && !element.textContent.trim() && !element.querySelector('img, video, svg')) return { ok: false, reason: 'empty', retry: true };
  return { ok: true, kind: element.hasAttribute('aria-posinset') ? 'feed' : 'article' };
}

export function createPostTracker({ doc = globalThis.document, log } = {}) {
  const processed = new WeakSet();
  const live = new Map(); // element -> post record, so removals can be reported
  const listeners = { 'post/add': new Set(), 'post/update': new Set(), 'post/remove': new Set(), reset: new Set() };
  let observer = null;

  function call(type, listener, payload) {
    try {
      listener(payload);
    } catch (error) {
      log?.error(`A ${type} listener failed`, error);
    }
  }

  function emit(type, payload) {
    for (const listener of listeners[type]) call(type, listener, payload);
  }

  function remove(element, post) {
    live.delete(element);
    processed.delete(element);
    emit('post/remove', post);
  }

  // A post already seen gets its id checked again: Facebook fills in timestamp links late,
  // and it reuses a post's element for a different story when it recycles the feed.
  function recheck(element) {
    const post = live.get(element);
    const hrefs = ownLinks(element).map((a) => a.getAttribute('href'));
    const { id, source } = postIdFromHrefs(hrefs);
    if (id === post.id || id === null) return;
    if (post.id === null) {
      post.id = id;
      post.idSource = source;
      emit('post/update', post);
      return;
    }
    // A better link turned up for the same story. Keep the id features already know.
    if (hrefs.some((href) => href.includes(post.id))) return;
    remove(element, post);
    add(element, post.kind);
  }

  function add(element, kind) {
    const { id, source } = postIdOf(element);
    const post = { element, kind, id, idSource: source };
    processed.add(element);
    live.set(element, post);
    emit('post/add', post);
  }

  function consider(element) {
    if (processed.has(element)) {
      if (live.has(element)) recheck(element);
      return;
    }
    const verdict = classifyCandidate(element);
    if (verdict.ok) add(element, verdict.kind);
  }

  function scan(root) {
    if (root.nodeType !== 1) root = root.parentElement;
    if (!root) return;
    const found = new Set();
    const owner = ownerOf(root);
    if (owner) found.add(owner);
    for (const element of root.querySelectorAll(CANDIDATE_SELECTOR)) found.add(element);
    for (const element of found) consider(element);
  }

  function sweepRemovals() {
    if (!live.size) return;
    for (const [element, post] of [...live]) if (!element.isConnected) remove(element, post);
    if (!live.size) emit('reset', undefined);
  }

  function onMutations(records) {
    const roots = new Set();
    let removals = false;
    for (const record of records) {
      if (record.removedNodes.length) removals = true;
      if (record.addedNodes.length) for (const node of record.addedNodes) roots.add(node);
      else if (record.type === 'attributes') roots.add(record.target);
    }
    if (removals) sweepRemovals();
    for (const root of roots) if (root.isConnected) scan(root);
  }

  function start() {
    if (observer) return;
    const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    observer = new Observer((records) => {
      try {
        onMutations(records);
      } catch (error) {
        log?.error('Reading new posts failed', error);
      }
    });
    const begin = () => {
      observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
      scan(doc.body);
    };
    if (doc.body) begin();
    else doc.addEventListener('DOMContentLoaded', begin, { once: true });
  }

  return {
    // type: 'post/add' | 'post/update' | 'post/remove' | 'reset'. Returns an unsubscribe.
    // A post/add listener that joins late hears about the posts already on the page first.
    on(type, listener) {
      if (!listeners[type]) throw new Error(`Unknown post event: ${type}`);
      listeners[type].add(listener);
      if (!observer) start();
      else if (type === 'post/add') for (const post of [...live.values()]) call(type, listener, post);
      return () => listeners[type].delete(listener);
    },
    current: () => [...live.values()],
    stop() {
      observer?.disconnect();
      observer = null;
    },
  };
}
