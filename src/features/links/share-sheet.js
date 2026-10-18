// Share sheet items, as Hushfacebook does on Android: the share targets you never use, gone from
// Facebook's share sheet. Live 2026-10-11 (run 54) the sheet is a role=dialog. Its body has a row
// of Messenger contacts (a role=list with an aria-label, between Previous and Next buttons) and a
// row of targets (a role=list without one): Messenger, WhatsApp, Copy link, Group, Friend's
// profile and X, with Your story on some loads. WhatsApp and X are l.facebook.com links to wa.me
// and twitter.com, which tells them apart in any language. The others go by their English words
// for now, and their sprite icon can't help since its position moves between Facebook builds.
// Copy link always stays. Works in content mode.

import { whenBodyReady } from '../../core/env.js';

export const MARK = 'data-hfw-share';
const DELAY = 150;

// default: hidden once the switch is on. Your story shares the post to your story in one click,
// with nothing to confirm (live 2026-10-11), so it goes by default.
export const TARGETS = [
  { option: 'contacts', label: 'the row of Messenger contacts', default: false },
  { option: 'messenger', label: 'Messenger', words: ['Messenger', 'Send in Messenger'], default: false },
  { option: 'whatsapp', label: 'WhatsApp', hosts: ['wa.me', 'whatsapp.com'], words: ['WhatsApp', 'Send in WhatsApp'], default: true },
  { option: 'story', label: 'Your story', words: ['Your story', 'Share to your story'], default: true },
  { option: 'group', label: 'Group', words: ['Group', 'Share to a group'], default: false },
  { option: 'friend', label: "Friend's profile", words: ["Friend's profile", "Share to a friend's profile"], default: false },
  { option: 'x', label: 'X', hosts: ['twitter.com', 'x.com'], words: ['X'], default: true },
];

const hostMatches = (host, wanted) => host === wanted || host.endsWith(`.${wanted}`);
const clean = (text) => (text ?? '').replace(/’/g, "'").replace(/\s+/g, ' ').trim();

// Where a link really goes: the u= target of Facebook's l.php redirect, or the link itself.
export function linkHost(href, base = 'https://www.facebook.com/') {
  try {
    const url = new URL(href, base);
    const inner = /(^|\.)facebook\.com$/.test(url.hostname) && url.pathname === '/l.php' ? url.searchParams.get('u') : null;
    return new URL(inner ?? url.href).hostname;
  } catch {
    return '';
  }
}

// The target a list item in the sheet stands for, or null.
export function targetOf(item) {
  const link = item.querySelector('a[href]');
  const host = link ? linkHost(link.getAttribute('href')) : '';
  if (host) {
    const byHost = TARGETS.find((target) => target.hosts?.some((wanted) => hostMatches(host, wanted)));
    if (byHost) return byHost.option;
  }
  const control = item.querySelector('[role="button"], a, [role="link"]') ?? item;
  const words = [clean(control.getAttribute('aria-label')), clean(item.textContent)];
  return TARGETS.find((target) => target.words?.some((word) => words.includes(word)))?.option ?? null;
}

// The part of the sheet's body that holds element and nothing of the targets row.
function sectionOf(element, targets) {
  let node = element;
  while (node.parentElement && !node.parentElement.contains(targets)) node = node.parentElement;
  return node;
}

const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
const CONTENT = '[role="list"], [role="textbox"], [contenteditable="true"]';
const isHeading = (node) => node.matches(HEADING) || !!node.querySelector(HEADING);

const CONTROL = '[role="button"], [role="link"], a[href]';

// What goes with the contacts row when it's hidden. Live (run 57) the row's "Send in Messenger"
// heading is the box just before it, with no list, text box or control in it, and the box before
// that holds nothing but Facebook's Report Bug button, drawn beside the heading.
function headingOf(section) {
  const heading = section.previousElementSibling;
  if (!heading || !isHeading(heading) || heading.querySelector(CONTENT) || heading.querySelector(CONTROL)) return [];
  const before = heading.previousElementSibling;
  const oneButton = before && !clean(before.textContent) && before.querySelectorAll(CONTROL).length === 1 && !before.querySelector(CONTENT);
  return oneButton ? [heading, before] : [heading];
}

// A share target is a short item with one place to click, never a post or a comment, and a list
// is the sheet's row of targets only when it has at least two of them. Live (run 55) the row has
// six, each a word or two.
const MAX_TARGET_TEXT = 40;
const MIN_TARGETS = 2;
// A post dialog's comment lists can run to hundreds of items and the marker runs on every burst of
// changes, so a list far longer than the row of targets is skipped before any text is read.
const MAX_ITEMS = 16;
const isShortItem = (item) => !item.querySelector('[role="article"]') && clean(item.textContent).length <= MAX_TARGET_TEXT;

function targetsIn(list) {
  const items = list.querySelectorAll('[role="listitem"]');
  if (items.length > MAX_ITEMS) return [];
  return [...items].filter(isShortItem).map((item) => [item, targetOf(item)]).filter(([, target]) => target);
}

// The row of Messenger contacts: a labeled list of buttons, above the targets and apart from them.
function contactsOf(dialog, targets) {
  return [...dialog.querySelectorAll('[role="list"][aria-label]')].find((list) =>
    !list.contains(targets) && !targets.contains(list) && !list.querySelector('[role="article"]') && list.querySelector('[role="listitem"] [role="button"]')
    && Boolean(list.compareDocumentPosition(targets) & 4)) ?? null;
}

// Marks every target in every open share sheet. Returns how many marks it added.
export function markShareSheets(doc) {
  let marked = 0;
  for (const dialog of doc.querySelectorAll('[role="dialog"]')) {
    for (const list of dialog.querySelectorAll('[role="list"]:not([aria-label])')) {
      const found = targetsIn(list);
      if (found.length < MIN_TARGETS) continue;
      for (const [item, target] of found) {
        if (item.getAttribute(MARK) === target) continue;
        item.setAttribute(MARK, target);
        marked++;
      }
      const contacts = contactsOf(dialog, list);
      if (!contacts) continue;
      const section = sectionOf(contacts, list);
      for (const part of [section, ...headingOf(section)]) {
        if (part.getAttribute(MARK) === 'contacts') continue;
        part.setAttribute(MARK, 'contacts');
        marked++;
      }
    }
  }
  return marked;
}

export function shareSheetCss(get) {
  const hidden = TARGETS.filter(({ option }) => get(`shareSheet.${option}`)).map(({ option }) => `[role="dialog"] [${MARK}="${option}"]`);
  return hidden.length ? `${hidden.join(',\n')} { display: none !important; }` : '';
}

export function createShareSheetMarker({ doc, enabled, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
  let timer = null;
  let marked = 0;
  const sync = () => {
    timer = null;
    if (enabled()) marked += markShareSheets(doc);
  };
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
    marked: () => marked,
  };
}

export default {
  id: 'shareSheet',
  section: 'links',
  android: 'Share sheet items',
  title: 'Trim the share menu',
  description: "Takes the share targets you pick out of Facebook's share menu. Copy link always stays. WhatsApp and X are found in any language, the rest by their English names for now.",
  default: false,
  options: TARGETS.map(({ option, label, default: on }) => ({ key: option, type: 'toggle', label: `Hide ${label}`, default: on })),
  css: shareSheetCss,

  setup({ doc, settings, diagnostics, enabled }) {
    const marker = createShareSheetMarker({ doc, enabled });
    const begin = () => marker.start();
    whenBodyReady(begin, doc);
    settings?.subscribe(() => marker.schedule());
    diagnostics?.add('Share menu targets found', () => String(marker.marked()));
  },
};
