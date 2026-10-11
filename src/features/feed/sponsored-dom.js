/*! HushFacebook Web: the page-side ad check below follows FB Feed Filter 0.1.0.17
 * (core.js AD_LABEL_KINDS, groupGlyphRecords, candidateGlyphStrings, decodeExactAdLabel,
 * matchesAdDisclosureUrl, isFacebookGroupStoryHref; content.js HEADER_EXCLUSIONS,
 * isHeaderGeometry, glyphRecordsFor, hasScrambledLabelStructure, labelledReferenceLabel,
 * referencedSvgLabel, hasGroupOrigin, hiddenByAncestors).
 *
 * MIT License
 *
 * Copyright (c) 2026 Facebook Feed Filter Companion contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify, merge,
 * publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
 * to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
 * PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
 * FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */

// Ads that reach the page anyway (a shape the data rules don't know yet, or content mode,
// where the data layer can't run) are caught by what Facebook has to show: the ad label in
// the post's header. Signals, first match wins:
//   header label   the exact label as visible text in the header region
//   labelledby     an aria-labelledby target's text, read live or from the label cache
//   svg            an SVG <text>, or a <use href="#id"> target, live or cached
//   glyph order    letters split into spans and shuffled with flex `order`, put back in
//                  order (live 2026-10-10: the label's letters come scrambled this way, with
//                  absolutely positioned decoys among them)
//   ads link       a link to facebook.com/ads/about in the header
// An ad button (data-ad-rendering-role="cta-...") never hides a post by itself: Pages post
// with buttons in groups, and reshares carry the original's button. It only corroborates.
// Labels are matched exactly, never as a substring, and never in headings or the author's
// name, so a post that says "Sponsored by my mom" or a Page called "Ad" stays.

import { CANDIDATE_SELECTOR } from '../../core/dom/posts.js';
import { hasBox, isHidden, normalizeText, ownText, visibleText } from '../../core/dom/visible-text.js';

// English first. A table per language comes later.
const AD_LABELS = new Map([
  ['ad', 'Ad'],
  ['advertiser link', 'Ad'],
  ['paid', 'Ad'],
  ['paid partnership', 'Ad'],
  ['sponsored', 'Sponsored'],
]);

export function adLabel(value) {
  const key = normalizeText(value).replace(/^[·•]\s*/, '').replace(/\s*[·•]$/, '').toLowerCase();
  return AD_LABELS.has(key) ? key : null;
}

const HEADER_EXCLUSIONS = [
  'story_message', 'title', 'description', 'like_button', 'comment_button', 'share_button',
].map((role) => `[data-ad-rendering-role="${role}"]`).join(', ') + ', [data-ad-rendering-role^="cta"]';
const BODY_START = '[data-ad-rendering-role="story_message"], [data-ad-rendering-role="title"], video, img[src]';
const NOT_A_LABEL = 'h1, h2, h3, h4, h5, h6, [role="heading"], [data-ad-rendering-role="profile_name"]';
const CTA = '[data-ad-rendering-role^="cta"]';
const MAX_LABEL = 24;
// Decoy letters pad a label's source text, so the cap on it is looser than on the label.
const MAX_SOURCE = 400;

const ownerOf = (element) => element.closest(CANDIDATE_SELECTOR);
// A title or the author's name is never a label, even one that reads "Ad" (a Page can be
// called that).
const namesSomeone = (element) => Boolean(element?.closest(NOT_A_LABEL) || element?.querySelector?.(NOT_A_LABEL));
const within = (element, post, selector) => {
  const found = element.closest(selector);
  return Boolean(found && post.contains(found));
};

// Is this element in the post's header: the author row and its byline? With layout, that's
// the top 115 to 230 px of the post; without (tests, or a post not drawn yet), anything
// before the post's text or first picture.
function headerTest(post) {
  const postRect = post.getBoundingClientRect();
  const layout = hasBox(postRect);
  const bodyStart = post.querySelector(BODY_START);
  const headerBottom = postRect.top + Math.min(230, Math.max(115, postRect.height * 0.28));
  return (element) => {
    if (ownerOf(element) !== post || within(element, post, HEADER_EXCLUSIONS)) return false;
    if (layout) {
      const rect = element.getBoundingClientRect();
      if (hasBox(rect)) {
        return rect.top >= postRect.top - 4 && rect.top <= headerBottom
          && rect.left >= postRect.left - 8 && rect.right <= postRect.right + 8;
      }
    }
    return !bodyStart || Boolean(element.compareDocumentPosition(bodyStart) & 4) || element.contains(bodyStart);
  };
}

const styleOf = (element) => element.ownerDocument.defaultView.getComputedStyle(element);

// One glyph per leaf span, with where it's drawn and its flex order.
export function glyphRecords(container, { layout, accept = null }) {
  const box = layout ? container.getBoundingClientRect() : null;
  const records = [];
  for (const leaf of [...container.querySelectorAll('span, div')].slice(0, 180)) {
    if (leaf.children.length) continue;
    const text = ownText(leaf);
    if (!text || text.length > 3 || isHidden(leaf, container) || (accept && !accept(leaf))) continue;
    const style = styleOf(leaf);
    if (style.position === 'absolute' || style.position === 'fixed') continue;
    const order = Number.parseFloat(style.order);
    const record = { text, left: Number.NaN, top: Number.NaN, order: Number.isFinite(order) ? order : null };
    if (layout) {
      const rect = [...leaf.getClientRects()].find((r) => hasBox(r)
        && r.right >= box.left - 2 && r.left <= box.right + 2 && r.bottom >= box.top - 2 && r.top <= box.bottom + 2);
      if (!rect) continue; // zero size or drawn outside the label: a decoy
      record.left = rect.left;
      record.top = rect.top;
    }
    records.push(record);
    if (records.length > 40) break;
  }
  return records;
}

// The strings the glyphs can spell: each drawn row left to right, each row by flex order,
// and all of them by flex order. Flex order only counts when it actually reorders something:
// Chrome reports 0 for every flex child, and joining a whole header row in page order would
// read any short words in it as one.
export function glyphStrings(records) {
  const strings = new Set();
  const joined = (list, key) => normalizeText(list.slice().sort((a, b) => a[key] - b[key]).map((r) => r.text).join(''));
  const reorders = (list) => list.length >= 2 && new Set(list.map((r) => r.order)).size >= 2;
  const rows = [];
  for (const record of records.filter((r) => Number.isFinite(r.left) && Number.isFinite(r.top))) {
    let row = rows.find((candidate) => Math.abs(candidate.top - record.top) <= 3);
    if (!row) rows.push(row = { top: record.top, records: [] });
    row.records.push(record);
  }
  for (const row of rows) {
    strings.add(joined(row.records, 'left'));
    const ordered = row.records.filter((r) => r.order !== null);
    if (reorders(ordered)) strings.add(joined(ordered, 'order'));
  }
  const ordered = records.filter((r) => r.order !== null);
  if (reorders(ordered)) strings.add(joined(ordered, 'order'));
  return [...strings].filter(Boolean);
}

function isScrambled(element) {
  const style = styleOf(element);
  if (element.children.length < 2 || element.children.length > 96) return false;
  return style.display === 'flex' || style.display === 'inline-flex'
    || [...element.children].some((child) => /(?:^|;)\s*order\s*:/i.test(child.getAttribute('style') ?? ''));
}

function decodeGlyphs(container, layout) {
  const accept = (leaf) => !leaf.closest(NOT_A_LABEL);
  return glyphStrings(glyphRecords(container, { layout, accept })).map(adLabel).find(Boolean) ?? null;
}

function readsAsLabel(element) {
  const values = [element.getAttribute('aria-label'), element.getAttribute('title'), element.innerText, element.textContent];
  return values.map(adLabel).find(Boolean) ?? null;
}

// facebook.com/ads/about, straight or through l.facebook.com/l.php?u=.
export function isAdsAboutLink(href, depth = 0) {
  let url;
  try {
    url = new URL(String(href ?? '').replace(/&amp;/g, '&'), 'https://www.facebook.com/');
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'facebook.com' && !host.endsWith('.facebook.com')) return false;
  if (/^\/ads\/about\/?$/.test(url.pathname)) return true;
  return url.pathname === '/l.php' && depth < 2 && isAdsAboutLink(url.searchParams.get('u'), depth + 1);
}

const GROUP_PAGES = new Set(['category', 'create', 'discover', 'feed', 'for_you', 'joins', 'notifications', 'search']);
function isGroupLink(href) {
  try {
    const match = new URL(href, 'https://www.facebook.com/').pathname.match(/^\/groups\/([^/?#]+)/i);
    return Boolean(match && !GROUP_PAGES.has(match[1].toLowerCase()));
  } catch {
    return false;
  }
}

// Reads one post. Returns { signal, label, corroborated } for an ad, or { adButton } when
// all it found was an ad button nothing else backs up, or null.
export function readAdSignals(post, { labelCache } = {}) {
  const doc = post.ownerDocument;
  const layout = hasBox(post.getBoundingClientRect());
  const inHeader = headerTest(post);
  const visible = (element) => !isHidden(element, post) && (!layout || hasBox(element.getBoundingClientRect()));
  const cta = [...post.querySelectorAll(CTA)].find((element) => ownerOf(element) === post) ?? null;
  const groupOrigin = [...post.querySelectorAll('a[href]')].some((a) => inHeader(a) && isGroupLink(a.getAttribute('href')));
  const corroborated = Boolean(cta) && !groupOrigin;
  const found = (signal, label) => ({ signal, label: AD_LABELS.get(label), corroborated });
  // Text inside a header block only counts where it sits in the header itself: not in a
  // title, the author's name, or the post text the block also wraps.
  const headerText = (holder) => inHeader(holder) && !within(holder, post, NOT_A_LABEL);

  for (const element of [...post.querySelectorAll('span, div')].slice(0, 260)) {
    if (!inHeader(element) || within(element, post, NOT_A_LABEL) || !visible(element)) continue;
    // A long block can't be a label, and reading its visible text costs a walk.
    if (element.textContent.length > MAX_SOURCE) continue;
    const values = [ownText(element), element.children.length ? visibleText(element, headerText) : element.textContent];
    for (const value of values) {
      const text = normalizeText(value);
      if (text && text.length <= MAX_LABEL && adLabel(text)) return found('header label', adLabel(text));
    }
  }

  for (const element of post.querySelectorAll('[aria-labelledby]')) {
    if (!inHeader(element)) continue;
    for (const id of normalizeText(element.getAttribute('aria-labelledby')).split(' ')) {
      const target = id && doc.getElementById(id);
      if (namesSomeone(target)) continue;
      const label = target
        ? readsAsLabel(target) ?? (isScrambled(target) ? decodeGlyphs(target, layout) : null)
        : adLabel(labelCache?.get(id));
      if (label) return found('labelledby', label);
    }
  }

  for (const svg of post.querySelectorAll('svg')) {
    if (!inHeader(svg)) continue;
    const values = [...svg.querySelectorAll('text')].map((text) => text.textContent);
    for (const use of svg.querySelectorAll('use')) {
      const ref = use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '';
      if (!ref.startsWith('#')) continue;
      const target = doc.getElementById(ref.slice(1));
      if (target) {
        for (const source of [target, target.nextElementSibling]) if (source && !namesSomeone(source)) values.push(source.textContent);
      }
      else values.push(labelCache?.get(ref.slice(1)));
    }
    const label = values.map(adLabel).find(Boolean);
    if (label) return found('svg', label);
  }

  for (const element of [...post.querySelectorAll('span, div')].slice(0, 260)) {
    if (!inHeader(element) || within(element, post, NOT_A_LABEL) || !isScrambled(element) || isHidden(element, post)) continue;
    const label = decodeGlyphs(element, layout);
    if (label) return found('glyph order', label);
  }

  for (const a of post.querySelectorAll('a[href]')) {
    if (inHeader(a) && isAdsAboutLink(a.getAttribute('href'))) return { signal: 'ads link', label: 'Ad', corroborated };
  }

  return corroborated ? { adButton: true } : null;
}

// Watches posts and hides the ones that read as ads. Each post is read when it appears and
// a few times after, because Facebook fills in the header after the post itself.
export function watchSponsoredPosts({ posts, hider, enabled, labelCache, onAd, onAdButton, schedule = setTimeout, cancel = clearTimeout }) {
  const RETRIES = [300, 1200, 3000];
  const timers = new Map();
  const settled = new WeakSet();

  function forget(element) {
    for (const timer of timers.get(element) ?? []) cancel(timer);
    timers.delete(element);
    settled.delete(element);
  }

  function check(element) {
    if (!enabled() || settled.has(element) || !element.isConnected) return;
    const result = readAdSignals(element, { labelCache });
    if (result?.signal) {
      settled.add(element);
      for (const timer of timers.get(element) ?? []) cancel(timer);
      timers.delete(element);
      if (hider.hide(element, 'Sponsored')) onAd?.(result, element);
      return;
    }
    if (result?.adButton && !timers.get(element)?.length) onAdButton?.(element);
  }

  // The retries are set before the first look, so an ad button with no label yet is only
  // reported after the last one.
  function track({ element }) {
    forget(element);
    timers.set(element, RETRIES.map((delay) => schedule(() => {
      timers.get(element)?.shift();
      check(element);
    }, delay)));
    check(element);
  }

  const stops = [
    posts.on('post/add', track),
    posts.on('post/update', ({ element }) => check(element)),
    posts.on('post/remove', ({ element }) => forget(element)),
  ];

  return {
    check,
    // A fresh look at every post, after the switch comes back on.
    recheckAll() {
      for (const post of posts.current()) track(post);
    },
    stop() {
      for (const stop of stops) stop();
      for (const element of [...timers.keys()]) forget(element);
    },
  };
}
