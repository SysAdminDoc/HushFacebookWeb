// Block promotional notifications, as Hushfacebook does on Android, and any other kind you pick.
// Each notification links to what it's about with its kind in the address, notif_t=<kind>, the
// same name as the notif_type in Facebook's notifications data (live 2026-10-11, captures
// 2026-10-11-run8: friend, feedback_reaction_generic, group_r2j_approved, pymk_email,
// close_friend_activity, public_figures_to_follow). The script marks each notification's row
// with the group its kind belongs to, and CSS hides the groups you pick, in the Notifications
// list under the bell and on the Notifications page alike. It never reads the words, so any
// language works, and it works in content mode.
//
// The test account had no birthday or memory notifications, so those two groups go by the words
// Facebook's kind names use for them (birthday, and memories or On This Day).

const LINKS = 'a[href*="notif_t="]';
export const KIND_MARK = 'data-hfw-notif-kind';
// Each notification is a list item, on the page and under the bell alike (live 2026-10-11).
const ROW = '[role="listitem"]';
// A notification link pasted into a post or a comment is left alone, wherever it shows.
const POST = '[role="article"], [aria-posinset], [role="feed"]';
const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
const DELAY = 150;
const MAX_SEEN = 40;

export const GROUPS = [
  { option: 'birthdays', label: 'Birthdays', test: /birthday/, default: true },
  { option: 'memories', label: 'Memories', test: /memor|onthisday|on_this_day|goodwill|throwback|friendversary/, default: true },
  { option: 'suggestions', label: 'People you may know', test: /pymk|people_you_may_know|friend_suggest/, default: true },
  { option: 'follow', label: 'Pages and creators to follow', test: /to_follow|follow_suggest|page_suggest|creator_suggest/, default: true },
  { option: 'activity', label: "Friends' new posts and photos", test: /friend_activity|close_friend/, default: false },
  { option: 'groups', label: 'Group join approvals', test: /^group_r2j/, default: false },
  { option: 'reactions', label: 'Reactions to your posts and comments', test: /^feedback_reaction/, default: false },
];
const CUSTOM = 'custom';

// The notification kind in a link, or null.
export function notifType(href) {
  try {
    const type = new URL(href, 'https://www.facebook.com').searchParams.get('notif_t');
    return type && /^[a-z0-9_]{1,80}$/.test(type) ? type : null;
  } catch {
    return null;
  }
}

// Kind names listed by hand, one per line, as Diagnostics shows them.
export function parseKinds(text) {
  return new Set(String(text ?? '').split(/[\s,]+/).map((line) => line.trim().toLowerCase()).filter((line) => /^[a-z0-9_]+$/.test(line)));
}

// The group a kind belongs to: one of GROUPS, 'custom' when it's listed by hand, else 'other'.
export function groupOf(type, custom = new Set()) {
  if (custom.has(type)) return CUSTOM;
  return GROUPS.find((group) => group.test.test(type))?.option ?? 'other';
}

const notifKey = (link) => {
  try {
    const url = new URL(link.getAttribute('href'), 'https://www.facebook.com');
    return url.searchParams.get('notif_id') ?? url.href;
  } catch {
    return link.getAttribute('href');
  }
};

const notifCount = (node) => new Set([...node.querySelectorAll(LINKS)].map(notifKey)).size;

// A notification's row: the list item around its link, as long as it holds no other
// notification and no heading (the New, Today and Earlier titles), and isn't part of a post or
// a comment. Null when there's no such row.
export function rowOf(link) {
  const row = link.closest(ROW);
  if (!row || link.closest(POST) || row.querySelector(HEADING) || notifCount(row) > 1) return null;
  return row;
}

export function hideKindsCss(get) {
  const groups = GROUPS.filter(({ option }) => get(`hideNotificationKinds.${option}`)).map(({ option }) => option);
  if (parseKinds(get('hideNotificationKinds.custom')).size) groups.push(CUSTOM);
  if (!groups.length) return '';
  return `${groups.map((group) => `[${KIND_MARK}="${group}"]`).join(',\n')} { display: none !important; }`;
}

export function createKindMarker({ doc, enabled, custom, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
  const done = new WeakMap(); // link -> the address and list it was marked for
  const seen = new Set();
  let timer = null;
  let version = 0;

  function sync() {
    timer = null;
    if (!enabled()) {
      for (const row of doc.querySelectorAll(`[${KIND_MARK}]`)) row.removeAttribute(KIND_MARK);
      return;
    }
    const list = custom();
    for (const link of doc.querySelectorAll(LINKS)) {
      const href = link.getAttribute('href');
      const stamp = `${version}|${href}`;
      if (done.get(link) === stamp) continue;
      done.set(link, stamp);
      const type = notifType(href);
      if (!type) continue;
      const row = rowOf(link);
      if (!row) continue;
      if (seen.size < MAX_SEEN) seen.add(type);
      row.setAttribute(KIND_MARK, groupOf(type, list));
    }
  }

  const schedule = () => {
    timer ??= setTimer(sync, DELAY);
  };

  return {
    start() {
      const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
      new Observer(() => {
        if (enabled()) schedule();
      }).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
      sync();
    },
    // Settings changed: every row is looked at again, since a hand-listed kind may have changed.
    refresh() {
      version++;
      schedule();
    },
    sync,
    seen: () => [...seen],
  };
}

export default {
  id: 'hideNotificationKinds',
  section: 'notifications',
  android: 'Block promotional notifications',
  title: 'Hide kinds of notifications',
  description: 'Takes the kinds of notification you pick out of the Notifications list and page, like birthdays, memories and suggestions. The red count on the bell still counts them.',
  default: false,
  options: [
    ...GROUPS.map(({ option, label, default: on }) => ({ key: option, type: 'toggle', label: `Hide ${label.charAt(0).toLowerCase()}${label.slice(1)}`, default: on })),
    { key: 'custom', type: 'text', lines: 1, label: 'Other kinds to hide, by the names Diagnostics shows', default: '', maxLength: 2000 },
  ],
  css: hideKindsCss,

  setup({ doc, enabled, option, settings, diagnostics }) {
    const marker = createKindMarker({ doc, enabled, custom: () => parseKinds(option('custom')) });
    const begin = () => marker.start();
    if (doc.body) begin();
    else doc.addEventListener('DOMContentLoaded', begin, { once: true });
    settings?.subscribe(() => marker.refresh());
    diagnostics?.add('Notification kinds seen', () => marker.seen().join(', ') || 'None yet');
  },
};
