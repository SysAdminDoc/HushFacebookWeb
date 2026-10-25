// Finds posts on the page as Facebook draws them and tells features when one appears or
// goes away. Facebook's feed has no role=feed and no data-pagelet any more (live
// 2026-10-10): feed posts are div[aria-posinset], and role=article marks permalink posts and,
// mostly, comments. Candidates go through sanity checks in the spirit of Social Fixer's post
// processor before they count:
//   nested    inside another candidate (a shared post's attached story, a comment in a post)
//   form      inside a <form> (the composer's preview)
//   comment   a role=article whose own links carry comment_id, or labeled "Comment by"
//   loading   a skeleton (a progressbar or a loading-state card, and no links yet), checked
//             again when it fills in
//   empty     nothing drawn inside yet, checked again when it fills in
//
// Nothing is ever written on the page. Processed posts live in a WeakSet, because attributes
// on the feed's own children have been seen to stall infinite scroll.
//
// The observer starts with the first subscriber, so the page pays nothing until a feature
// needs posts. It watches from the document's root, not its body: Home's first posts stream
// in as finished HTML a second or more before DOMContentLoaded (live 2026-10-21).

import { whenRootReady } from '../env.js';

// Feed posts are plain div[aria-posinset]. aria-posinset on something with another role
// (a list option, a carousel item) is a widget, not a post.
export const CANDIDATE_SELECTOR = '[aria-posinset]:not([role]), [role="article"]';

// Which links say which post this is, best first. Comment parameters are dropped before
// matching, since a link to a comment still names its post; comment_id itself only counts
// on the last rung.
const ID_RUNGS = [
  { source: 'permalink', re: /\/(?:posts|permalink)\/(pfbid0[A-Za-z0-9]+|\d+)/ },
  { source: 'pfbid', re: /(pfbid0[A-Za-z0-9]+)/ },
  { source: 'story_fbid', re: /[?&]story_fbid=(pfbid0[A-Za-z0-9]+|\d+)/ },
];
const COMMENT_ID = /[?&](?:reply_comment_id|comment_id)=(\d+)/;
const COMMENT_PARAM = /([?&])(?:reply_comment_id|comment_id)=\d+(&|$)/;
const COMMENT_LABEL = /^(?:comment|reply) by /i;
// Only facebook.com's own links say which post this is. A link out ("blog.example/posts/2024")
// or through l.facebook.com never does.
// Locale hosts (en-gb.facebook.com), an explicit :443 and protocol-relative links count too.
const FACEBOOK_LINK = /^(?:\/(?!\/)|\?|(?:https?:)?\/\/(?:(?:www|web|m|mbasic|[a-z]{2}-[a-z]{2})\.)?facebook\.com(?::443)?(?:\/|$))/i;
// Links inside the post's text point at other things, so they never name the post.
const MESSAGE_REGION = '[data-ad-rendering-role="story_message"], [data-ad-preview="message"]';

// Facebook's gray loading cards are a role=article holding a role=status loading-state box
// (live 2026-10-22, Home and groups). Bare, they'd pass as empty anyway, but a shimmer or a
// "Loading..." line drawn inside one must not make it a post.
const LOADING = '[role="progressbar"], [data-visualcompletion="loading-state"]';

const ownerOf = (node) => node.closest(CANDIDATE_SELECTOR);

// Links that belong to this candidate and not to a post or comment nested inside it.
export function ownLinks(element) {
  return [...element.querySelectorAll('a[href]')].filter((a) => ownerOf(a) === element);
}

// One parameter at a time: two in a row share the "&" between them.
function withoutCommentParams(href) {
  let previous;
  do {
    previous = href;
    href = href.replace(COMMENT_PARAM, (match, lead, tail) => (tail ? lead : ''));
  } while (href !== previous);
  return href;
}

export function postIdFromHrefs(hrefs) {
  const links = hrefs.filter((href) => FACEBOOK_LINK.test(href));
  const withoutComments = links.map(withoutCommentParams);
  for (const { source, re } of ID_RUNGS) {
    for (const href of withoutComments) {
      const found = href.match(re);
      if (found) return { id: found[1], source };
    }
  }
  for (const href of links) {
    const found = href.match(COMMENT_ID);
    if (found) return { id: found[1], source: 'comment_id' };
  }
  return { id: null, source: null };
}

// The hrefs that can name this post: its own links, minus the ones in its text.
function idHrefs(element) {
  return ownLinks(element)
    .filter((a) => {
      const region = a.closest(MESSAGE_REGION);
      return !region || !element.contains(region);
    })
    .map((a) => a.getAttribute('href'));
}

export function postIdOf(element) {
  return postIdFromHrefs(idHrefs(element));
}

export function isComment(element) {
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
  if (!hasLinks && element.querySelector(LOADING)) return { ok: false, reason: 'loading', retry: true };
  if (!hasLinks && !element.textContent.trim() && !element.querySelector('img, video, svg')) return { ok: false, reason: 'empty', retry: true };
  return { ok: true, kind: element.hasAttribute('aria-posinset') ? 'feed' : 'article' };
}

export function createPostTracker({ doc = globalThis.document, log } = {}) {
  let processed = new WeakSet();
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
    // A post moved into another tracked post is part of that one now too.
    if (element.parentElement && ownerOf(element.parentElement)) {
      remove(element, post);
      return;
    }
    const hrefs = idHrefs(element);
    const { id, source } = postIdFromHrefs(hrefs);
    if (id === post.id || id === null) return;
    if (post.id === null) {
      post.id = id;
      post.idSource = source;
      emit('post/update', post);
      return;
    }
    // A comment link was all there was, and the post's own link turned up beside it. When
    // the comment link is gone too, Facebook reused the element for another story.
    if (post.idSource === 'comment_id' && source !== 'comment_id' && hrefs.some((href) => href.includes(post.id))) {
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
    // A post drawn first and wrapped by another one afterwards is part of the outer post now.
    for (const inner of element.querySelectorAll(CANDIDATE_SELECTOR)) {
      const nested = live.get(inner);
      if (!nested) continue;
      // It can stand on its own again if Facebook later moves it out of this wrapper.
      remove(inner, nested);
    }
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

  // Adds the candidates a changed node can affect: the post it sits in and any inside it.
  function collect(root, found) {
    if (root.nodeType !== 1) root = root.parentElement;
    if (!root?.isConnected) return;
    const owner = ownerOf(root);
    if (owner) found.add(owner);
    for (const element of root.querySelectorAll(CANDIDATE_SELECTOR)) found.add(element);
  }

  function scan(root) {
    const found = new Set();
    collect(root, found);
    for (const element of found) consider(element);
  }

  function sweepRemovals() {
    if (!live.size) return;
    for (const [element, post] of [...live]) if (!element.isConnected) remove(element, post);
    if (!live.size) emit('reset', undefined);
  }

  // A post that lost its aria-posinset or gained a role isn't a post any more. Posts it had
  // taken in when it wrapped them stand on their own again.
  function release(element, found) {
    const post = live.get(element);
    if (!post || element.matches(CANDIDATE_SELECTOR)) return;
    remove(element, post);
    for (const inner of element.querySelectorAll(CANDIDATE_SELECTOR)) {
      processed.delete(inner);
      found.add(inner);
    }
  }

  // Each post is looked at once per batch, however many of its nodes changed.
  function onMutations(records) {
    let removals = false;
    const found = new Set();
    for (const record of records) {
      if (record.removedNodes.length) removals = true;
      if (record.addedNodes.length) for (const node of record.addedNodes) collect(node, found);
      else if (record.type === 'attributes') {
        release(record.target, found);
        collect(record.target, found);
      }
    }
    if (removals) sweepRemovals();
    for (const element of found) if (element.isConnected) consider(element);
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
      if (!observer) return; // stopped before the page had a root
      // href: timestamp links fill in late. aria-posinset and role: a node can become a post.
      observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'aria-posinset', 'role'] });
      scan(doc.documentElement);
    };
    whenRootReady(begin, doc);
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
    // Stops watching and forgets every post. A later on() starts over and reports them again.
    stop() {
      observer?.disconnect();
      observer = null;
      live.clear();
      processed = new WeakSet();
    },
  };
}
